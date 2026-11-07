# ADR 0002: Server-authoritative durable patch feed

- **Status:** Accepted
- **Date:** 2026-11-07
- **Tickets:** #130 (spec), #138, #139, #140, #141, #143
- **Supersedes:** none

## Context

Ensemble's TUI used a 250 ms full-snapshot poll. Each snapshot replaced the
whole client state, and the service built it from roughly seven full-state
copies before transport. Measured costs were 257–497 ms per snapshot at 10k
messages before transport, so the render path could starve during a burst and
then snap to the latest state. Handoffs and delegations appeared late because
the card waited for the next poll, and a transcript chunk arrived only when a
snapshot replaced the view.

The OpenCode event stream is volatile by contract. A slow consumer can
overflow it, and events emitted during a disconnection are lost. A durable
correction path is therefore mandatory: incremental delivery cannot be the
only way the client learns the truth.

v7 also introduces dispatch groups, a Work projection, scoped bootstrap, and
streaming checkpoints. Those features need one consistent answer to three
questions: which store is authoritative, when a change becomes publishable,
and how a client repairs itself after an arbitrary delivery failure.

## Decision

1. **The server store is the sole source of truth.** The client store is a
   disposable cache. Every durable read path can rebuild the client view from
   durable storage or an explicit full snapshot; no projection, patch, or
   window is a second authority.
2. **Durability precedes publication.** All store mutations pass through one
   serialized write queue. A mutation persists its entity data and the meta
   version, then appends the change to the ring, then schedules publication.
   A consumer that receives a patch can assume the entity it describes is
   already durable.
3. **One epoch and one monotonic version.** The service has a boot epoch and a
   monotonically increasing version. Each logical change consumes exactly one
   version; a batch with commit version `V` contains contiguous entries up to
   `V`. A restarted service changes the epoch.
4. **Patches are full-entity and idempotent.** Durable changes are upserts of
   a complete entity or explicit removes with an id. Duplicate delivery
   re-applies the same value. Reordered or stale deliveries are ignored by the
   client cursor. A remove records a short, bounded client tombstone so a
   delayed duplicate cannot resurrect a deleted entity.
5. **The change ring is bounded and in memory.** `changes.since(epoch,
   version)` replays contiguous batches from the ring. An evicted cursor, an
   unknown epoch, or a cursor ahead of the server returns a reset. The ring is
   deliberately not durable: the entity store plus resync/snapshot is the
   durability guarantee, not the transport history.
6. **Recovery is graded.** A revision heartbeat runs about every 2 s while
   idle and 1 s while work is live, and immediately on reconnect. A version
   gap asks for `changes.since`; a reset triggers a scoped resync for the
   affected scopes, or a full snapshot when the epoch changed or the scoped
   read cannot repair the view. A malformed or unknown batch drops the batch
   and resyncs the narrowest scope it can identify; ambiguous input falls back
   to the full snapshot.
7. **Entity changes are not metadata changes.** Catalog, model, and config
   metadata travel as version-neutral feed metadata keyed by catalog/config
   revision. They update the client without replacing entity state. Ephemeral
   stream text is also version-neutral. Streaming checkpoints persist live
   text without a coordination version, change-ring entry, or patch;
   finalization persists once and publishes the exact final message upsert.
8. **Compatibility is negotiated, not assumed.** Protocol 3 and later clients
   consume entity patches. Older clients continue to receive the legacy
   changed event and the full snapshot path. A protocol/epoch mismatch never
   applies an ambiguous feed batch.
9. **Tier 3 reads are gated projections.** Scoped bootstrap, the Work
   projection, transcript windows, and server-derived counts engage only when
   measured history, measured snapshot payload, or measured snapshot latency
   justifies them. They are derived from durable storage, are disposable, and
   fall back to the full snapshot. A disabled gate keeps the existing snapshot
   path as the steady-state read.
10. **The read path is pure and the client is bounded.** Snapshot, bootstrap,
    projection, and window handlers perform no discovery, reconciliation,
    settling, or purging writes. Maintenance runs on a serialized timer and
    before pump work. The client keeps a bounded message window and visible
    Work set; a full snapshot is applied whole as the legacy recovery path.
11. **Metrics contain no conversation content.** Clone, patch, bootstrap,
    latency, and recovery diagnostics report counts, sizes, versions, and
    timings only.

## Invariants

- No patch is published before its entity and meta version are durable.
- Versions within one epoch are contiguous and monotonic; one logical change
  has one version.
- Applying the same patch batch twice produces the same client state.
- A remove cannot be undone by a duplicate or older upsert.
- A gap, epoch change, malformed batch, or evicted cursor always ends in a
  resync or snapshot, never in silent stale state.
- A full snapshot reconstructed from durable storage is equivalent to the
  server's authoritative state at that version.
- Scoped reads and windows never become the source of truth.
- Streaming finalization is exact and replaces the live overlay once.
- The client's patched transcript and visible Work memory stay bounded.
- Read handlers do not write.
- Every RPC patch boundary is JSON-safe: absent optional entity fields are
  omitted, never serialized as explicit undefined (the host validator rejects
  such a payload).

## Consequences

### Accepted trade-offs

- **Full entities cost more bytes per patch.** Field-level patches would be
  smaller but make duplicate/reordered delivery and tombstone handling much
  harder to reason about. At the measured entity sizes, simplicity and
  idempotency win.
- **The ring is volatile.** A service restart forces every connected client to
  resync or snapshot. That cost is bounded by the gated scoped reads and is
  paid only on reconnect.
- **A single writer is assumed.** Foreign writes make the local ring
  non-descriptive, so the feed resets and hydrates from durable storage. Two
  processes actively pumping one store remains unsupported.
- **The Tier 3 gate is heuristic.** It can keep a borderline workspace on the
  snapshot path until a measurement crosses the threshold, or enable scoped
  reads early based on payload/latency rather than history count. The gate and
  its reason travel with the response so the decision is inspectable.
- **Metadata is version-neutral.** Catalog and config updates do not advance
  the entity cursor; clients must compare revisions and apply metadata
  independently. This avoids forcing an entity resync for a catalog refresh.
- **Checkpoints can lose the final partial window.** A crash loses at most the
  text after the last checkpoint, and the recovered row is marked interrupted.
  The final durable message is never lost once finalization persisted it.

### Follow-up rules

- Do not add a durable change log or replayable patch ring without re-opening
  the recovery design; durability is already provided by the entity store.
- New durable entities must publish full-entity upserts/removes and a
  client-store apply branch, plus duplicate/gap coverage at the feed seam.
- Do not move discovery, reconciliation, or maintenance back into a read path.
- Do not make a projection, window, or client cache authoritative to avoid a
  resync.
- Keep the legacy snapshot path working for older protocol clients.

## References

- [Implementation: Work lifecycle and recovery model](../implementation.md#v7-work-lifecycle-and-recovery-model)
- [v7 verification record](../verification/2026-11-07-v7.md)
- [Ticket #141 scoped-read record](../verification/2026-11-07-ticket-141.md)
- Specification #130 and tickets #138–#143 in `heyimteee/ensemble`
- [Store write queue and change ring](../../src/v2/store.ts),
  [refresh coordinator](../../src/v2/tui/refresh-coordinator.ts),
  [client store](../../src/v2/tui/client-store.ts),
  [scoped-read policy](../../src/v2/scoped-read.ts)
