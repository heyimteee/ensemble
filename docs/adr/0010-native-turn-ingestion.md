# ADR 0010: Native turn ingestion is service-owned and identity-based

- **Status:** Accepted
- **Date:** 2026-11-10
- **Tickets:** spec #209, ticket #211 in `heyimteee/ensemble`
- **Supersedes:** none
- **Related:** [ADR 0002](0002-durable-patch-feed.md), [ADR 0003](0003-single-service-and-safe-recovery.md), [ADR 0005](0005-work-status-and-delivery-lease-separation.md), [ADR 0008](0008-task-level-history-and-rollup.md), [ADR 0009](0009-conversation-identity-and-sessions.md), [native host contract](../verification/2026-11-10-native-host-contract.md)

## Context

The current v2 path treats the native session as execution detail for group chat
and as a transcript the TUI reads for direct chat. The TUI polls `chat.context`,
the final answer is correlated to a prompt by message creation time, and the live
overlay is cleared on an idle signal before the durable row is written. That
produces delayed text, flicker, duplicate rows, cards that disappear, and retry
or idle events read as interruption. Work is attributed by timing rather than
by identity.

Native-first makes native user messages and final assistant messages normal
Ensemble messages, and makes every native turn durable Work. That requires one
ingestion owner, exact host identities, and one settlement path.

The [native host contract](../verification/2026-11-10-native-host-contract.md)
recorded the event order and identities on an isolated OpenCode 2.2.6 host:

- `session.execution.started` precedes `session.inbox.delivered`.
- `inboxID` is the user message id; there is no separate inbox row.
- `session.text.started` and `session.text.ended` share the assistant message
  id, and a retry reuses that id.
- `session.text.ended` carries the authoritative text for its part.
- `session.retry.scheduled` is a retry, not a terminal interruption.
- `session.execution.succeeded|failed|interrupted` settle a turn.
- `session.idle`, `session.status`, and `session.synthetic` were not delivered.
- A background subagent completion injects a synthetic inbox item into the
  parent and starts a second parent execution.
- A move while busy is accepted and queued by the host.

## Decision

### 1. The service owns ingestion

One Ensemble service per host realm (ADR 0003) is the only ingestion writer. The
location adapter subscribes to the verified host event families; a per-session
serial queue processes one session's events in order, different sessions process
in parallel, and the store serializes durable writes.

The TUI never polls the native transcript, never writes native deltas or turn
rows into the store, and never creates a durable native message or turn. It
receives durable messages plus coalesced ephemeral stream events. There is no
second ingestor, pump, or writer.

The reverse session-to-binding index from ADR 0009 attributes each event to its
conversation and agent. An event for an unbound session is ignored, not guessed
into a conversation.

### 2. Identity comes from IDs, never timestamps

- The user message id is the inbox id. The turn id derives from the first inbox
  id, so replaying the same inbox event resolves to the same turn.
- The assistant message id is the `assistantMessageID` on the text events. A
  retry keeps the same assistant message id and the same turn.
- The final text is the join of the authoritative `session.text.ended` parts.
  Deltas and accumulated text are never authoritative.
- Context message ids are allocation-ordered, not chronological. `time.created`
  orders the transcript; it never identifies a turn, recipient, or result.
- Deduplicate first by host event id, then by deterministic durable ids for the
  message and turn. A duplicate or reordered event is harmless.
- Service-originated prompts carry internal metadata and are skipped as user
  messages; they attach to the existing managed turn. A host synthetic subagent
  completion is different: it starts a new parent turn (section 6).

### 3. Start, delivery, and settlement events

- `session.inbox.enqueued` opens the turn in `queued` and records the user
  message and attachment metadata.
- `session.execution.started` moves it to `working` and opens the streaming
  assistant row. Delivery is not the start gate: it arrives later.
- `session.inbox.delivered` and `session.inbox.delivery.changed` update delivery
  state only.
- `session.inbox.cancelled` settles the turn as cancelled when no execution
  started; it never fabricates an assistant answer.
