# ADR 0008: Task-level history and sticky rollup

- **Status:** Accepted
- **Date:** 2026-11-09
- **Tickets:** #178 in `heyimteee/ensemble`; implementation #184, native cards #187
- **Supersedes:** the history decision in [ADR 0006](0006-three-pane-workspace-shell.md) decision 3
- **Related:** ADR 0006, ADR 0007, `src/v2/tui/workpane.ts`, `src/v2/tui/workgroups.ts`, `src/v2/work-groups.ts`

## Context

ADR 0006 treated HISTORY as a whole-group view: only all-terminal groups
appeared, ordered by latest finish, with tasks chronological inside a group. A
group could appear in only one view. That contract made finished work wait for
its siblings and hid a finished card while the rest of its dispatch group was
still running.

Ticket #184 changed the partition to tasks. Ticket #187 then added read-only
native subagent cards to the same groups, so history had to order two card
kinds together. A group can now move to the top of HISTORY when a previously
collapsed group receives a later finish; the old newest-first expansion rule
would have opened it and moved the page.

## Decision

### 1. Partition tasks, not groups

ACTIVE keeps every non-terminal task; HISTORY keeps every terminal task, even
when its group still has live work. A group may appear in both views with
disjoint cards. Group labels still report the group's full active/done counts,
so the rollup can say `N done · M active` while the group is busy.

### 2. Order groups by finish and cards by finish

HISTORY groups order by their latest terminal finish, newest first. A native
subagent's finish counts like a task finish. Cards inside a HISTORY group order
by finish, newest first, across tasks and native subagent cards, with the start
time and id as stable tie-breakers. ACTIVE keeps its task-then-native order;
this decision only changes HISTORY card order.

### 3. One sticky expansion state

`reconcileHistoryView` resolves `expanded` for every seen group and stores
`manual` only for explicit user choices:

- a never-seen group at index 0 expands;
- a seen group keeps the row it rendered last time, so a collapsed group that
  a later finish promotes to index 0 stays collapsed and shows `fresh`;
- a former auto-expanded newest rolls up when a newer group arrives;
- a manual Enter choice always wins.

`fresh` is set when a collapsed group's done count increases and clears when
the group expands or is dismissed. The page and focus settlement never follow
a collapsed group that moved pages.

### 4. Dismissal is a view filter

`x` hides one history group and `D` clears the view with confirmation. Both are
bounded durable UI state (`ui.dismissedHistoryGroups`), not task deletion.
Terminal rows remain in the snapshot and under the existing 24h retention.

### 5. Native subagent cards are history work

A finished native subagent card moves to HISTORY with its parent group and
participates in card ordering. It remains read-only: `o`/Enter open the child
native session, and it never becomes a queue row, consumes a hop, or offers
retry/cancel.

## Consequences

### Accepted trade-offs

- **Two views may show one group.** ACTIVE and HISTORY are disjoint by card,
  not by group, so a user can see the same group label twice with different
  content.
- **Sticky rows can stay closed at the top.** A promoted group keeps its
  previous collapsed state; the `fresh` marker and updated count signal the
  new finish instead of a page jump.
- **Age is computed once.** `paginateWorkGroups` derives the finish with
  `workHistoryFinishedAt` and the label consumes the resulting age, so the
  pane and the rollup cannot disagree.

### Follow-up rules

- Do not partition HISTORY by whole-group terminality.
- Do not reorder ACTIVE cards; only HISTORY mixes tasks and native cards.
- Do not add a second finish or age helper; use `workHistoryFinishedAt` and
  `ageLabel`.
- Do not drop dismissed groups from durable task state; dismissal filters the
  view.

## Validation

| Behavior | Test |
|---|---|
| Task-level ACTIVE/HISTORY partition and group overlap | `src/v2/tui/workpane.test.ts` |
| Group order by latest finish and mixed HISTORY card order | `src/v2/tui/workpane.test.ts` |
| Newest expands, promoted collapsed group stays collapsed and fresh, manual override | `src/v2/tui/workpane.test.ts` |
| Rollup label grammar and one age source | `src/v2/tui/workgroups.test.ts`, `src/v2/tui/format.test.ts` |
| Live history rollup, dismiss, and page edges | `docs/verification/2026-11-09-pane-interaction.md` |

## References

- Issue #178, #184, #187
- [ADR 0006: Three-pane workspace shell](0006-three-pane-workspace-shell.md)
- [Implementation notes](../implementation.md#workspace-shell)
