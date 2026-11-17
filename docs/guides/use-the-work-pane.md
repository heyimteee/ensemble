---
title: Use the Work pane
description: Focus and page through work items, switch ACTIVE and HISTORY, and act on the focused work item.
version: 0.1.x
---

# Use the Work pane

The Work pane is the right column's view of the conversation's work items. It
shows what is live in **ACTIVE** and what finished in **HISTORY**, and it offers
only the actions the focused work item can run.

## Before you start

- A workspace group or direct chat is open.
- At least one message has created work, or you are ready to send one.
- Read [Work lifecycle](../concepts/work-lifecycle.md) for the status words and
  [Dispatch budgets](../concepts/dispatch-budgets.md) for the budget label.


<DocsFigure
  src="/media/work-active.png"
  alt="Work pane in ACTIVE view showing one dispatch group and an ADA work item marked WORKING, with hops 0/8 and cmd 24 left."
  caption="ACTIVE holds queued and running work. The work item shows the assignee, status word, and dispatch budget; press f to switch to HISTORY."
  width="1400"
  height="800"
/>

<DocsFigure
  src="/media/work-history.png"
  alt="Work pane in HISTORY view with three rolled-up finished groups; the newest group is expanded to a REPLIED ADA work item."
  caption="HISTORY rolls older groups up to one row and expands the newest finished group. Press Enter to expand or collapse a group; press D to clear the view without deleting rows."
  width="1400"
  height="800"
/>

## Steps

1. Press `Tab` until **Work** is selected, then press `Enter` to enter Work
   interaction. The pane opens on **ACTIVE**.
   Each work item shows the assignee, status word, and a budget label such as
   `hops 3/8 · cmd 21 left` when the width allows.

2. Move between work items with `h`/`j`/`k`/`l`. Use `gg`/`G` for the first or last
   work item, `Ctrl+d`/`Ctrl+u` for a half page, and `PageUp`/`PageDown` for a page.
   When focus reaches an edge, the same direction pages instead of stopping.

3. Press `f` to switch between **ACTIVE** and **HISTORY**.
   ACTIVE holds queued, working, waiting, retrying, needs-you, and stalled work.
   HISTORY holds replied, failed, and cancelled work. A dispatch group can
   appear in both views with different work items.

4. Press `Enter` on a focused work item to open its durable result when it has one.
   In HISTORY, `Enter` also expands or collapses a finished group. `D` clears
   the history view; that dismissal is a display choice, not deletion.

5. Press `d` to delegate. Choose the recipient, confirm the work item title, and
   edit the instruction, then submit.
   A child work item appears in the same dispatch group, and the parent work item
   reads **WAITING** while the child runs.

6. Press `t` to reassign. Choose another member.
   The existing work item changes assignee. The conversation and workspace
   membership do not change, and the work item keeps its history.

7. Press `r` to retry a failed, stalled, retrying, or cancelled work item.
   The item returns to the queue and then runs again. Use retry when the work
   should start from the same instruction after a transient problem.

8. Press `R` to restart any non-replied work item. The row is requeued with a
   **Restarting work** notice in the transcript.
   Use restart when you want the same item to run again from a clean stopped
   state, including while it is working, waiting, or waiting for you.

9. Press `x` to cancel the focused work item.
   The work item shows **Cancelling…** until the durable update lands, then
   **CANCELLED** and leaves ACTIVE. Cancelling closes stale approvals for that
   work. It does not refund a hop already spent.

10. Press `o` to open the assignee's native session for the focused work item. Press
    `F2` to return to Ensemble.
    A focused native-subagent work item opens that child session instead.

## Expected result

- ACTIVE and HISTORY show the same durable Work rows, split by status.
- A delegated child appears under its parent, and the parent waits for it.
- Reassign changes only the assignee. Retry and restart requeue the same row.
- Cancel ends the run and leaves the work item in HISTORY.
- The native session opens in OpenCode, not inside the Ensemble panes.

## Troubleshooting

- **A key does nothing.** The work item advertises only valid actions. Replied work items
  are read-only, and retry is absent until a work item is retrying, stalled, failed,
  or cancelled.
- **A work item stays in ACTIVE as STALLED.** Stalled is not terminal. Retry,
  restart, or cancel it.
- **A work item shows a budget ceiling.** A continuation or delegation can be
  refused when a command, group, task, or depth ceiling is reached. See
  [Dispatch budgets](../concepts/dispatch-budgets.md).
- **"No native session" appears.** The assignee has no binding for this
  conversation yet. Send one message in that conversation, then try `o` again.

## Next

- [Resolve approvals](resolve-approvals.md): decide the work that waits for you.
- [Work lifecycle](../concepts/work-lifecycle.md): read each status in detail.
- [Native sessions](../concepts/native-sessions.md): understand what `o` opens.
- [Keyboard reference](../reference/keyboard.md#work-list): exact Work-list
  bindings.
