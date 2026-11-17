---
title: Your first team
description: Choose a leader, delegate one piece of work, and open the native session behind it.
version: 0.1.x
---

# Your first team

Turn the quickstart workspace into a working team: check who is a member,
confirm the leader, delegate one piece of work, and inspect the native session
that produced the answer.

## Before you start

- The [quickstart](quickstart.md) is complete: you have a workspace with
  `Nova` and `Rook`, and one finished group reply.
- Read [Concepts](../concepts/README.md) if you have not worked with a group
  chat before.

## Check membership and the leader

The workspace leader receives every message that has no `$Name`. Leadership
adds no permissions; it changes who answers unaddressed messages.

1. Press `h` to focus the rail.
2. Move to the `#acme-notes` workspace and press `e`.
3. On **Workspace members**, press `Space` to toggle a member. Keep both
   members selected, then press `Enter`.
4. On **Workspace leader**, choose the member who should receive unaddressed
   messages, then press `Enter`.
5. On **Leader synthesis**, choose whether the leader combines child replies
   into one final answer, then press `Enter`.

Expected toast:

```text
#acme-notes updated.
```

The group chat is the workspace conversation. Selecting an agent in the rail
opens a direct chat instead; a direct chat never routes a `$Name` mention to
another teammate.

## Delegate the first piece of work

You can ask the leader to split a piece of work, or address one member
directly.

1. Open `#acme-notes` and press `i` to focus the composer.
2. Send a request that has two independent parts, for example:

   ```text
   Check the project for missing documentation. Have Rook review the docs for
   broken internal links, and then combine the findings into one short list.
   ```

3. Press `Enter`.

The leader answers or delegates. A delegation creates a visible work item with
the recipient, the typed brief, and the expected answer. If the leader answers
by itself, ask again with an explicit recipient:

```text
$Rook check the docs for broken internal links and report the top five.
```

`$Name` sends work only in a group chat; a bare name is a reference. `@path` is
reserved for workspace files and never routes work.

## Watch the Work pane

The Work pane shows dispatch groups, not a separate work queue.

1. Press `l` to select Work, then `Enter` to enter it.
2. Move between items with `j`/`k` or `h`/`l`, and page with `j`/`k` at the
   edges.
3. Press `f` to switch between ACTIVE and HISTORY.
4. On the focused item, use `d` to delegate, `t` to reassign, `r` to retry, `R`
   to restart, `x` to cancel, or `o` to open the assignee's native session.

Work states are literal: `WORKING` means the agent is executing, `NEEDS YOU`
means an approval or decision is waiting, `REPLIED` means the answer arrived,
`FAILED` means the native execution errored, and `STALLED` means delivery or
the lease failed. A failed or stalled item stays visible until you retry,
cancel, or dismiss it.

## Open a native session

A native session is the OpenCode session where the agent actually runs and its
tool activity is visible.

- From Work: focus the item and press `o`.
- From the group chat: press `o`, then choose the workspace member.

`F2` returns to Ensemble, and the group transcript stays where it was. A direct
chat has its own work history and native session; it does not share the group
session.

## Expected result

The workspace has two members and one leader. Your delegation produced a work
item for `Rook`, the group chat contains the final answer, and `o` opened the
native session with the tool activity behind it. Press `?` to see the full key
catalog at any point.

## Troubleshooting

| Symptom | What to do |
|---|---|
| The leader answers without delegating | Name the recipient with `$Rook`, or ask for two explicit parts and a final synthesis. |
| A delegation is refused for budget reasons | The command or group dispatch budget is spent. Start a new command, or review the workspace limits with `:limits`. |
| A work item shows `NEEDS YOU` | Open it and resolve the approval; dependent work stays paused until you decide. |
| `FAILED` and `STALLED` look the same | `FAILED` is a native execution error. `STALLED` is a delivery or lease problem. Retry first; if it repeats, use the [incident runbook](../support/incident-runbook.md). |
| The native session does not open | Move to Work with `l`, press `Enter`, focus the item, then press `o`. |

## Next

- [Concepts](../concepts/README.md): work items, dispatch budgets, and native
  sessions in depth.
- [Guides](../guides/README.md): the Work pane, approvals, settings, and
  routing.
- [Reference](../reference/README.md): every command, key, and setting.
