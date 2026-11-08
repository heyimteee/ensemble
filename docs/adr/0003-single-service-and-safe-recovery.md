# ADR 0003: One Ensemble service per host realm, with lease-safe recovery

- **Status:** Accepted
- **Date:** 2026-11-08
- **Tickets:** parent spec and children in `heyimteee/ensemble`
- **Supersedes:** none
- **Related:** [OpenCode/OpenTUI runtime guide](../agents/opencode-tui-runtime.md), ADR 0002

## Context

Ensemble assumed `SharedEnsemble` kept one service per OpenCode process. In
practice, OpenCode re-evaluates the plugin module once per location. A
100-request, 4-channel, 8-agent mock produced **13 plugin loads** (project,
four channel directories, eight agent home directories), **13 service
starts**, and **zero stops**, all in one process.

The instances shared durable storage but not in-memory state. Every
`V2Store.load()` converted every `working` row to `pending`, cleared its
claim, and wrote `"Ensemble restarted while this subtask was working."` while
another instance was still running the task. Eight tasks reached
`MAX_ATTEMPTS=5` and failed. A real 30-request playground run showed the same
shape: four service instances, one complex request re-claimed at attempts 2
and 3, duplicate completion handoffs, repeated content, and placeholder
replies.

Two prototypes resolved the design:

1. **Realm probe:** all 13 plugin loads ran on `threadId 0`, and a
   `globalThis` counter incremented 1 through 13. The host reuses one JS realm
   and one thread; the module is re-evaluated, so module-scoped state resets
   but `globalThis` survives.
2. **Global registry:** storing the registry on a `Symbol.for(...)` in
   `globalThis` reduced 13 service starts to **1**. The same mock then
   produced **137/137 successful tasks, 0 failures, 0 `task.failed`**.
3. **Lease-safe load only:** removing the unconditional `working` recovery
   kept 13 service instances but also produced **137/137 successful tasks,
   0 failures**. This proves lease-safe recovery is sufficient defense when a
   second service exists.

## Decision

1. **One service per host realm.**
   - `server.ts` obtains the registry from a `globalThis` symbol.
   - The registry entry carries a stable `version`; the check must be
     structural (`typeof registry.acquire === "function"`), never
     `instanceof`, because the class identity changes across module reloads.
   - The registry is reference-counted per location; the service stops only
     when the last location releases it.
   - The first location's plugin context owns storage, sessions, and events for
     the realm. Ticket #153 moved location-scoped tools, retry hooks, and RPC
     registrations onto a per-location `LocationAttachment`; the bootstrap
     context is no longer the host authority for those surfaces.
   - If the registry version changes, a new registry may coexist with the old
     one until the old refs release. Recovery safety in decision 2 covers that
     window.

2. **Lease-safe recovery is mandatory defense.**
   - `V2Store.load()` never rewrites `working` rows. It may collect them for
     diagnostics.
   - `reapAndRetire()` is the only expiry path: a claim with
     `leaseUntil > now` is left alone; an expired claim with no live local run
     is re-queued with attempts preserved.
   - `reconcileWaitingWork()` remains the repair path for a `working` row with
     no claim and no local run.
   - `stop()` releases only claims owned by local `activeRuns`; clean shutdown
     recovers immediately, a crash waits up to the work lease (60 s).
   - `load()` does not clear streaming rows. Settle a row when its task is
     terminal, its lease is expired, or it has no task and is older than the
     lease.
   - Recovery emits a `failure.attempt` with `failureClass: "restart"`;
     retire emits `failure.terminal`.

3. **No filesystem single-writer election in this cycle.**
   - The realm probe proves one service per host realm is achievable, so an
     election adds complexity without addressing the observed failure.
   - Multi-process/multi-host pumping remains unsupported and is documented
     as such. If it becomes a requirement, election is a separate spec; the
     lease and claim invariants remain the safety floor.

4. **No deterministic work IDs in this cycle.**
   - With one service, `findWorkByKey()` plus claim fencing prevents duplicate
     creation and duplicate completion handoffs.
   - Deterministic IDs would add collision and migration surface without
     evidence of a second writer under the supported topology.
   - Revisit only when multi-process support is approved.

5. **Failure truth.**
   - A successful task clears `error`; it never retains a restart/transient
     reason.
   - `Reply completed.`, `Reply interrupted.`, and
     `Reply interrupted before completion.` are internal fallbacks, never
     successful answers. Treat them as empty: retry within budget, otherwise
     fail visibly.
   - Restart requeue and retire produce self-contained failure records with
     the previous claim, lease expiry, instance, and thread.

6. **Observability.**
   - With one service, one service log per host role is sufficient; per-instance
     files are not needed.
   - Add `role`, `instanceID`, and `threadID` to log rows for service/TUI
     attribution and future hot-reload diagnosis.
   - `feed.reset` names its reason; repeated identical resets are rate-limited
     with a suppressed count.
   - The TUI ignores foreign-epoch patches and coalesces one snapshot instead
     of entering a reset loop. This is defense for a version-change window and
     any future second service.

## Consequences

### Accepted trade-offs

- **Crash recovery can take up to 60 seconds.** This is the cost of never
  duplicating live work. Clean shutdown releases claims immediately.
- **The service depends on one JS realm.** This is observed and tested on
  OpenCode 2.2.6. Revalidate on host upgrades; if a release isolates plugin
  locations, the lease-safe path keeps work safe but duplicate pumping would
  return, and election would need to be reconsidered.
- **A plugin code update may coexist with the old service until refs release.**
  Bump the registry version when the service contract changes; a host restart
  clears it.
- **Multi-process/multi-host remains unsupported.** The local-first boundary
  stays explicit.
- **No deterministic IDs.** Duplicate suppression still depends on the single
  service and the durable queue key.

### Follow-up rules

- Do not add a filesystem election, daemon, or deterministic task IDs without
  evidence of a supported second writer.
- Do not recover a `working` row on load. Recovery belongs to lease expiry.
- Do not accept an internal fallback string as a task result.
- Keep the registry check structural and versioned; never `instanceof`.
- Re-run the multi-location mock on every OpenCode upgrade that changes plugin
  loading.

## Validation

| Experiment | Result |
|---|---|
| Realm probe, 13 locations | 13 loads, all `threadId 0`, `globalThis` counter 1→13 |
| Global registry prototype | **1 service start**, 137/137 tasks succeeded, 8→0 failures, 0 `task.failed` |
| Lease-safe load prototype only | 13 service starts, 137/137 tasks succeeded, 8→0 failures |
| Attempts after either prototype | all 137 tasks at attempt 1 |

Prototype worktrees were disposable and removed; no prototype code is in the
tree.

## References

- [Runtime guide](../agents/opencode-tui-runtime.md#locations-services-and-storage)
- [Implementation notes](../implementation.md)
- [Logging verification](../verification/2026-11-08-logging.md)
- `src/v2/shared-service.ts`, `src/v2/server.ts`, `src/v2/store.ts`,
  `src/v2/service.ts`, `src/v2/queue.ts`
- Parent specification and child tickets in `heyimteee/ensemble`
