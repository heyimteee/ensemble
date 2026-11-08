# Single service per host and safe recovery (#151)

Status: **verified locally on Linux/tmux; real post-fix replay skipped by design**
Date: 2026-11-08
Issue: [#151](https://github.com/heyimteee/ensemble/issues/151)
Spec: [#146](https://github.com/heyimteee/ensemble/issues/146)
ADR: [0003](../adr/0003-single-service-and-safe-recovery.md)
Base: `integration/single-service` at `b6420fd` (includes #147, #148, #149, #150)
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
| `npm run verify` | **Pass** — strict type check; **1007 tests passed, 0 failed, 0 skipped, 0 todo**, 28.0 s. |
| Mock 100 (`ENSEMBLE_ROOT=/home/tristan/dev/ensemble-151 bash /tmp/opencode/mock100-setup-verify.sh`) | **Pass** — driver exit 0; **100 jobs, 137/137 tasks succeeded, 0 failed, 0 `task.failed`, 1 `service.start`, `maxObservedRuns=8`**. |
| `npm run test:live:fake:all` | **Pass** — `fake` 194 s, `fake-empty` 9 s; **2 passed, 0 failed, 0 skipped, 0 not run** (203 s total). |
| Targeted restart/recovery tests (`--test-name-pattern="ticket14[89]"`) | **Pass** — **13 tests passed**, 0 failed, 0 skipped (1.44 s): 6 `ticket148`, 7 `ticket149`. |
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
| Easy | 34 | 1.96 | 2.80 | 3.62 | 6.07 | 6.48 |
| Medium | 33 | 2.62 | 3.41 | 3.93 | 5.59 | 5.65 |
| Hard | 33 | 3.27 | 4.08 | 4.44 | 5.56 | 5.68 |
| All | 100 | 1.96 | 3.64 | 4.00 | 5.88 | 6.48 |

### Artifacts

- Results: `/tmp/opencode/mock100-results.json`
- Harness output: `/tmp/opencode/151-mock100.log`
- Service log and server/fake logs:
  `/tmp/opencode/mock100-artifacts-1794115782/`
- Reproduced audit output: `/tmp/opencode/151-mock100-audit.txt`

## Restart and recovery tests

`node --test --experimental-strip-types --test-name-pattern="ticket14[89]"
src/v2/service.test.ts` → **13 passed, 0 failed, 0 skipped**:

| Ticket | Test | Result |
|---|---|---|
| #148 | load leaves a live foreign lease working row untouched | pass |
| #148 | an expired lease is requeued once and attempts rise only on the next claim | pass |
| #148 | a working row with no claim and no local run is repaired | pass |
| #148 | stop releases local claims and preserves foreign claims | pass |
| #148 | streaming rows survive load only while their lease is live | pass |
| #148 | a second service over shared storage never steals a live claim | pass |
| #149 | restart requeue writes a failure attempt with the previous claim and lease | pass |
| #149 | restart retirement writes a terminal failure record | pass |
| #149 | a recovered then successful task clears its restart error | pass |
| #149 | a fallback reply is retried as an empty answer | pass |
| #149 | an exhausted fallback reply fails visibly without a result | pass |
| #149 | the request-23 shape never succeeds on a stale fallback | pass |
| #149 | an empty terminal stream settles as interrupted, never a completed placeholder | pass |

These cover the crash path by simulation: an unexpired foreign claim is never
stolen, expiry requeues exactly once with attempts preserved, a clean stop
releases only local claims, and a recovered success clears the restart error.

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
| `npm run verify` | 1007/1007 tests | pass |
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
