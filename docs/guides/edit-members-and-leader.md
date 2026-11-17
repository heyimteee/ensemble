---
title: Edit members and the leader
description: Change who belongs to a workspace and who receives unaddressed group messages.
version: 0.1.x
---

# Edit members and the leader

Membership and leadership are workspace settings. Changing them does not create
a new workspace and does not move conversation history.

## Before you start

- The workspace exists and you can select it in the rail.
- The agents you want to add already exist in the roster.
- Read [Agents, workspaces, and the leader](../concepts/agents-and-workspaces.md)
  for the difference between the leader role and permissions.

## Steps

1. Select the workspace row in the rail and press `e`.
   The workspace wizard opens on **Workspace members**. It edits membership,
   leadership, and synthesis; it does not rename the workspace.

2. Use `j`/`k` to move and `Space` to add or remove a member. Press `Enter` to
   continue.
   Removing a member takes the agent out of this workspace's group chat. Its
   direct chat remains available.

3. On **Workspace leader**, choose a member from the selected list and press
   `Enter`. If you removed the current leader, choose a replacement here.

4. On **Leader synthesis**, keep or change the setting, then submit the final
   step.

## Expected result

- The rail regroups each agent under its primary workspace.
- The next group message with no `$Name` goes to the new leader.
- Added members gain a group chat in the workspace. Removed members lose the
  group conversation but keep their direct chat and their history.
- Ensemble rewrites `.ensemble/config.json` and refreshes the generated roster
  when the workspace has been initialized.
- Existing conversations and work items keep their assignees and history.

## Troubleshooting

- **"Choose a leader from the selected members."** The leader must be a member.
  Select the intended leader again in the member step, then choose it as leader.
- **An added agent still shows under another workspace.** The rail groups each
  agent once under its primary workspace. Select the agent to confirm it also
  has a chat in this workspace.
- **A removed agent still shows group history.** Membership controls new group
  access and routing. Stored transcripts and Work history are not rewritten.

## Next

- [Route messages](route-messages.md): address a member or the leader.
- [Configure an agent](configure-an-agent.md): change its role, models, and
  Skillbox.
- [Use the Work pane](use-the-work-pane.md): follow the work a new leader
  creates.
- [Configuration reference](../reference/configuration.md): exact workspace
  membership fields.
