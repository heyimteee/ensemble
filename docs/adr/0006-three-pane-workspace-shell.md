# ADR 0006: Three-pane workspace shell

- **Status:** Accepted
- **Date:** 2026-11-09
- **Tickets:** #166 (parent), #171, #172, #173, #174
- **Supersedes:** none
- **Related:** ADR 0005, ADR 0008, ADR 0009, `src/v2/tui/workpane.ts`, `src/v2/tui/railmodel.ts`, `src/v2/tui/workfocus.ts`, `src/v2/tui/workapprovals.ts`, `src/v2/tui/picker.ts`

## Context

The workspace shell had one flat rail, work rendered inside the chat column,
and approvals in a modal. Agent sublines repeated the workspace name, there was
no Homeless group, and the `o` binding guessed which native session to open.
Work competed with the transcript and composer for vertical space, could not
be filtered to active versus finished, and card navigation used uniform column
arithmetic that broke on group sections and pagination. The member wizard
rendered `name | role` without one label column, so separators did not align.

## Decision

1. **Three stable panes.**
   The root row is Rail | Chat | Work, each with its own border.
   `workspacePaneWidths` is the single width function consumed by the chat,
   layout, hit-testing, and tests; `workPaneBodyHeight` is the matching height
   function. `messageWidth` subtracts the rail and Work width and uses the same
   value as the transcript and composer. Breakpoints are ≥118 columns (full
   three panes), 96–117 (three panes with compact Work), and <96 (Work becomes
   a right drawer toggled by `Space b r`; ticket #183 made both column
   switches durable). The Work card design
   is unchanged; only container width/height and the focus border adapt.

2. **Rail is two panes, grouped by primary workspace.**
   The Agents pane groups by active workspace, then most recent membership,
   then `Homeless`; an agent appears exactly once and its subline is the role
   title only. A group header carries the workspace name, counts, and collapse
   state. `z` and a header click toggle collapse; `j`/`k` skip collapsed agents;
   collapse is durable UI state. The Workspaces pane keeps the directory label,
   unread/busy counts, paused marker, and active selection. One cursor walks
   the visible rows.

3. **Work is a filtered, paginated grid.**
   ACTIVE is the default and keeps only non-terminal tasks. HISTORY keeps
   terminal tasks, even while their group still has live work, so a group may
   appear in both views with disjoint cards. HISTORY groups order by latest
   finish descending and cards inside a group order by finish, newest first.
   The newest history group expands, older groups roll up, and a seen group
   keeps its row when later finishes reorder it. Pagination is pure and sized
   by the Work pane body; a group that spans pages repeats its header with
   `cont.`. Completed cards leave ACTIVE immediately and remain in HISTORY
   under the existing retention; the pane does not add a second retention
   policy. See [ADR 0008](0008-task-level-history-and-rollup.md); ticket #184
   replaced this ADR's original all-terminal-group contract.

4. **Spatial focus and honest actions.**
   The layout emits card rectangles; `nextWorkCard` selects the nearest card
   in a direction with perpendicular tie-breaking. `h`/`l` move within a row,
   `j`/`k` move rows, and `j`/`k` at a page edge auto-page while preserving
   the horizontal position. `gg`/`G` and `Ctrl+d`/`u` use the same geometry.
   Focus is stored by task id; updates, pagination, and filter changes keep it
   until the card disappears, then settle to the nearest prior position.
   `Enter` opens the result. `d`/`t`/`r`/`R`/`x`/`o` act on the focused card
   only when `workTaskActions` advertises them for the derived status. A
   pending retry/restart/cancel label is compared with the dispatch-time
   lifecycle signature and clears on the durable update, never on the RPC
   return alone. Focus movement changes only the selected prop; card data and
   tide state are not rebuilt.

5. **Focused white, unfocused grey.**
   The focused card uses the highest-contrast text token (`cardFocus`, white in
   the default theme). Unfocused cards use the subdued border grey. Pane focus
   remains a separate border state, so card focus and pane focus are visually
   distinct.

6. **Approvals are sticky, not modal.**
   Pending approvals render as a small summary pinned under Work, with the
   full-height right-column inbox opened by `v` or Enter from the small
   selection; Esc returns to split. The old chat modal and `V` overflow
   binding are retired. The focus cycle includes approvals only while pending.
   Update (#185): the right-column split/full surface replaced the original
   inline/overflow-only contract; see [implementation notes](../implementation.md#workspace-shell).

7. **One native-session decision per surface.**
   Group chat with chat focus, `o`: open a picker of workspace members showing
   name, role, leader, and busy state; Enter routes to that member's native
   session and Esc closes. Work focus, `o`: open the focused card's assignee
   directly. DM, `o`: the current agent session. A missing binding raises a
   clear message rather than a silent no-op. Under [ADR 0009](0009-conversation-identity-and-sessions.md),
   these are the workspace group and direct sessions respectively; the picker
   never substitutes one conversation's session for another.

8. **One label column.**
   `alignedDetailRows` computes one label width for the visible rows and
   renders padded label, separator, and detail. The member wizard and picker
   use it, with consistent truncation and the ASCII/Unicode separator fallback.

## Consequences

### Accepted trade-offs

- **Below 96 columns Work is a drawer.** The chat keeps a usable width rather
  than squeezing all three panes; one pane is temporarily covered.
- **HISTORY is not a second retention policy.** It reads the same task graph
  and the existing finished-work retention; the pane does not keep rows alive
  beyond the service's retention.
- **Focus is identity, not index.** A pruned or filtered card falls back to the
  nearest prior rectangle; a fresh view starts at the first card.
- **The rail is navigation only.** Collapse and selection are UI state; they do
  not change workspace membership or task state.
- **No new timers.** The existing one-shot Work invalidation timer remains the
  only clock for status, lease, retry, and hold transitions.

### Follow-up rules

- Do not add a second pane width or body-height helper.
- Do not rebuild cards or tide state when focus moves.
- Do not re-derive work status in the pane; consume `deriveWorkStatus`.
- Keep rail grouping, filtering, pagination, spatial navigation, and alignment
  pure and tested without mounting the TUI.
- Live size/visual evidence and the full five-minute scenario belong to #177.

## Validation

| Behavior | Test |
|---|---|
| Pane breakpoints, exact tiling, drawer right edge, Work content width, size matrix | `src/v2/tui/workpane.test.ts` |
| ACTIVE/HISTORY partitioning, ordering, page-split `cont.`, empty work | `src/v2/tui/workpane.test.ts` |
| Spatial navigation, page edges, half pages, focus settlement, card rectangles | `src/v2/tui/workfocus.test.ts` |
| Rail grouping, primary workspace, Homeless, collapse, visible rows | `src/v2/tui/railmodel.test.ts` |
| Focused white / unfocused grey, pane focus separation | `src/v2/tui/theme.test.ts`, `src/v2/tui/app-wiring.test.ts` |
| Inline approvals window, overflow, header grammar | `src/v2/tui/workapprovals.test.ts` |
| Native picker routing and missing-binding message | `src/v2/tui/picker.test.ts` |
| Aligned label/detail rows | `src/v2/tui/format.test.ts` |
| Work action policy and pending-label settlement | `src/v2/tui/workactions.test.ts` |
| Wiring of the shell into the page | `src/v2/tui/app-wiring.test.ts` |
