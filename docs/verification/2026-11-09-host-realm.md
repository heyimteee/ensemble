# Host-realm tools, events, activity, and alignment (#157)

Status: **verified locally on Linux/tmux; non-first-location tools pass in the harness and the real playground; current TUI mount is clean; full client restart not performed**
Date: 2026-11-09
Issue: [#157](https://github.com/heyimteee/ensemble/issues/157)
Spec: [#152](https://github.com/heyimteee/ensemble/issues/152)
ADR: [0003](../adr/0003-single-service-and-safe-recovery.md)
Base: `integration/host-realm` at `f135ad6` (includes #153, #154, #155, #156)
Branch: `verify/host-realm`
Worktree: `/home/tristan/dev/ensemble-157`

This record covers the delivery evidence for the host-realm location adapters
(#153), per-location events and retry hooks (#154), native Work-card activity
(#155), the Work-card right-edge invariant (#156), and this verification pass
(#157):

- A fifth, non-first channel executes `ensemble_ask_person` through the fake
  provider, creates a durable pending approval in its own workspace, resolves
  it, and leaves no pending row.
- The real playground `xedo` calls `ensemble_ask_person`; the approval
  `Host realm tool probe` is pending until the probe rejects it.
- The 100-request path stays at 100/100 requests, 137/137 tasks, one
  `service.start`, zero failures, and one warn-level `feed.gap`.
- The full unit/integration suite passes.
- The Work-card size matrix passes at 80×24, 100×30, 120×40, and 160×50,
  including `NO_COLOR=1`.
- The current TUI mount logs no stale `skillPageItems` export warning. A
  server-only restart does not clear the client module graph, so the runtime
  guide now documents the full client restart.

## Environment

| Item | Value |
|---|---|
| OS | Linux 6.12.113+deb13-amd64 |
| Terminal host | tmux 3.5a |
| Node | v26.12.1 |
| npm | 12.2.1 |
| OpenCode (harness and live service) | `opencode v2.2.6` |
| Live service PID / instance | 4083167 / `1794126927168000`, thread 0 |
| Live service URL | `http://127.0.0.1:49374` (from `~/.local/state/opencode/service.json`) |
| macOS/Herdr | Not available; not run |
| Hosted CI | Not run |

## Commands and results

| Command | Result |
|---|---|
| `npm run verify` | **Pass** — strict type check; **1054 tests passed, 0 failed, 0 skipped, 0 todo**, 30.8 s. |
| `npm run test:live:multilocation` | **Pass** — **100/100 requests, 137/137 tasks succeeded, all at attempt 1, 0 `task.failed`, 0 failure records, 1 `service.start`, 1 warn-level `feed.gap`; tool probe passed**. |
| Real playground `ensemble_ask_person` smoke | **Pass** — pending `ask_person` approval `Host realm tool probe` from `xedo` in `playground`; rejected by the probe; task replied; 0 pending approvals remain. |
| `npm run test:live:sizes` | **Pass** — 80×24, 100×30, 120×40, 160×50, and `NO_COLOR=1` checks; CPU recorded for idle and 1–3 working cards. |
| `npm run test:live:preflight` | **Pass** — Node v26.12.1, OpenCode v2.2.6, tmux 3.5a. |
| `git diff --check` | **Pass** — exit 0, no whitespace errors. |
| Prototype tree check (`git ls-files \| grep -i prototype`) | **Pass** — no prototype files in the tree. |

## Multi-location harness (fake host)

The harness starts an isolated fake provider, an isolated `HOME`/`XDG` tree,
and a fresh OpenCode server whose plugin points at this worktree. The driver
creates four channels (`mock-a`…`mock-d`) and eight agents, sets
`maxActiveRuns=8`, `maxDelegations=10`, `maxDepth=5`, and sends the unchanged
100-request mix. After that measured run it creates a fifth channel (`mock-e`)
with two more agents and runs the tool probe. The fifth location is created
after the 100-request sends so the request mix, counts, and latency path are
unchanged.

### Results

| Assertion | Result |
|---|---|
| Jobs sent | **100** |
| Jobs with a failed root task | **0** |
| Task rows (`turn` 69 + `delegation` 34 + `handoff` 34) | **137** |
| Task outcomes / states | **137 succeeded / 137 replied** |
| Attempts | **137 at attempt 1** |
| `service.start` after the fifth location attached | **1** |
| `service.stop` | 0 |
| `task.failed` / failure records | **0 / 0** |
| `maxObservedRuns` | **8** |
| Settle time after the last of the 100 sends | 11.4 s |
| Service log rows | 940 (`malformed=0`) |
| Warn-level TUI `feed.gap` lines after the first send | **1** (`<5`) |
| Tool probe | **pass** |

### Non-first-location tool probe

`mock-e` is a fifth channel: not the project location and not one of the four
measured channels. Its leader (`iota`) receives:

`Probe 101: fake-ask-person`

The fake provider emits one `ensemble_ask_person` tool call. The probe requires
the durable approval in the `mock-e` workspace, so a missing tool cannot pass on
a transcript or tool-call attempt alone.

| Observation | Value |
|---|---|
| Workspace | `mock-e` (`workspace_12e804b82cc04599b66b`) |
| Agent | `iota` (`agent_d9c0735982b54bfeb6d3`) |
| Pending approval | `approval_06a50e77cee74a14ad32` |
| Kind / detail | `ask_person` / `Which release channel should this task use?` |
| Resolution | approved by the probe |
| Probe task after resolution | `replied` / `succeeded` |
| `approval.requested` / `approval.resolved` rows | **1 / 1** (no duplicate) |
| Pending approvals left in the workspace | **0** |
| Probe elapsed | 5.2 s |

If `ensemble_ask_person` is absent from the fifth location, the fake provider
still returns a tool call, but no approval is created; the driver waits up to
90 s, records the workspace transcript and task rows, and fails the probe.

Artifacts:

- Runner output: `/tmp/opencode/157-multilocation-final.log`
- Earlier run used to exercise the probe before the duplicate-row assertion:
  `/tmp/opencode/157-multilocation.log`

The harness cleans its isolated tree on success; the JSON summary is retained in
the runner output above.

## Real playground tool smoke

Ran against the already-running live host. **The host and TUI were not
restarted**, and the probe used the existing `playground` workspace and `xedo`
agent through the service RPC.

Prompt sent to `xedo` (`recipientIDs: [xedo]`):

> Call the ensemble_ask_person tool exactly once with question "Host realm tool
> probe", then stop and wait for the answer. Do not answer the question yourself
> and do not call any other tool.

| Observation | Value |
|---|---|
| Workspace | `playground` (`workspace_c0faee0043cb49f1a805`) |
| Agent | `xedo` (`agent_3c0788e5c98c41a2951d`) |
| Task | `task_0658ebacaebe407399d3` |
| Task created | `2026-11-08T08:48:28.056Z` |
| Approval requested | `2026-11-08T08:48:36.103Z` |
| Approval | `approval_7110f5c80f6649369d62` |
| Kind / detail | `ask_person` / `Host realm tool probe` |
| Approval title | `xedo needs your input` |
| Resolution | rejected by the probe at `08:48:36.323Z` |
| Task after rejection | `replied` / `failed` (`User rejected the request.`) |
| `approval.requested` / `approval.resolved` service rows | **1 / 1** |
| Pending approvals after cleanup | **0** |
| Probe latency (send → settled) | 8.3 s |

The rejection outcome is deliberate: rejecting is the bounded cleanup path and
must settle the parked task without leaving a pending approval. The approval
row is the direct evidence that the real native session in the playground
location executed the Ensemble tool. Service log rows also carry the single
service `instanceID` and `threadID 0`.

Artifacts:

- Record: `/tmp/opencode/157-real-tool-probe.json`
- Runner output: `/tmp/opencode/157-real-tool-probe.log`

## Work-card size matrix

`npm run test:live:sizes` passed the full matrix on the isolated fake host. Each
size checks the Work block layout, group header, overflow behavior, focus,
card/compact switch, and composer; the 100×30 and 120×40 cases also append a
second group and remove the old one independently. The `NO_COLOR=1` pass
asserts frame-0 glyphs and state text while work is live.

| Size | Result |
|---|---|
| 80×24 | pass — compact rows, `+2 more`, no card headers, composer and focus |
| 100×30 | pass — two card headers, `+1 more`, newest-group priority, independent removal |
| 120×40 | pass — three card headers, second group append, old group removal |
| 160×50 | pass — three cards without overflow, action hints, second/third load probe |
| `NO_COLOR=1` (120×40) | pass — static glyphs, state text, composer |

Recorded TUI CPU during the 160×50 load probe:

| State | CPU |
|---|---|
| Idle before work | 1.1% |
| 1 working card | 21.1% |
| 2 working cards | 26.7% |
| 3 working cards | 23.3% |

Artifact: `/tmp/opencode/157-sizes.log`.

## Stale TUI module status

The current TUI client is PID 4085546. Its log
(`~/.local/state/ensemble/logs/tui-20261108-4085546.jsonl`) records two mounts
for this process:

| Mount | Time (UTC) |
|---|---|
| `bb11ad8a-d610-4aa4-a83f-14e949911c5f` | `2026-11-08T06:57:23.355Z` |
| `1a820120-b97f-44a8-ba0d-27b4260d7ffd` | `2026-11-08T08:35:28.090Z` (current) |

`~/.local/share/opencode/log/opencode.log` last records the stale export warning
at `2026-11-08T08:35:27.087Z`:

`Export named 'skillPageItems' not found in module .../src/v2/tui/bubbles.ts`

That warning is **1.0 s before the current mount**. After
`08:35:28.090Z`, the log contains **0** `plugin operation failed` rows at
`level=WARN` (later matches are only this verification's own `grep` commands
logged at INFO). The current mount is clean, so the stale warning does not
persist after it.

A full client restart was **not performed** (the live host was intentionally
left running). The current clean mount came from the host's TUI reload, not a
fresh client process. Because a server-only restart does not rebuild the client
module graph, the runtime guide now carries the targeted recovery procedure:
[full client restart](../agents/opencode-tui-runtime.md#tui-module-graph-and-full-client-restart).

## Decision evidence

| Invariant / acceptance | Evidence | Result |
|---|---|---|
| A non-first channel agent can call an Ensemble tool | `mock-e` approval created by `ensemble_ask_person`; real playground `xedo` approval | pass |
| Every location installs and disposes its own tools | `location-adapter.test.ts`: two locations execute against their own binding; disposal keeps the shared service up; failed attach unwinds | pass |
| Non-first text, permissions, retry hooks arrive once | `location-adapter.test.ts` second-location cases; `host-events.test.ts` identity/dedupe cases | pass |
| Work cards show native tool activity | `work-activity.test.ts`; `workrows.test.ts` ticket155; full suite | pass |
| Header and tide share the right edge at every width | `tide.test.ts` ticket156 widths 16–120; `workrows.test.ts` ticket156; live size matrix | pass |
| Tool probe has no duplicate approval events | harness asserts exactly one `approval.requested` and one `approval.resolved`; real service log also 1/1 | pass |
| One service for all locations | harness: 1 `service.start` after the fifth location; real service: one `instanceID`, thread 0 | pass |
| No failures in the measured run | 100/100 requests, 137/137 tasks, 0 `task.failed`, 0 failure records | pass |
| `npm run verify` | 1054/1054 tests | pass |
| Runtime guide explains full client restart | [TUI module graph](../agents/opencode-tui-runtime.md#tui-module-graph-and-full-client-restart) | pass |
| No prototype source | `git ls-files` check | pass |

## Skips and limitations

- **Full client restart: NOT RUN.** The host was intentionally not restarted.
  The current TUI mount is clean (0 stale-export warnings after it), and the
  full-client-restart procedure is documented; a fresh client process was not
  observed in this pass.
- **macOS/Herdr: NOT RUN.** No macOS host is available.
- **Hosted CI: NOT RUN.**
- **Full real `test:live:all`: NOT RUN.** This pass used the isolated fake
  multi-location and size matrices plus the targeted real playground tool
  smoke; the model-dependent full matrix stays local.
- **The real probe task is intentionally failed.** Rejecting the approval is
  the cleanup path; the task settles `replied`/`failed` with
  `User rejected the request.` No pending approval remains.
- Multi-process pumping remains unsupported by design (ADR 0003).

## Anomalies

- The multi-location TUI logged one warn-level `feed.gap` after the first send,
  below the `<5` threshold. The service log had no reset and no failure rows.
- The real rejection produced the expected fallback message
  `Reply interrupted.` in the transcript after the approval decision; it is not
  a successful answer and the task settled failed as designed.
- The last `skillPageItems` stale-export warning occurred once, immediately
  before the current TUI mount; no warning follows the current mount.