- `session.retry.scheduled` moves the turn to `retrying` without ending it.
- `session.execution.succeeded|failed|interrupted` is the terminal evidence for
  the turn. `session.idle` is not a settlement signal; `session.status` is not a
  retry or busy signal; the `session.synthetic` event is not an ingestion
  dependency. If a future host delivers those events, they may be opportunistic
  hints only, never the sole basis for settlement or interruption.

The context `type="idle"` transcript marker and the terminal execution events
are the reconciliation evidence when an event is missed.

### 4. Durable row first, overlay second

At execution start the service opens the durable assistant message row with
`streaming: true`. Deltas accumulate in memory per assistant message and text
part; a coalesced stream event publishes the accumulated text at a bounded
interval. At settlement the service joins the ended parts and writes one exact
final message.

The durable row is written before the live overlay is cleared. A client ignores
a stream update once the row is no longer streaming, so a late ephemeral event
cannot resurrect an old overlay. There is no direct-chat-only overlay and no
`chat.context` poll; group and direct use the same message and stream path.

A native turn publishes patches and stream events, never a full snapshot.

### 5. Retry, interruption, and failure are distinct

- **Retry.** A scheduled host retry keeps the same row, card, and turn in
  `retrying`. It is not an interruption and does not append a failure notice.
- **Interruption.** Only `session.execution.interrupted` settles an interrupted
  execution. A `reason: "user"` settles `cancelled`: the user chose to stop it.
  Shutdown, inactivity, superseded, or unknown reasons preserve the partial text
  and settle `needs_you`, so the user can recover context. A user interrupt
  while idle emits no event and must not be invented.
- **Failure.** `session.execution.failed` records the structured host error and
  derives `failed`; per ADR 0005, `failed` means a native error, not a delivery
  or lease problem.
- **Empty or tool-only success.** A successful turn with no text follows
  ADR 0005's `empty-reply` rule; it is not an interruption.
- A later success supersedes transient retry and failure notices for the same
  turn; the answer is never stacked under a false `Retrying` line.

### 6. A background subagent can create a second parent turn

The parent's first execution may succeed while a background child still runs.
When the child finishes, the host injects a synthetic inbox item into the parent
with metadata identifying the subagent and child, and the parent runs another
execution. That execution is a **new parent turn** with its own inbox id, turn
id, and Work card. It is not the first turn's result and it is not correlated to
the child by timestamp.

A parent turn whose successful execution arrives while a known background child
is still working stays `working` on the same card until every child mapped to
that turn is terminal, or until ADR 0008's existing bounded barrier expires.
The hold delays settlement only; it does not change identity, create a second
row, or absorb the synthetic turn. If the parent execution settled before the
child was known, no retroactive hold is invented.

Child sessions remain read-only native subagent cards under the parent dispatch
group per ADR 0008; they are not Subtask queue rows and consume no hop. ADR
0008's bounded hold for queued agent runs remains separate from this native-turn
rule.

### 7. Reconciliation is the backstop, not the path

- Reconcile each bound session once on service start, reconnect, and adoption,
  with a generation guard for stale asynchronous work.
- Read `session.context` only for reconciliation or fallback; never per delta,
  per stream tick, or per heartbeat.
- Recover a terminal turn's result from the context when the final event was
  missed. Mark a `working` turn interrupted only after reconciliation confirms
  there is no answer.
- Treat a service restart as a recovery input: an active native turn must end
  with its real answer or an explicit interruption, never a stuck card.
- A bounded watchdog performs a reconciliation pass for an active turn with no
  terminal event. It is not a transcript poll and does not publish snapshots.
- Expose native sync state as live, reconciling, or degraded.

### 8. One durable Work model and history

- A native turn is a Subtask with `origin: "native"`, `adopted: true`, and
  `workKind: "turn"`. It has no lease, claim, or attempts; the queue pump skips
  adopted work.
- Its dispatch group is a normal root group for the conversation. Routed
  mentions create normal child Subtasks in the same group.
- `deriveWorkStatus` gets an explicit native branch. There is no separate
  `NATIVE` work kind, card type, or lifecycle; the status vocabulary is the one
  in ADR 0005.
