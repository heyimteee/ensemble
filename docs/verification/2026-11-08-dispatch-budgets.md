# Dispatch budgets, continuation groups, and live evidence (#164)

Status: **verified locally on Linux/tmux; fake-provider five/nine/cap and size matrix pass; real playground continuation smoke skipped because the live host runs the pre-#160 main tree and was not restarted or reconfigured**
Date: 2026-11-08
Issue: [#164](https://github.com/heyimteee/ensemble/issues/164)
Spec: [#159](https://github.com/heyimteee/ensemble/issues/159)
ADR: [0004](../adr/0004-dispatch-budgets-and-continuation.md)
Base: `integration/dispatch-budgets` at `b31b085` (includes #160–#163)
Branch: `verify/dispatch-budgets`
Worktree: `/home/tristan/dev/ensemble-164`

This record covers the delivery evidence for the dispatch-budget contract
(#160–#163) and this documentation/live-verification pass (#164):

- The isolated fake host passes a five-hop relay inside one group, a nine-hop
  relay across a continuation, and an 8-hop command-cap stop.
- All 22 consuming hops have exactly one `dispatch.hop.consumed` row; 22
  distinct work items consumed 22 rows, with no duplicate consumption.
- The unchanged 100-request multi-location path stays at 100/100 requests,
  137/137 tasks, one service, zero failures, and one warn-level `feed.gap`.
- The budget workspace ends with zero pending approvals and zero open tasks.
- The doctor reports zero mismatches and a consistent ledger.
- `npm run test:live:sizes` passes 80×24, 100×30, 120×40, 160×50, and
  `NO_COLOR=1` with budget labels.
- The full unit/integration suite passes.
- The real playground continuation smoke is a documented skip; the post-merge
  smoke is left for the leader (see [Skips](#skips-and-limitations)).

## Environment

| Item | Value |
|---|---|
| OS | Debian GNU/Linux 13 (trixie), Linux 6.12.113+deb13-amd64 |
| Terminal host | tmux 3.5a |
| Node | v26.12.1 |
| npm | 12.2.1 |
| OpenCode (harness and live service) | `opencode v2.2.6` |
| Live service PID | 4083167 |
| Live plugin path | `/home/tristan/dev/ensemble` at `b6237e1` (`main`, before #160) |
| macOS/Herdr | Not available; not run |
| Hosted CI | Not run |

## Commands and results

| Command | Result |
|---|---|
| `npm run verify` | **Pass** — strict type check; **1136 tests passed, 0 failed, 0 skipped, 0 todo**, 40.3 s. |
| `npm run test:live:multilocation` | **Pass** — **100/100 requests, 137/137 tasks succeeded, all at attempt 1, 0 `task.failed`, 0 failure records, 1 `service.start`, 1 warn-level `feed.gap`; tool probe and all three budget scenarios pass**. |
| `npm run test:live:sizes` | **Pass** — 80×24, 100×30, 120×40, 160×50, and `NO_COLOR=1` with dispatch budget labels. |
| Doctor in the same harness | **Pass** — `0 mismatches`, `Result: all requested locations agree`, dispatch counters consistent. |
| Log summary in the same harness | **Pass** — 1269 rows, 0 malformed, 0 failures, 105 groups, 22 hops, 1 continued, 2 exhausted, 1 refused, 1 closed. |
| `git diff --check` | **Pass** — exit 0, no whitespace errors. |
| Prototype tree check (`git ls-files \| grep -i prototype`) | **Pass** — no prototype files in the tree. |
| Real playground continuation smoke | **SKIP** — live plugin path is `main` at `b6237e1`, before #160; a continuation would require reloading/reconfiguring the live host. |

## Multi-location harness (fake host)

The harness starts an isolated fake provider, an isolated `HOME`/`XDG` tree,
and a fresh OpenCode server whose plugin points at this worktree. The unchanged
driver creates four channels (`mock-a`…`mock-d`) and eight agents, sets
`maxActiveRuns=8`, `maxDelegations=10`, `maxDepth=5`, and sends the unchanged
100-request mix. A fifth channel (`mock-e`) then runs the #157
`ensemble_ask_person` tool probe. Ticket #164 adds a sixth channel (`mock-f`)
with two relay agents and runs the budget scenarios **after** the measured
path, so the 100-request counts and timings cannot move.

### Results

| Assertion | Result |
|---|---|
| Jobs sent | **100** |
| Jobs with a failed root task | **0** |
| Task rows (`turn` 69 + `delegation` 34 + `handoff` 34) | **137** |
| Task outcomes / states | **137 succeeded / 137 replied** |
| Attempts | **137 at attempt 1** |
| `service.start` after the fifth and sixth locations attached | **1** |
| `service.stop` | 0 |
| `task.failed` / failure records | **0 / 0** |
| `maxObservedRuns` | **8** |
| Settle time after the last of the 100 sends | 11.5 s |
| Service log rows | 1041 (`malformed=0`) |
| Warn-level TUI `feed.gap` lines after the first send | **1** (`<5`) |
| Non-first-location tool probe | **pass** (`approval_b483668c18184e9a836d`, resolved, task replied) |
| Budget workspace pending approvals / open tasks | **0 / 0** |

### Dispatch-budget scenarios

| Scenario | Groups | Consuming hops | Rows | Distinct consumed tasks | Group state | Command state | Evidence |
|---|---|---|---|---|---|---|---|
| `five` | 1 root | 5 | 5 | 5 | 5/8, active | 5/24 | no exhaustion or refusal |
| `nine` | root + continuation 1 | 9 | 9 | 9 | root 8/8, sealed `continued`; continuation 1/8 | 9/24, `continuationsUsed=1` | one `dispatch.group.continued`, one `dispatch.group.closed`, root `group-exhausted` warning |
| `cap` | 1 root | 8 | 8 | 8 | 8/8, exhausted | 8/8, exhausted | one `command-exhausted` exhaustion and one `dispatch.group.refused` |

The cap scenario sends no ninth work item. The tool result and group line are:

> Continuation refused: the command budget is exhausted (8/8 hops); ask the user
> to start a new command for a fresh budget.

The nine-hop continuation is linked as required:

| Field | Root | Continuation |
|---|---|---|
| Group id | `dispatch_77ad91b313e04432bb34` | `dispatch_a3eca59d95a14e88b492` |
| Root | `dispatch_77ad91b313e04432bb34` | `dispatch_77ad91b313e04432bb34` |
| Parent | — | `dispatch_77ad91b313e04432bb34` |
| Continuation index | 0 | 1 |
| Hops | 8/8 | 1/8 |
| Close | `continued` | — |
| Command | 9/24 | inherited from root |

### No duplicate consumption

| Observation | Value |
|---|---|
| Total consuming hops | **22** |
| `dispatch.hop.consumed` rows | **22** |
| Distinct `taskID`s in those rows | **22** |
| Work items with more than one consumed row | **0** |
| Scenario task attempts above 1 | **0** |
| Dispatch rows containing task text | **0** (checked for the relay marker, titles, and instructions) |

Each scenario's group `usedHops` equals its counted consuming tasks, and the
root `commandUsedHops` equals the sum of its groups. The doctor independently
rechecks the same invariant.

## Log-summary evidence

`npm run logs:summary -- --dir <isolated logs>` produced:

| Metric | Whole run | `five` root | `nine` root | `cap` root |
|---|---|---|---|---|
| Rows | 1269 | — | — | — |
| Malformed | 0 | — | — | — |
| Failures | 0 | — | — | — |
| Groups | 105 | 1 | 2 | 1 |
| Hops | 22 | 5 | 9 | 8 |
| Continued | 1 | 0 | 1 | 0 |
| Exhausted | 2 | 0 | 1 | 1 |
| Refused | 1 | 0 | 0 | 1 |
| Closed | 1 | 0 | 1 | 0 |
| Created | 105 | 1 | 2 | 1 |

`--group <root>` includes the continuation lineage: the `nine` root reports
both groups, 9 hops, 1 continued, 1 closed, and 1 exhaustion. The whole-run
summary's `feedGaps=3` includes recovered gaps; the measured TUI warn count
remains 1 (`<5`).

## Doctor evidence

The doctor ran against the same isolated service and project after the budget
scenarios:

```text
Dispatch: groups=105 roots=104 continuations=1 active=103 exhausted=1 closed=1 hops=22/840 command=22/2480
Mismatches: none
Summary: 0 mismatches across 1 location.
Result: all requested locations agree.
```

The 103 "active" groups are terminal one-command roots that still have hop
capacity; they are not live work and the Work pane hides them after its hold.
The doctor correctly treats them as active ledger groups, not errors.

## Work-card size matrix

`npm run test:live:sizes` passed the full matrix on the isolated fake host.
Every active surface carries a budget label:

| Size | Result |
|---|---|
| 80×24 | pass — compact row shows the name, `0/8 · 24 left`, and WORKING; the long fixture title ellipsizes; `+2 more`; no card headers; focus and composer |
| 100×30 | pass — two card headers, `+1 more`, newest-group priority, group label `hops 0/8 · cmd 24 left`, independent removal |
| 120×40 | pass — three card headers, second group append, group label `hops 0/8 · cmd 24 left`, old group removal |
| 160×50 | pass — three cards without overflow, full budget label, action hints, second/third load probe |
| `NO_COLOR=1` (120×40) | pass — `0/8` budget label, static glyphs, state text, composer |

Recorded TUI CPU during the 160×50 load probe:

| State | CPU |
|---|---|
| Idle before work | 1.1% |
| 1 working card | 8.9% |
| 2 working cards | 11.1% |
| 3 working cards | 12.2% |

At 80×24 the compact row keeps the agent name, budget, and status; the long
task title yields first, matching the [ADR 0004](../adr/0004-dispatch-budgets-and-continuation.md)
trade-off. The full title remains in the chat and native session.

## Real playground continuation smoke

**SKIP — not run; the live host cannot exercise continuation without a
reload/reconfigure.**

Observed without changing anything:

| Item | Value |
|---|---|
| Live service | PID 4083167, OpenCode 2.2.6 |
| Configured plugin path | `/home/tristan/dev/ensemble` |
| Live path branch / HEAD | `main` / `b6237e1` (`ci: fetch pinned fd through the release API (#158)`) |
| Budget tool support on that tree | None — it predates #160–#163 (`maxHops`, `continuationOf`, and the ledger do not exist there) |

The user's live host was intentionally **not** restarted or reconfigured. To
make the real playground support continuation, the live path would need to
check out `integration/dispatch-budgets` (or later `main` after merge) and the
host would need a reload/restart. The isolated real-host harness
(`npm run test:live`) intentionally strips host credentials and the model
catalog, so it cannot provide a real-model continuation run either.

Post-merge smoke for the leader, after the integration branch or merged `main`
is loaded into the live host:

1. Confirm the tool schema includes `maxHops` and `continuationOf`.
2. Send one command that delegates with `maxHops: 1`, have the peer hand back
   with `maxHops: 0`, and confirm five-hop/four-hop relays complete.
3. Exhaust an 8-hop root group, open a continuation with `groupMaxHops: 8`,
   and confirm one linked CONTINUED/CONT group with no duplicate hop rows.
4. Confirm no pending approval or stuck task remains, then start a new command
   for a fresh budget.

## Artifacts

- Runner log: `/tmp/opencode/164-final-multilocation.log`
- Harness artifacts: `/tmp/opencode/164-final-multilocation/`
  (`dispatch-budgets.json`, `doctor.txt`, `log-summary.json`,
  `log-summary-dispatch_*.json`, `fake.log`, `service-logs/`)
- Size matrix log: `/tmp/opencode/164-sizes-final.log`
- Verify log: `/tmp/opencode/164-verify-final2.log`
- Live-host skip evidence: `/tmp/opencode/164-live-host-state.txt`

The harness cleans its isolated project, service, and TUI on success; the
copied artifacts above are the retained evidence.

## Skips and limitations

- **Real playground continuation: NOT RUN.** The live path runs pre-#160
  `main`; reloading/reconfiguring it was explicitly out of bounds. See the
  post-merge steps above.
- **macOS/Herdr: NOT RUN.** No macOS host is available.
- **Hosted CI: NOT RUN.**
- **Full real `test:live:all`: NOT RUN.** This pass used the isolated fake
  multi-location and size matrices; the model-dependent full matrix stays
  local.
- **Full `test:live:fake`: NOT RUN as a pass.** A local attempt surfaced two
  pre-existing full-scenario gaps unrelated to the budget harness: the init
  assertion still expected `<!-- ensemble:start v2 -->` after the contract
  moved to v4, and the short-lived `fake-queue-alpha` Work card can finish
  before the 15 s card wait observes it. Both are outside #164's budget scope
  and were left untouched; a focused follow-up should update the init
  expectation and make that work-card wait observe the active window rather
  than the terminal hold. Attempt logs:
  `/tmp/opencode/164-full-fake-2.log` and
  `/tmp/opencode/164-full-fake-3.log`.
- Multi-process budget coordination remains unsupported by design (ADR 0003,
  ADR 0004). The ledger is single-service.

## Anomalies

- The multi-location TUI logged one warn-level `feed.gap` after the first send,
  below the `<5` threshold; the whole-run log summary reports 3 feed-gap rows
  including recovered transitions.
- At 80×24 the compact row ellipsizes the long fixture title to `…` because the
  budget label sits between name and status. This is the documented width
  trade-off, not a layout break; the right edge and status word are exact.
- The doctor's 103 active groups are terminal one-command roots with remaining
  hop capacity. They are hidden from the Work pane after the shared hold and
  are not stuck work.
