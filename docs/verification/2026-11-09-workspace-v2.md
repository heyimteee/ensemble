# Workspace v2 verification: lifecycle truth, three-pane shell, and composer references (#177)

Status: **verified locally on Linux/tmux; unit suite, full fake suite, size matrix, latency probe, lifecycle long-run, multi-location, and empty-catalog fake suite pass; real-host matrix is a post-merge step because the live host still runs `main`**
Date: 2026-11-09
Issue: [#177](https://github.com/heyimteee/ensemble/issues/177)
Specs: [#165](https://github.com/heyimteee/ensemble/issues/165), [#166](https://github.com/heyimteee/ensemble/issues/166), [#167](https://github.com/heyimteee/ensemble/issues/167)
Tickets: [#168](https://github.com/heyimteee/ensemble/issues/168)–[#176](https://github.com/heyimteee/ensemble/issues/176)
ADRs: [0005](../adr/0005-work-status-and-delivery-lease-separation.md), [0006](../adr/0006-three-pane-workspace-shell.md)
Base: `integration/workspace-v2` at `bcb957b` (includes #168–#176 and the code-review fix)
Branch: `verify/workspace-v2`
Worktree: `/home/tristan/dev/ensemble-177`

This record is the release evidence for the work lifecycle, the three-pane
workspace shell, and bounded composer file references:

- The full fake scenario passes the rail split, durable collapse, ACTIVE/HISTORY,
  inline approvals, native picker, member alignment, composer references,
  cached index, controlled stop, and genuine native failure checks.
- The size matrix passes 80×24, 100×30, 120×40, and 160×50, including the
  closed/open/closed drawer, compact rows, card pagination, spatial `hjkl`,
  page edges, the exact right edge, and the white/grey card focus borders read
  from ANSI capture.
- A full wall-clock lifecycle run crosses the old five-minute delivery deadline
  with a live heartbeat lease; an immediate backlog delivery stays pending past
  its own deadline and then runs. The doctor and structured logs show no false
  failure or stall.
- Multi-location remains one service with 100/100 requests and 137/137 tasks,
  with no duplicate consumption.
- The real host-catalog matrix is a post-merge step; the live host still runs
  `main` `0453aa3` and was not restarted or reconfigured.

## Environment

| Item | Value |
|---|---|
| OS | Debian GNU/Linux 13 (trixie), Linux 6.12.113+deb13-amd64 |
| Terminal host | tmux 3.5a |
| Node | v26.12.1 |
| npm | 12.2.1 |
| OpenCode (fake harness) | `opencode v2.2.6` |
| fd | `fdfind 10.2.0` |
| Live service host | `main` at `0453aa3`; **not restarted or reconfigured** |
| Worktree plugin | `/home/tristan/dev/ensemble-177` at the verification commit |
| macOS/Herdr | Not available; not run |
| Hosted CI | Not run |

## Commands and results

| Command | Result |
|---|---|
| `npm run verify` | **Pass** — strict type check; **1377 tests passed, 0 failed, 0 skipped, 0 todo**, 42.1 s. |
| `ENSEMBLE_LIVE_REQUIRE=1 ENSEMBLE_LIVE_ARTIFACTS=/tmp/opencode/verification-177/fake bash scripts/live-check-fake.sh` (`npm run test:live:fake`) | **Pass** — full fake scenario including the ticket #177 shell, lifecycle, composer, doctor, and log-summary checks; about 6m45s. Artifacts under `/tmp/opencode/verification-177/fake`. |
| `ENSEMBLE_LIVE_REQUIRE=1 npm run test:live:fake:empty` | **Pass** — empty model catalog and init routing. Console copy under `/tmp/opencode/verification-177/empty-console.txt`. |
| `npm run test:live:sizes` | **Pass** — 80×24, 100×30, 120×40, 160×50, `NO_COLOR=1`, load probe, white/grey borders. Console copy under `/tmp/opencode/verification-177/sizes-console.txt`. |
| `npm run test:live:lifecycle` | **Pass** — 5m13.7s deadline crossing with heartbeats, backlog past its delivery timestamp, both groups replied, doctor/log summary clean. Console copy under `/tmp/opencode/verification-177/lifecycle-console.txt`. |
| `npm run test:live:latency` | **Pass** (measurement only) — rail `j`/`k` 8–12ms; card appearance 151–176ms; see the table below. |
| `ENSEMBLE_LIVE_REQUIRE=1 npm run test:live:multilocation` | **Pass** — 100/100 requests, 137/137 tasks, one service, 0 failures, 1 warn-level `feed.gap`; tool and budget scenarios pass; doctor `0 mismatches`. |
| Real host-catalog matrix (`npm run test:live` / `test:live:all`) | **POST-MERGE** — the live host runs `main` at `0453aa3`; the merged tree must be loaded first. The host was not restarted. |
| `git diff --check` | **Pass** — no whitespace errors. |
| Prototype source check | **Pass** — no prototype files in the tree. |

## Full fake suite (#177)

The final run sets `ENSEMBLE_LIVE_ARTIFACTS=/tmp/opencode/verification-177/fake`
and covers both legacy v5.7/v5.8 behavior and the new shell. New checks and
their evidence:

| Area | Live evidence |
|---|---|
| Right Work pane | At 160×80 the Work header is `WORK ACTIVE │ … │ page n/m` in its own bordered right pane; cards render with the existing card design. |
| ACTIVE/HISTORY | A finished group leaves ACTIVE immediately, appears under `f` as `WORK HISTORY`, and returns to ACTIVE on the second `f`; terminal cards are absent from ACTIVE. |
| Work actions | Enter opens a durable result; `d`/`t`/`R`/`x`/`o` are advertised only when valid; a running card does not advertise `r retry`; a cancelled history card does. |
| Sticky approvals | `APPROVALS 1 pending │ v focus`; `v` focuses the section, Enter opens the decision, the ask answer prompt resolves it, and the section disappears. A second ask is rejected through the same section and ends `CANCELLED`, not `FAILED`. |
| Genuine native failure | The fake provider returns a non-retried 4xx model error; the card emits one `✕ FakeAgent failed:` event, moves to HISTORY as `FAILED`, and is the only failure event. |
| Rail split and collapse | `AGENTS (4)` and `WORKSPACES (1)` are separate panes; the agent group header carries `▾ #LiveSite (4)`; sublines are role-only; `z` collapses and the state survives a TUI restart; `z` expands again. |
| Native picker | Group-chat `o` opens `Native session`; rows show role, leader, and busy state; `/` filters to one member; the unbound member shows `No native session for Quiet yet`; a bound member routes to the native TUI and F2 returns. |
| Member alignment | The workspace wizard member rows put the `│` separator in one column for different name lengths, then cancel through the dirty confirm. |
| Composer references | Untracked `handover.md` completes; `@handover.md the git log` preserves the sentence; `@docs/my\ notes.md` resolves and inserts escaped spaces; typing inside the token keeps `@ files │ hando`, Backspace restores the query, and selection preserves the suffix; the server receives the escaped path. |
| Cached index | A counting `fd` wrapper shows filter keystrokes spawn no discovery after the palette is warm. |
| Operator records | Doctor output has `Mismatches: none`; `logs:summary` has exactly one failed task (the deliberate native error) and no `task.stalled` event. |

The full run also exposed a doctor contradiction: rejecting an ask cleared
`claimedBy`/`leaseUntil`/`retryAfter` but left `activeRunID`, so the terminal
controlled-stop row kept a queue field and the doctor reported
`work_terminal_contradiction`. The rejection and interrupted-discard branches
now clear `activeRunID`; `service.test.ts` seeds a live foreign claim and
asserts both branches clear it, and the live doctor assertion requires
`Mismatches: none`. That is the doctor/failure-record evidence in this run.

The narrower chat cell also exposed that a long skill description could push
the `Skill | <Owner>` flag out of the palette row. `paletteRowTitle` now leads
each command/skill row with its flag (`Skill | FakeAgent │ …`), and
`composer.test.ts` "palette rows lead with their flag so a narrow chat cell
keeps the owner" pins it. Live evidence: `Skill | FakeAgent` and
`Skill | General` are visible before the description truncates.

## Size matrix

`npm run test:live:sizes` starts a fresh five-group/six-task fixture at each
size and cancels it before the next size. Results:

| Size | Mode | Evidence |
|---|---|---|
| 80×24 | drawer (<96) | Work is absent until `F3`; the open drawer shows `WORK ACTIVE │ 5 groups · 6 active`, compact rows, `page 1/2`, `1/5` focus, keyboard page edge to `page 2/2`, then `F3` closes it and returns focus to the chat. |
| 100×30 | three panes, compact | `WORK ACTIVE │ 5 groups · 6 active`, six compact rows, group label, `0/8` budget, `page 1/1`, `1/6` → `2/6` → `1/6`, exact right edge at column 100. |
| 120×40 | three panes, compact | Same compact and focus checks at the 120-column breakpoint. |
| 160×50 | three panes, cards | Five visible cards on page one, group labels, `page 1/2`; `l`/`h` within the row, `j`/`k` across rows, `gg`/`G`, five `j` presses crossing to `page 2/2`, one `k` returning to `page 1/2`; exact right edge at column 160. |

### White focused / grey unfocused border evidence

The focused and unfocused borders are read from `tmux capture-pane -e` in the
Work pane's content columns, not from a colour-less text capture:

- With the first card focused, the left card top border is white
  (`38;5;15`, the 256-colour downsample of the `#ffffff` `cardFocus` token) and
  the right neighbour is grey (`38;5;238`, the host border grey).
- After `l` focuses the second card, the colours swap: the left card is grey
  and the right card is white. This proves both the white focused border and
  the grey unfocused border, and that focus follows the card.
- Pane focus remains a separate border state; the pane's own border uses the
  host `focus` token.

This verification pass found that the live default theme's
`text.action.primary.focused` is a dark action-chip fill, not a white border
tone. `src/v2/tui/theme.ts` now derives `cardFocus` from the contrast tone
against the host panel (`contrastText(panel)`); the regression test
`theme.test.ts` "card focus is the highest-contrast tone, not the host action
fill" pins the dark and light cases. The exact ANSI codes above are the live
evidence; `theme.test.ts` is the pure evidence.

## Lifecycle long-run (fake host)

`npm run test:live:lifecycle` uses the fake provider's
`fake-lease-hold` stream (170 lines at 700 ms per 24-character provider chunk,
about 5m40s). Results:

| Assertion | Evidence |
|---|---|
| Live lease kept working | At 70 s the status was `working` and `leaseUntil` moved `1794177522826 → 1794177582829`, proving the 20 s heartbeat. |
| Deadline separation | The old five-minute deadline passed while the run was still streaming; at 313.7 s the status was still `working`, never `failed` or `interrupted`. |
| Queue backlog | A second delivery sent immediately stayed `pending`, attempts `0`, after its own `deadlineAt` passed; it ran and replied only after the long turn finished. |
| Card persistence | The `LIFEAGENT` card and `WORK ACTIVE │ 2 groups · 2 active` header remained mounted at 70 s and past the deadline. |
| Completion | Both groups finished `replied`; HISTORY retained both cards; no `Reply interrupted.` or `FAILED` appeared. |
| Operator records | Doctor output and `logs:summary` had no false failure and no `task.stalled`; the script logs the live-seam skips below. |

### Documented live-seam skips

| Scenario | Why the live TUI seam is skipped | Covered by |
|---|---|---|
| Late-success repair after a stalled/retrying row | No public live RPC can inject a stalled row plus a pre-existing reply without editing durable storage; the long-run route never stalls while its lease is live. | `service.test.ts` `ticket169: incident replay — a pending deadline, existing reply, late success, and 18-character placeholder`, `ticket169: a successful retry repairs the interrupted placeholder and logs task.recovered`, `ticket169: a lease-loss requeue keeps retry evidence and the late answer repairs`; `stream-settlement.test.ts` late-success cases. |
| Genuine host interruption | The fake host cannot interrupt a native stream in a way the service distinguishes from a controlled stop without host hooks. The live controlled stop is verified (`CANCELLED`), and the service/TUI interruption rules are pure. | `stream-settlement.test.ts` `ticket169: a genuine host interruption or native failure still interrupts a substantive reply`; `service.test.ts` `ticket169: a native failure still settles a substantive stream as interrupted`. |
| Stalled/retrying card labels | Reaching `stalled` requires exhausting delivery/lease attempts; no supported RPC seeds that terminal shape. The live run verifies the surrounding `working`/`pending`/`REPLIED` states and the controlled stop. | `service.test.ts` stalled child/retention/recovery cases; `workrows.test.ts` `ticket115`/`ticket144` labels; `workgroups.test.ts` stalled card persistence and section tone. |

## Multi-location regression

The unchanged driver creates four channels and eight agents, sends the
100-request mix, then runs the non-first-location ask_person probe and the
dispatch-budget relay after the measured path.

| Assertion | Result |
|---|---|
| Jobs sent | 100 |
| Job roots with a failure | 0 |
| Task rows | 137 (69 turn + 34 delegation + 34 handoff) |
| Outcomes / attempts | 137 succeeded / 137 replied; all at attempt 1 |
| `service.start` | 1 |
| `task.failed` / failure records | 0 / 0 |
| Warn-level TUI `feed.gap` lines | 1 (<5) |
| Tool probe | pass — ask_person approval resolved, task replied |
| Budget scenarios | pass — five-hop group, nine-hop continuation, 8-hop command-cap stop, 22 consumed rows |
| Doctor | 0 mismatches, all requested locations agree |
| Duplicate event/consumption | none; each hop has one `dispatch.hop.consumed` row |

## Latency probe

`ENSEMBLE_LATENCY_SAMPLES=4 ENSEMBLE_LATENCY_CARD_SAMPLES=3
npm run test:live:latency` (measurement only):

| Probe | Samples |
|---|---|
| Grouped rail `j`/`k` | min 8ms, p50 9ms, p95 12ms, max 12ms, mean 9.8ms (n=4) |
| Right-pane delegation card appearance | min 151ms, p50 161ms, p95 176ms, max 176ms, mean 162.7ms (n=3) |

These include tmux send/capture overhead and are not thresholds.

## Artifacts

Local artifacts (not committed; review before sharing):

- `/tmp/opencode/verification-177/fake/` — fake-suite artifacts, including
  `doctor.txt` (`Mismatches: none`), `log-summary.json`, and service/TUI logs;
  `fake-console.txt` holds the full output. The `fd` invocation count is
  asserted live from the wrapper; the wrapper file lives in the isolated run
  tree and is not copied.
- `/tmp/opencode/verification-177/sizes-console.txt` — full size-matrix output.
- `/tmp/opencode/verification-177/lifecycle/` — lifecycle artifacts (`doctor.txt`, `log-summary.json`, service/TUI logs); `lifecycle-console.txt` holds the full output.
- `/tmp/opencode/verification-177/latency-console.txt` — latency samples.
- `/tmp/opencode/verification-177/multilocation-console.txt` — driver, budget,
  doctor, and log-summary output.
- `/tmp/opencode/verification-177/empty-console.txt` — empty-catalog output.
- `/tmp/opencode/verification-177/verify-console.txt` — `npm run verify` output.

## Remaining limits

- The user's live host was not restarted; the real host-catalog and
  macOS/Herdr checks are post-merge follow-ups.
- The fake host uses deterministic fixtures and a fake provider; it proves the
  plugin/TUI/service seams, not a real model or a real native interruption.
- The narrow chat cell (59 content columns at 160×80) middle-elides the
  System Agent stage marks and truncates long skill-palette descriptions; the
  live checks assert the honest running/indeterminate text and move the palette
  flag to the front so the owner remains visible. The exact stage glyphs and
  token grammar stay unit-pinned.
- `fd` is required for the composer live checks; the fake scenario records an
  explicit skip if it is unavailable. The real scenario already skips without
  `fd`.
- No prototype source remains.