- The card derives from the durable turn and its transcript anchor. Activity
  events add a verb to a live card; they never create or delete one.
- ACTIVE shows non-terminal turns. HISTORY shows terminal turns from the
  conversation's Work history page, independent of any client's earlier state.
  The short presentation hold never deletes or hides durable Work.
- A "Why this card?" detail reports origin, session, inbox, event timeline,
  routes, and budget by id.

### 9. Observability and trust

Log native turn, route, duplicate, gap, and settle events with ids, counts,
durations, and reason codes only. Never log message text, file content, or
paths. Doctor invariants cover one active turn per session, session uniqueness,
result presence, inbox and message uniqueness, route provenance, and stuck
turns.

## Rejected alternatives

- **TUI-owned ingestion or transcript polling.** Rejected: two writers,
  duplicated rows, load proportional to transcript size, and latency tied to a
  heartbeat. It also lets a client state decide what Work exists.
- **Timestamp correlation.** Rejected: ids are not chronological, retries reuse
  a prompt, queued prompts start together, and background turns arrive later.
- **Build on `session.idle`, `session.status`, or `session.synthetic`.** Rejected:
  the measured host did not deliver them. A settlement path that depends on them
  leaves cards stuck or falsely interrupted.
- **Clear the overlay before the durable write.** Rejected: that is the observed
  flicker and lost-row path.
- **Treat a retry as interruption.** Rejected: it shows a false failure for work
  the host is still running.
- **End the turn at the parent's first success while a known child still runs.**
  Rejected: it hides live child work and races the synthetic completion. The
  bounded child hold in section 6 is used instead.
- **A separate native Work kind or card lifecycle.** Rejected: it teaches a
  second vocabulary and splits the Work pane, contradicting ADR 0005 and
  ADR 0008.
- **Read context per delta to recover identity.** Rejected: it is polling, it
  scales with transcript size, and it still cannot distinguish a retry from a
  new turn.

## Consequences

### Accepted trade-offs

- **The service is on the critical path.** If the event subscription drops,
  reconciliation repairs, but ingestion latency and completeness depend on the
  service being live.
- **A durable final can land before a queued ephemeral event.** The client treats
  the durable row as final and drops the stale stream update, so the text does
  not regress or duplicate.
- **A background subagent produces an extra parent card.** That matches the host
  execution rather than hiding it.
- **Reconciliation is bounded but not free.** It reads context only at start,
  reconnect, adoption, or a stuck-turn watchdog.
- **Host upgrades require re-probing.** The event set is verified for OpenCode
  2.2.6; a changed host contract can change settlement behavior.
- **One service and the dispatch ledger are unchanged.** ADR 0003 and ADR 0004
  remain in force.

### Follow-up rules

- Do not poll the native transcript from the TUI or on a heartbeat.
- Do not derive a turn, recipient, or result from a timestamp.
- Do not settle on idle, status, or a synthetic event.
- Do not clear a live overlay before the durable row exists.
- Do not hold a native parent turn open past the bounded child barrier, and do
  not absorb the synthetic completion into the held turn.
- Do not create a second native Work kind, card, or history store.
- Keep logs free of conversation content, file bytes, and paths.

## Validation

- The committed fixture and contract test from #210 replay the measured order,
  identities, retry, interruption, background subagent, and move cases.
- Tickets #215, #216, #217, #218, and #222 cover direct ingestion, workspace
  ingestion, retry/interruption, reconciliation, and Work history at the service
  and TUI seams.
- `npm run verify` passes for this documentation ticket. No product behavior
  changed.

## References

- Parent specification #209 and ticket #211 in `heyimteee/ensemble`
- [Native host event contract](../verification/2026-11-10-native-host-contract.md)
- [ADR 0005: Work status taxonomy and delivery/lease separation](0005-work-status-and-delivery-lease-separation.md)
- [ADR 0009: Conversation identity and sessions](0009-conversation-identity-and-sessions.md)
- [Glossary](../../GLOSSARY.md)
