# Single service per host and safe recovery (#151)

Status: **verified locally on Linux/tmux; real post-fix replay skipped by design; review fixes recorded below**
Date: 2026-11-08
Issue: [#151](https://github.com/heyimteee/ensemble/issues/151)
Spec: [#146](https://github.com/heyimteee/ensemble/issues/146)
ADR: [0003](../adr/0003-single-service-and-safe-recovery.md)
Base: `integration/single-service` at `b6420fd` (includes #147, #148, #149, #150)
Review fixes: `fix/spec-146-review`
Branch: `verify/single-service`
Worktree: `/home/tristan/dev/ensemble-151`

This record covers the delivery evidence for the single-service registry
(#147), lease-safe load/recovery (#148), restart failure truth (#149), and
log attribution (#150):

- One `service.start` for a host realm that loads the plugin at 13 locations.
- Mock 100: 100 clean requests, 137/137 successful task rows, 0
  `task.failed`, 0 failure records, 8 concurrent runs.
- Lease-safe and restart truth tests pass.
- The pre-fix real 30-request baseline is recorded for contrast; a post-fix
  real replay was skipped because it would restart the active host.

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
| `npm run verify` | **Pass** — strict type check; **1014 tests passed, 0 failed, 0 skipped, 0 todo**, 26.9 s. |
| Mock 100 (`ENSEMBLE_ROOT=/home/tristan/dev/ensemble-review bash /tmp/opencode/mock100-setup-verify.sh`) | **Pass** — driver exit 0; **100 jobs, 137/137 tasks succeeded, 0 failed, 0 `task.failed`, 1 `service.start`, `maxObservedRuns=8`**. |
| `npm run test:live:fake:all` | **Pass** — `fake` 194 s, `fake-empty` 9 s; **2 passed, 0 failed, 0 skipped, 0 not run** (203 s total). |
| Targeted restart/recovery tests (`--test-name-pattern="ticket14[89]"`) | **Pass** — **15 tests passed**, 0 failed, 0 skipped (0.33 s): 7 `ticket148`, 8 `ticket149`. |
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
| Easy | 34 | 1.87 | 2.71 | 3.59 | 6.04 | 6.32 |
| Medium | 33 | 2.59 | 3.36 | 3.91 | 5.46 | 5.52 |
| Hard | 33 | 3.31 | 4.03 | 4.45 | 5.55 | 5.59 |
| All | 100 | 1.87 | 3.71 | 3.98 | 5.86 | 6.32 |

### Artifacts

- Results: `/tmp/opencode/mock100-artifacts-1794117806/mock100-results.json`
- Harness output: `/tmp/opencode/146-review-mock100.log`
- Service log and server/fake logs:
  `/tmp/opencode/mock100-artifacts-1794117806/`
- Prior verification artifacts: `/tmp/opencode/mock100-artifacts-1794115782/`

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
| Real replay skip | Limitation kept explicit with a manual post-restart procedure above | not run |

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

**Post-fix real replay: SKIPPED.** Replaying the 30-request run on the real
host requires restarting the active OpenCode service that this session is
running inside. The isolated mock 100 covers the same production code path,
and `ticket149: the request-23 shape never succeeds on a stale fallback`
reproduces request 23's stale-placeholder shape against the fixed code.

### Manual replay procedure after a host restart

This procedure was **not run** for this record and the host was **not**
restarted by the verification agent. Run it after the user deliberately
restarts the playground host:

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
   - **<5** `feed.gap` warnings, or `feedGaps < 5` in the `logs.recent` stats
     shown by `:logs`.
   - **1** `service.start` / distinct service `instanceID`.
4. Record the host version, command, counts, and artifact paths in this file.
   A skipped replay is not a pass; the mock and targeted tests are the current
   evidence.

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
| Attributable logs | 926/926 rows carry role, instance, and thread | pass |
| `npm run verify` | 1014/1014 tests | pass |
| Documentation | `docs/implementation.md` already documents the registry and lease-safe recovery from #147/#148 | pass |

## Skips and limitations

- **Real post-fix 30-request replay: NOT RUN.** It requires restarting the
  active host service; see above.
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
