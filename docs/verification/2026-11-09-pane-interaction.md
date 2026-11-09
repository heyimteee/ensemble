# Pane interaction verification: select/interact shell, history, activity, and approvals (#186)

Status: **verified locally on Linux/tmux; unit suite, full fake suite, size matrix, multi-location, empty-catalog fake suite, and latency probe pass; the real-host run is a post-merge step because the live host still runs `main`**
Date: 2026-11-09
Issue: [#186](https://github.com/heyimteee/ensemble/issues/186)
Spec: [#178](https://github.com/heyimteee/ensemble/issues/178)
Tickets: [#180](https://github.com/heyimteee/ensemble/issues/180), [#181](https://github.com/heyimteee/ensemble/issues/181), [#183](https://github.com/heyimteee/ensemble/issues/183), [#184](https://github.com/heyimteee/ensemble/issues/184), [#185](https://github.com/heyimteee/ensemble/issues/185)
ADRs: [0006](../adr/0006-three-pane-workspace-shell.md)
Base: `integration/workspace-interaction` at `3c65604` (includes #180/#181/#183/#184/#185/#187, #188, and #189)
Branch: `verify/pane-interaction`
Worktree: `/home/tristan/dev/ensemble-186`
Final merge commit: `a33059a` (verified tree)

This record is the release evidence for the pane-interaction delivery:

- One select/interact state machine owns every move: `h`/`l`/`j`/`k`
  choose a pane, `Enter` enters it, `Esc` returns to selection, chat `Enter`
  is transcript navigation, `i` is composer entry, and `h` from chat reaches
  Agents first.
- Every pane uses the same focused white / unfocused grey contract, including
  the separate `AGENTS (n)` and `WORKSPACES (n)` sections, chat, Work, and
  approvals. ANSI capture proves the selected heading/border (`38;5;255`)
  against the subdued border (`38;5;238`), muted heading (`38;5;140`), and
  faint heading (`38;5;8`).
- `Space b l` / `Space b r` are the only column switches, pane visibility is
  durable across a TUI restart, closing a focused column returns focus to
  chat, reopening selects the column without entering content, and `F3` is
  retired.
- HISTORY partitions tasks, so one group can appear in ACTIVE and HISTORY with
  disjoint cards. A never-seen newest group expands, a former auto-expanded
  newest rolls up, a collapsed group promoted by a later finish stays collapsed
  with a `fresh` marker, older groups are compact rollups, `Enter` expands, `x`
  dismisses, `D` clears the view, and `h`/`l` cross page edges. HISTORY cards
  order by finish, newest first, across task and native subagent cards.
- Chat keeps one aggregate activity line (`Asking $Name…`, `Working…`, and the
  `+N more` overflow) with the Work pane open; no per-agent row returns.
- Approvals are only the right column's small summary and full-height inbox.
  `v`/Enter open full, `Esc` returns to split, the left footer and chat modal
  are gone, and `V` is retired. Full approvals also works in the 80×24 drawer.
- Verification found and fixed four focus/scroll defects with regression
  tests: entering Workspaces left the rail cursor on an agent, closing Settings
  dropped a chat interaction back to selection, the host leader layer fired
  top-level `l` before a pending `Space b` prefix resolved (and the which-key
  popup clipped its body), and a former auto-expanded HISTORY group never
  rolled up.

The full fake suite ran on commit `00ed668`, the pane-interaction content
immediately before the final `3c65604` (#189) merge. `npm run verify`, the size
matrix, multi-location, latency, and the empty-catalog suite ran on the merged
tree `a33059a`; #189 touches service/session continuity, not the pane shell.

## Environment

| Item | Value |
|---|---|
| OS | Debian GNU/Linux 13 (trixie), Linux 6.12.115+deb13.1-amd64 x86_64 |
| Terminal host | tmux 3.5a |
| Node | v26.12.1 |
| npm | 12.2.1 |
| OpenCode (fake harness) | `opencode v2.2.6` |
| Live service host | `main`; **not restarted or reconfigured** |
| Worktree plugin | `/home/tristan/dev/ensemble-186` at the verification commit |
| macOS/Herdr | Not available; not run |
| Hosted CI | Not run |

## Commands and results

| Command | Result |
|---|---|
| `npm run verify` | **Pass** — strict type check; **1530 tests passed, 0 failed, 0 skipped, 0 todo**, 47.7 s. |
| `ENSEMBLE_LIVE_REQUIRE=1 npm run test:live:fake` (`ENSEMBLE_LIVE_ARTIFACTS=/tmp/opencode/artifacts-186-fake`) | **Pass on `00ed668`** — full fake scenario including the #180/#181/#183/#184/#185 pane-interaction checks, doctor, and log summary. 53 `live:` lines; artifacts under `/tmp/opencode/artifacts-186-fake`. |
| `ENSEMBLE_LIVE_REQUIRE=1 npm run test:live:sizes` | **Pass** — 80×24, 100×30, 120×40, and 160×50, `NO_COLOR=1`, the CPU/load probe, pane heading/border colours, drawer durability/F3 removal, drawer full-approvals geometry, and page-edge `j`/`k`/`h`/`l`. Console copy under `/tmp/opencode/artifacts-186-sizes/console.log`. |
| `ENSEMBLE_LIVE_REQUIRE=1 npm run test:live:multilocation` | **Pass** — 100/100 jobs, 137/137 task rows succeeded, one `service.start`, 0 `task.failed`, 0 failure records, 1 warn-level `feed.gap`, the fake `ask_person` tool probe approved and replied, and doctor `Mismatches: none`. Artifacts under `/tmp/opencode/artifacts-186-multi`. |
| `npm run test:live:fake:empty` | **Pass** — empty model catalog, agent wizard empty-state, init routing, and solo guard. Console copy under `/tmp/opencode/artifacts-186-empty/console.log`. |
| `npm run test:live:latency` | **Pass** (measurement only) — rail `j`/`k` min 9 ms, p50 9 ms, p95 12 ms, max 12 ms (n=10); delegation card min 190 ms, p50 1940 ms, p95 1956 ms, max 1956 ms (n=5). Console copy under `/tmp/opencode/artifacts-186-latency/console.log`. |
| Real host-catalog matrix (`npm run test:live` / `test:live:all`) | **POST-MERGE** — the live host runs `main`; the host was not restarted or reconfigured |
| `git diff --check` | **PASS** |
| Prototype source check | **PASS** — no prototype files in the tree or diff |

## Focus-state matrix

The pure matrix is pinned by `src/v2/tui/panefocus.test.ts`; the live checks
exercise every visible combination at 160×80 and the 80×24 drawer.

| Pane | Select | Interact | Closed |
|---|---|---|---|
| Agents | `h` from chat; white heading/border; `h/l column` | `Enter`; row cursor; `enter open` | `Space b l`; focus returns to chat; no `AGENTS (` |
| Workspaces | `j` from Agents; white `WORKSPACES`; Agents grey | `Enter`; workspace row cursor; `enter open` | closed with the left column |
| Chat | `l` from the left column; white title; `enter enter` | `Enter` transcript navigation; `j/k scroll` | chat is never closable |
| Composer | `i` from chat | `INSERT │ COMPOSER` | `Esc`/`Ctrl+G` returns to chat |
| Work | `l` from chat; `h/l column` | `Enter`; card cursor; `j/k cards` | `Space b r`; focus returns to chat |
| Approvals (small) | `j` from Work; `APPROVALS 1 pending │ enter open` | `Enter` opens full inbox | last row resolved or right column closed |
| Approvals (full) | `Esc` from full returns to the small selection | `j/k move`, `Enter resolve`, `esc split` | `Esc` closes to split; right-column close hides it |

## ANSI evidence

Captured with `tmux capture-pane -e -p -J` and decoded by the harness. The
focused pane heading and border are white; unselected panes keep the border,
muted, or faint tone.

| State | Heading/border | Captured SGR |
|---|---|---|
| Agents selected | `AGENTS (n)` + section border | white `38;5;255` |
| Agents selected | `WORKSPACES (n)` + section border | faint `38;5;8` / border grey `38;5;238` |
| Chat selected | chat title + chat border | white `38;5;255` |
| Chat selected | Work header + Work border | muted `38;5;140` / grey `38;5;238` |
| Work selected | `WORK ACTIVE` + right border | white `38;5;255` |
| Work selected | chat title + chat border | muted `38;5;140` / grey `38;5;238` |
| Approvals selected | `APPROVALS 1 pending` + right border | white `38;5;255` |
| Approvals unfocused | small `APPROVALS 1 pending` + top border | muted `38;5;140` / grey `38;5;238` |
| Work cards | focused card border | white `38;5;255`; neighbours `38;5;238` |

## Space b, F3, and durable visibility

| Check | Evidence |
|---|---|
| Which-key submenu | `Space b` shows `LEADER │ which-key │ Space b`, `Toggle the left pane`, `Toggle the right pane`, and the status hints `l left │ r right`; `Esc` cancels. |
| Left toggle | `Space b l` closes the left column, chat reclaims the width, and focus recovers to chat; reopening selects Agents in select mode. |
| Right toggle | `Space b r` closes Work, focus recovers to chat; reopening selects Work in select mode. |
| F3 retired | With Work closed, `F3` leaves `WORK ACTIVE` absent and does not steal focus. |
| Durable | Closing both columns survives a TUI restart; both remain closed and chat owns the narrowed shell; reopening selects each column in select mode. |
| 80×24 drawer | The drawer starts open, `Space b r` closes/reopens it, `F3` does nothing, and the closed drawer survives a restart. |

## HISTORY, activity, and approvals

| Area | Live evidence |
|---|---|
| Task-level split | A two-task dispatch group keeps its live card in ACTIVE (`1 group · 1 active · 1 done`) while its cancelled card is in HISTORY (`1 group · 1 active · 1 done`). |
| Newest expanded | With two finished groups, the newest renders `▾ GROUP 1 · 1 done` and its card; the older renders `▸ GROUP 2 · 1 done` with no card. |
| Rollup/expand | A former auto-expanded newest rolls up when a newer group arrives; `G` + `Enter` expands the older row and reveals its card. |
| Dismiss/clear | `x` dismisses the focused group and persists `ui.dismissedHistoryGroups`; `D` asks, clears the view to `WORK HISTORY │ none yet`, and terminal task rows remain in the snapshot. |
| Page edges | At 160×50, `l` on the last page-one card moves to page two and `h` on the page-two card returns to page one; `j`/`k` keep their existing page edges. |
| Activity summary | With live work and the Work pane open, chat shows one `Working…` line and later one `Asking $FakeAgent…` line; no `│ working…` per-agent row is rendered. |
| Approvals small/full | A pending ask shows `APPROVALS 1 pending │ v open` under Work; Enter from the small selection opens `APPROVALS 1 pending │ 1/1` full height, Work is hidden, `Esc` returns to split. |
| Retired surfaces | The rail slice contains no `APPROVALS` footer; `V` no longer opens a chat approvals modal; `v` opens the right-column inbox from chat. |
| Drawer approvals | At 80×24, `v` opens the full-height inbox in the drawer (`APPROVALS 0 pending`), Work is covered, the heading is white, and `Esc` returns to split. Pending resolution is exercised at 160×80; pending-in-drawer is listed as a skip below with unit-seam layout evidence. |

**Workspace-scoped approvals.** The inbox deliberately filters pending approvals
to the active workspace (`approvalsForWorkspace`), so one workspace cannot see
or resolve another workspace's decisions. Spec #178 did not ask for that
boundary; it is a safety decision and is covered by the pure approvals tests.

**Pending approvals in the 80×24 drawer (unit seam).** The live size matrix
does not hold a pending approval in the populated drawer fixture, so no live
80×24 pending pass is claimed. The width-independent layout is covered by
`src/v2/tui/workapprovals.test.ts`: at `workspacePaneWidths(80)`
(`workWidth ≥ 30`), split geometry keeps a positive Work body and a positive
small-approval row budget, and full geometry gives `workBodyHeight = 0` with a
positive inbox row budget (`approvalRows ≥ 2` at `workPaneBodyHeight(24)`).
The 160×80 live checks cover pending split/full/open/resolve and the Esc
return; only the pending-in-drawer combination is a unit-only seam.

## Size matrix

`npm run test:live:sizes` restarted the isolated fake TUI at each approved
size with a fresh five-group/six-task fixture and checked the shell before the
fixture started (so the hold tasks stay active through every functional probe).

| Size | Result |
|---|---|
| 80×24 | Drawer starts open; `Space b r` closes/reopens; `F3` does nothing; closed drawer survives restart; five compact rows, page edge to `page 2/2`, whitespace drawer full approvals, `NO_COLOR` untouched by this size. |
| 100×30 | Three panes, compact Work rows, group labels, budget, focus, page indicator, exact right edge, white focused / grey unfocused pane headings and borders. |
| 120×40 | Same compact contract at the middle breakpoint. |
| 160×50 | Three panes, five groups/six tasks in two-column cards over two pages, `hjkl`, `gg`/`G`, `j`/`k` and `h`/`l` page edges, right edge, white/grey card and pane focus. |
| `NO_COLOR=1` | 120×40 restart keeps frame-0 glyphs and the state word; no animated frame appears. |

The load probe recorded idle TUI CPU 6.7% and 16.7%, 21.1%, and 26.7% for
one, two, and three working cards; those numbers are observations, not
thresholds.

## Latency measurement

| Probe | Samples (ms) | Summary |
|---|---|---|
| Agents rail cursor `j`/`k` | 9, 9, 9, 9, 9, 12, 9, 10, 9, 9 | min 9, p50 9, p95 12, max 12, mean 9.4 (n=10) |
| Delegation card appearance | 190, 1956, 1953, 1931, 1940 | min 190, p50 1940, p95 1956, max 1956, mean 1594.0 (n=5) |

The first card sample measured a warm path; later samples include the full
patch/repaint path. These are measurements, not pass/fail thresholds.

## Multi-location

`npm run test:live:multilocation` kept one service (`serviceStarts: 1`) across
the measured run: 100/100 jobs, 137/137 task rows succeeded on attempt 1, 0
`task.failed`, 0 failure records, and one warn-level `feed.gap`. The fake
`ask_person` tool probe created a real pending approval, resolved it, and the
linked task ended `replied/succeeded`. The dispatch-budget relay and doctor
finished with `Mismatches: none`.

## Product fixes found by verification

| Defect | Fix | Regression test |
|---|---|---|
| Entering Workspaces left the row cursor on an agent, so the next Enter opened a DM. | Mark the section cursor move as deliberate in `ensureRailSectionCursor`. | `app-wiring`: a rail pane entry claims the row cursor. |
| Closing Settings from chat interaction returned to pane selection. | Restore the prior pane select/interact mode. | `app-wiring`: settings restore keeps the mode. |
| A pending `Space b` prefix still let the host leader layer run top-level `l` (limits). | Disable the host leader layer while a prefix is pending; the raw key machine resolves the submenu. | `app-wiring`: pending prefix yields the host layer. |
| The which-key popup allocated two border rows but not the header, clipping its body. | Height is `lines + 3`. | `app-wiring`: popup row budget. |
| A former auto-expanded newest HISTORY group stayed expanded when a newer group arrived. | Track explicit user expansion separately; only manual choices persist, otherwise the newest group owns the default expansion. | `workpane.test`: former auto-expanded newest rolls up; user-expanded older group stays open. |

## Skips

- **Pending approvals in the 80×24 drawer** are not automated in the size
  matrix: the populated size fixture queues the ask behind its active tasks.
  The width-independent pending split/full/resolve path passes at 160×80, and
  the 80×24 drawer proves the same full-height surface, white heading,
  Work-covered layout, and split return on the empty inbox. The unit seam adds
  positive split/full row budgets at the drawer width (see the unit-seam note
  above); no live 80×24 pending pass is claimed. Manual evidence is the
  `/tmp/opencode/artifacts-186-sizes/console.log` drawer section.
- **Workspace-scoped approvals** are intentional, not a skipped cross-workspace
  check: another workspace's pending rows are filtered out by design and the
  boundary is covered by `approvalsForWorkspace` tests. Cross-workspace
  leakage would be a defect, not a missing capability.
- The real host-catalog matrix is **post-merge**: the user's live host runs
  `main` and was not restarted or reconfigured. This is an environment limit,
  not a skipped assertion.
- macOS/Herdr behavior is unavailable on this Linux/tmux host; the existing
  platform checklist remains manual.
- The harness records transient states that the fake provider cannot hold
  deterministically (for example the single resolving frame) as unit-seam
  evidence; the live checks cover the durable before/after states.
