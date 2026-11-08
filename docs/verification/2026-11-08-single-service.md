# Single service per host and safe recovery (#151)

Status: **verified locally on Linux/tmux; real post-fix 30-run recorded; gap-noise follow-up applied**
Date: 2026-11-08
Issue: [#151](https://github.com/heyimteee/ensemble/issues/151)
Spec: [#146](https://github.com/heyimteee/ensemble/issues/146)
ADR: [0003](../adr/0003-single-service-and-safe-recovery.md)
Base: `integration/single-service` at `48263a6` (includes #147, #148, #149, #150 and the #146 review fixes)
Review fixes: `fix/spec-146-review`
Gap-noise follow-up: `fix/feed-gap-noise`
Branch: `verify/single-service`
Worktree: `/home/tristan/dev/ensemble-151`

This record covers the delivery evidence for the single-service registry
(#147), lease-safe load/recovery (#148), restart failure truth (#149), and
log attribution (#150):

- One `service.start` for a host realm that loads the plugin at 13 locations.
- Mock 100: 100 clean requests, 137/137 successful task rows, 0
  `task.failed`, 0 failure records, 8 concurrent runs.
- Real post-fix 30-request run: 30/30 requests, 39/39 task rows succeeded,
  one service start, no placeholders, no duplicate handoffs.
- Lease-safe and restart truth tests pass.
- The pre-fix real 30-request baseline is retained for contrast.
- The real run exposed 180 recoverable `feed.gap` warnings; the follow-up
  makes recovered gaps debug summaries and keeps warnings only for real
  fallbacks.

## Environment

| Item | Value |
|---|---|
| OS | Linux 6.12.113+deb13-amd64 |
| Terminal host | tmux 3.5a |
| Node | v26.12.1 |
| npm | 12.2.1 |
| OpenCode | `opencode v2.2.6` |
| macOS/Herdr | Not available; not run |
| Hosted CI | Not run |

## Commands and results

| Command | Result |
|---|---|
| `npm run verify` | **Pass** — strict type check; **1020 tests passed, 0 failed, 0 skipped, 0 todo**, 28.0 s. |
| Mock 100 (`ENSEMBLE_ROOT=/home/tristan/dev/ensemble-gapfix bash /tmp/opencode/mock100-setup-verify.sh`) | **Pass** — driver exit 0; **100 jobs, 137/137 tasks succeeded, 0 failed, 0 `task.failed`, 1 `service.start`, `maxObservedRuns=8`**. |
| `npm run test:live:fake:all` | **Pass** — `fake` 194 s, `fake-empty` 9 s; **2 passed, 0 failed, 0 skipped, 0 not run** (203 s total). |
| Real playground 30-request replay (live host, hot reload only) | **Pass, with gap-noise follow-up** — **30/30 requests, 39/39 tasks, all attempt 1, 0 placeholders, 0 duplicate handoffs, 1 `service.start`, 0 `task.failed`, 0 failure records**; exposed **180 recoverable `feed.gap` warnings**, fixed in `fix/feed-gap-noise`. |
| Targeted restart/recovery tests (`--test-name-pattern="ticket14[89]"`) | **Pass** — **15 tests passed**, 0 failed, 0 skipped (0.33 s): 7 `ticket148`, 8 `ticket149`. |
| Targeted feed-gap tests (`src/v2/tui/feed-gaps.test.ts`) | **Pass** — **5 tests passed**, 0 failed, 0 skipped: recovered-gap debug, fallback warn, burst coalescing, repeated hard-gap warn, trailing window close. |
| `git diff --check` | **Pass** — exit 0, no whitespace errors. |
| Prototype tree check (`git ls-files \| grep -i prototype`) | **Pass** — no prototype files in the tree. |

## Mock 100 (isolated multi-location host)

The harness starts an isolated fake provider, isolated `HOME`/`XDG`/project
tree, and a fresh OpenCode server whose plugin points at this worktree. The
driver creates 4 channel workspaces (`mock-a`…`mock-d`), 8 agents, sets
`maxActiveRuns=8`, `maxDelegations=10`, `maxDepth=5`, and sends 100 requests
(34 easy, 33 medium, 33 hard). Fake-provider delays are 0 ms so the measured
path is Ensemble orchestration.

### Multi-location topology

`server.log` proves the host loaded the plugin once per location; the service
log proves one service handled all of them:

| Observation | Count |
|---|---|
| `loading plugin` (project + 4 channels + 8 agent homes) | **13** |
| `location services booted` | **13** |
| Server processes (`run=`) | **1** |
| `service.start` in the service log | **1** |
| `service.stop` | 0 |
| Distinct service `instanceID` / `threadID` | 1 / `0` |

### Task and log results

| Assertion | Result |
|---|---|
| Jobs sent | **100** |
| Jobs with a failed root task | **0** |
| Task rows (`turn` 69 + `delegation` 34 + `handoff` 34) | **137** |
| Task outcomes / states | **137 succeeded / 137 replied** |
| Attempts | **137 at attempt 1** (no retries) |
| Jobs with errors | **0** |
| `maxObservedRuns` | **8** |
| Settle time after the last send | 9.2 s |
| Service log rows | 926 (`925 info`, `1 error`) |
| `service.start` / `service.location` | **1** / 1 |
| `task.failed` | **0** |
| `failure.*` records | **0** |
| Failure sink (`service-failures-*.jsonl`) | **absent** |
| Rows with `role`, `instanceID`, `threadID` | **926/926** (all `role=service`, one instance, `threadID=0`) |

Event totals: `task.created` 137, `task.claimed` 137, `task.transition` 137,
`task.completed` 137, `message.appended` 374, plus the 4 service rows above.

### Latency (seconds, request to settled group)

| Bucket | n | min | median | mean | p95 | max |
|---|---|---|---|---|---|---|
| Easy | 34 | 2.02 | 2.84 | 3.74 | 6.10 | 6.57 |
| Medium | 33 | 2.83 | 3.45 | 4.05 | 5.70 | 5.78 |
| Hard | 33 | 3.44 | 4.13 | 4.52 | 5.60 | 5.74 |
| All | 100 | 2.02 | 3.76 | 4.10 | 6.03 | 6.57 |

### Artifacts

- Results: `/tmp/opencode/mock100-artifacts-1794118870/mock100-results.json`
- Harness output: `/tmp/opencode/146-gapfix-mock100.log`
- Service log and server/fake logs:
  `/tmp/opencode/mock100-artifacts-1794118870/`
- Prior review artifacts: `/tmp/opencode/mock100-artifacts-1794117806/`

## Prototype evidence for #148's 13-instance acceptance

#148's acceptance asks for a mock 100 with 13 service instances (registry fix
disabled or simulated) to be 100/100 with 0 `task.failed`. That run predates the
merged code and is recorded here as **prototype evidence**, not as a run of the
final tree:

| Observation | Result |
|---|---|
| Service instances / `service.start` rows | **13 / 13** |
| Plugin locations (project + 4 channels + 8 agents) | 13 |
| Task rows | **137/137 succeeded**, all at attempt 1 |
| Jobs | 100 sent, 0 job errors |
| `task.failed` / failure records | **0 / 0** |
| Failure sink (`service-failures-*.jsonl`) | absent |
| Service log rows | 1,351 (`role=service`); instance/thread attribution absent in this pre-#150 build |

The run shows lease-safe recovery is sufficient defense even when the registry
does not collapse the 13 loads into one service. It produced 8→0 task failures
compared with the pre-fix baseline.

Artifacts: `/tmp/opencode/mock100-artifacts-1794109203/`
(`mock100-results.json`, `logs/service-20261108-3784961.jsonl`). The merged tree
was separately verified with the registry active: one `service.start` and
137/137 tasks in the main mock above. No prototype source remains in the tree.

## Restart and recovery tests

`node --test --experimental-strip-types --test-name-pattern="ticket14[89]"
src/v2/service.test.ts` → **15 passed, 0 failed, 0 skipped**:

| Ticket | Test | Result |
|---|---|---|
| #148 | load leaves a live foreign lease working row untouched | pass |
| #148 | a live lease is never retired for attempts or a passed deadline | pass |
| #148 | an expired lease is requeued once and attempts rise only on the next claim | pass |
| #148 | a working row with no claim and no local run is repaired | pass |
| #148 | stop releases local claims and preserves foreign claims | pass |
| #148 | streaming rows survive load only while their lease is live | pass |
| #148 | a second service over shared storage never steals a live claim | pass |
| #149 | restart requeue writes a failure attempt with the previous claim and lease | pass |
| #149 | restart retirement writes a terminal failure record | pass |
| #149 | stream finalization reports settlement and result eligibility separately | pass |
| #149 | a recovered then successful task clears its restart error | pass |
| #149 | a fallback reply is retried as an empty answer | pass |
| #149 | an exhausted fallback reply fails visibly without a result | pass |
| #149 | the request-23 shape never succeeds on a stale fallback | pass |
| #149 | an empty terminal stream settles as interrupted, never a completed placeholder | pass |

These cover the crash path by simulation: an unexpired foreign claim is never
stolen, expiry requeues exactly once with attempts preserved, a clean stop
releases only local claims, and a recovered success clears the restart error.

## Review fixes (spec #146 code review)

| Finding | Fix | Evidence |
|---|---|---|
| Unsupported `ctx.directory` | `service.start` reads the declared `ctx.location.directory`, falling back to cwd | `ticket150: log rows identify the service instance, location, and thread` |
| Acquire/stop race | `acquire()` re-checks the entry after its await; a stopping entry is never joined | `an acquire already awaiting the entry never joins its teardown` |
| Live rows retired early | A live lease always wins over attempts/deadline; retire happens only after expiry | `ticket148: a live lease is never retired for attempts or a passed deadline` |
| Wrong retire labels | Deadline → `timeout`/`deadline-exceeded`; exhaustion → `internal`/`attempts-exhausted`; only recovery is `restart` | `ticket149: restart retirement writes a terminal failure record` |
| Requeue error leak | Requeue writes failure evidence only; legacy transient strings are dropped on retire | `ticket148: an expired lease ...`, `ticket149: restart retirement ...` |
| Lost suppressed count | Window-close trailing summary plus `flush()` on `logs.recent`/stop | `a suppressed burst reports its total when the window closes`, `ticket150: feed resets ...` |
| Private test seams | Maintenance is triggered through `invoke`; one narrow documented run hook replaces `activeRuns` access | `ticket148: ...expired lease...`, `ticket148: stop releases local claims...` |
| Duplicated fixtures/blocks | Shared `seedAgent`/`seedWorkspace` fixtures; `retireTask`/`requeueRecoveredTask` helpers | full `service.test.ts` run |
| Duplicated `changesSince` shape | Store returns the canonical `ChangesSince` union | `npm run check`, `store.test.ts` |
| Duplicated failure reason | Top-level `reason` derives from `decision.reason` | `failure-record.test.ts` |
| Unused coalescer API / unreachable reason | Foreign epochs use the delayed `createRefreshCoordinator`; reset reason is mandatory on resets | `foreign-epoch patches coalesce one delayed snapshot...` |
| Ambiguous stream finalization | `finalizeStream` returns `{ message, eligible, reason }`; callers gate `resultMessageID` explicitly | `ticket149: stream finalization reports settlement and result eligibility separately` |
| Missing gap counter | Logger stats count `feed.gap`; `:logs` shows `feedGaps` | `the logger counts feed gaps...`, `:logs shows the feed-gap counter...` |
| 13-instance prototype evidence | Recorded explicitly above | `/tmp/opencode/mock100-artifacts-1794109203/` |
| Real post-fix replay | 30-run recorded above | pass functionally |
| Recoverable gap noise | Debug summaries; warnings only for full-snapshot/exhausted/hard fallbacks | `feed-gaps.test.ts` |

## Real playground baseline (pre-fix)

Source: `/tmp/opencode/playground-results.jsonl` (33 appended rows;
deduplicating by request index yields the 30-request run).

| Metric | Result |
|---|---|
| Requests | **30** |
| Task rows | **42** |
| Task rows succeeded | **42/42** (all replied) |
| Clean requests | **29/30** |
| Corrupted request | **#23** (`complex`, `$meow`, incident-postmortem prompt) |

Request 23 carried the pre-fix multi-instance restart damage: its turn task
reached **attempts 3** and retained `"Ensemble restarted while this subtask was
working."`; the transcript contained the placeholder answers `Reply completed.`
and `Reply interrupted.`, plus a duplicated `Handed to $xedo` message at
sequence 193. Per the spec, the run had four service instances. The remaining
29 requests had one attempt each and no placeholder or duplicate messages.

## Real post-fix 30-request replay

Ran on the live playground after the single-service fixes were merged and the
service module was hot-reloaded by the active host. This session did **not**
restart the host.

| Metric | Result |
|---|---|
| Requests | **30/30 completed** |
| Task rows | **39/39 replied/succeeded** |
| Attempts | **all at attempt 1** |
| Placeholder results | **0** |
| Duplicate completion handoffs | **0** |
| `service.start` / `service.location` | **1 / 1** |
| `feed.reset` | **1** (startup, reason `epoch`) |
| `task.failed` / failure records | **0 / 0** |

### Gap-noise finding and fix

The same run logged **180 TUI `feed.gap` warnings in ~4 minutes** (6 per
~10 s). The reasons were recoverable `gap` decisions whose `from`/`version`/
`entries` were served contiguously by `changes.since`; the service had no
resets. These were successful catch-ups, not failures, so the warning level and
per-event volume were misleading.

Follow-up `fix/feed-gap-noise`:

- Every observed gap still increments the logger's `feedGaps` counter, so the
  true rate remains visible in diagnostics and `:logs`.
- A burst collapses into one trailing summary per 10 s window.
- A caught-up gap emits debug `feed.gap.recovered` with `gaps`, `reasons`, and
  `fallbacks`.
- A full-snapshot fallback or exhausted recovery passes emits warn `feed.gap`.
- `reset`, `epoch`, `malformed`, and `other` decisions keep their warning and
  fallback semantics.

#### Post-fix warning-rate smoke (10 requests)

After the gap-noise merge, the active host hot-reloaded the TUI (new mount
`6185e96f-118c-467a-9cf9-47d0d9c01c6e`; the service stayed on its single
epoch). A mixed 10-request smoke was run:

| Metric | Result |
|---|---|
| Requests | **10/10 completed** |
| Task rows | **13/13 replied/succeeded** |
| Attempts | **all at attempt 1** |
| Placeholders / duplicate handoffs | **0 / 0** |
| `service.start` (subject) | **1** |
| Service `task.failed` / failure records | **0 / 0** |
| Warn-level TUI `feed.gap` lines | **0** |

The new TUI logged only `tui.mount`; recovered gaps are debug-only and the
`feedGaps` counter remains available in `:logs`. The service log for the smoke
contains no warn/error rows.

### Manual replay procedure (repeatable check)

Run this after the user deliberately restarts the playground host, or when
checking the warning rate again. The full 30-run was not repeated after the
gap-noise fix; the 10-request smoke above is the warning-rate check.

1. Confirm one service for the restarted realm: count distinct `instanceID`
   values and `service.start` rows in the service log; expect **one service
   start**, even though the host loads the plugin at every location.
2. Replay the 30 prompts against the live playground:
   `python3 /tmp/opencode/playground-postfix.py /tmp/opencode/playground-prompts.json`
   (append-only results land in `/tmp/opencode/playground-postfix-results.jsonl`).
3. Audit the replay:
   - **30/30** requests sent with no send error; every task row `state=replied`.
   - **0** duplicate completion handoffs: each `handoff.completion=true`
     delivery appears once per correlation/recipient pair.
   - **0** placeholder results: no `resultMessageID` or agent result text is in
     `FALLBACK_REPLIES` (`Reply completed.`, `Reply interrupted.`,
     `Reply interrupted before completion.`).
   - **<5 warn-level `feed.gap` lines**. The `feedGaps` counter may be higher:
     it intentionally counts recovered gaps too. Recovered bursts should appear
     as debug `feed.gap.recovered` summaries.
   - **1** `service.start` / distinct service `instanceID`.
4. Record the host version, command, counts, and artifact paths in this file.
   The functional 30-run above is already recorded; the warning-rate check must
   be repeated after the gap-noise fix.

## Decision evidence

| Invariant / acceptance | Evidence | Result |
|---|---|---|
| One service per host realm | 13 plugin loads / 13 location boots → 1 `service.start`, 1 instance | pass |
| Lease-safe load never requeues live work | `ticket148` live-lease and two-service tests | pass |
| Recovery after expiry or clean release | `ticket148` expired-lease, repair, and stop-release tests | pass |
| No duplicate execution | two-service test: one prompt, one attempt, one durable result | pass |
| Failure truth on restart | `ticket149` failure-attempt/terminal-record/clear-error tests | pass |
| No placeholder success | `ticket149` fallback and request-23 tests | pass |
| Mock 100 clean | 100/100 requests, 137/137 tasks, 0 `task.failed`, 0 failure records | pass |
| Real playground 30-run | 30/30 requests, 39/39 tasks, attempts 1, 0 placeholders, 0 duplicate handoffs | pass |
| Gap truth | Recovered gaps are debug `feed.gap.recovered`; warnings only for real fallbacks | pass (targeted tests) |
| Gap warning rate after fix | 10-request mixed live smoke: 0 warn-level `feed.gap`, 13/13 tasks | pass |
| Attributable logs | 926/926 rows carry role, instance, and thread | pass |
| `npm run verify` | 1020/1020 tests | pass |
| Documentation | `docs/implementation.md` already documents the registry and lease-safe recovery from #147/#148 | pass |

## Skips and limitations

- **Gap-noise fix live recheck: PASS.** The 30-run predates the warning-level
  fix; a post-fix 10-request mixed smoke on the hot-reloaded TUI produced **0**
  warn-level `feed.gap` lines and 13/13 successful tasks. Recovered gaps are
  debug summaries; the full 30-run was not repeated after the gap fix.
- **macOS/Herdr: NOT RUN.** No macOS host is available; the existing manual
  checklist remains authoritative there.
- **Hosted CI: NOT RUN.**
- **Multi-process pumping remains unsupported** by design (ADR 0003). The
  single-service registry is scoped to one host realm.
- Mock artifacts are local to `/tmp/opencode` and are not committed.

## Anomalies

- One expected boot-time catalog race appears in the mock log:
  `service.catalog.error` — `OpenCode reported no models for this project.` —
  followed immediately by `service.catalog.recovered`. Work proceeded, the
  fake model was used for all 137 tasks, and no task failed.
- No `service.stop` row appears in the mock log because the harness terminates
  the isolated host after the run instead of stopping the service cleanly.
  Clean-stop claim release is covered by `ticket148: stop releases local
  claims and preserves foreign claims`.
