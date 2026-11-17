---
title: Route a group or direct message
description: Send work to the leader, name an agent with $Name, and reference a workspace file with @path.
version: 0.1.x
---

# Route a group or direct message

A workspace group chat is shared. A direct chat is one-to-one. The address you
use decides who receives the message and which conversation holds the resulting
work.

## Before you start

- A workspace has at least one member and a leader.
- Read [Conversations and routing](../concepts/conversations-and-routing.md) for
  the routing grammar and conversation channels.

## Steps

1. Select the workspace in the rail and press `i` to focus the composer.

2. Type a message with no `$Name` and press `Enter`.
   The leader receives the message and either answers or coordinates the work.

3. To address one agent in the group, type `$`, choose the agent, and finish the
   message. Press `Enter`.
   That agent receives a peer turn. The leader does not receive the command. A
   bare name without `$` is only a reference. `!Name` is an accepted alias.

4. To address several agents, include each `$Name` in one message.
   Each unique named agent receives one work item. Duplicate mentions collapse.

5. To reference a workspace file, type `@` and choose the file from the
   workspace index. Finish the message and press `Enter`.
   The composer inserts the escaped workspace-relative path, such as
   `@docs/notes.md`, and the reference is appended to the instruction. `@` is
   for files only; it never addresses an agent or a skill.

6. To write a literal dollar sign, type `\$`. To talk about an agent without
   creating work, write the bare name or put it in code formatting.

7. To work with one agent privately, select that agent in the rail and send the
   message from its direct chat.
   Only that agent answers. A `$Name` in a direct chat creates no work and shows
   a notice that direct chat stays one-to-one.

## Expected result

- A group message without a mention creates a leader turn and a work item for
  the leader.
- A group message with mentions creates one work item per named member.
- A direct message creates work only in that direct chat. Its Work history is
  separate from the workspace group.
- Agent references inside fenced code, inline code, URLs, and file paths do not
  route. This lets agents discuss names without assigning work.

## Troubleshooting

- **Your draft stays and an unknown agent is named.** The message was rejected
  before a transcript line or work item existed. Pick an existing workspace
  member.
- **A bare name created no work.** That is a reference, not a route. Add `$`.
- **A direct chat ignores `$Name`.** Open the workspace group chat or the named
  agent's own direct chat instead.
- **A file reference is missing.** Check that the file is inside the workspace
  and the index has refreshed. The picker indexes workspace files, not files
  outside the workspace directory.

## Next

- [Use skills](use-skills.md): route reusable guidance to its owner.
- [Use the Work pane](use-the-work-pane.md): follow the work you created.
- [Conversations and routing](../concepts/conversations-and-routing.md): read
  why code and URLs never route.
- [Keyboard reference](../reference/keyboard.md#group-chat-and-direct-conversation):
  exact chat and composer bindings.
