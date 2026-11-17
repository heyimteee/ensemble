---
title: Create a workspace and agents
description: Build a first team by creating agent profiles, then binding them to a project workspace with a leader.
version: 0.1.x
---

# Create a workspace and agents

Create at least one agent before you create a workspace. A workspace needs one
member and one leader, so the agents come first.

## Before you start

- Ensemble `0.1.1` is open in OpenCode. See
  [Getting started](../getting-started/README.md).
- OpenCode reports at least one model. The agent wizard cannot finish without a
  main model.
- You know the project directory the workspace will use.
- Read [Agents, workspaces, and the leader](../concepts/agents-and-workspaces.md)
  if the roster, membership, or leader role is new to you.

## Steps

1. Select an agent or the **Agents** section in the rail, then press `a`.
   The new-agent wizard opens on **Agent name**.

2. Type a unique name and press `Enter`.
   Names are case-insensitive and must differ from every active agent.

3. Type a short title and press `Enter`, then type a role and press `Enter`.
   The title is the label beside the agent; the role describes how it works and
   what it owns. The role is required.

4. On **Agent memories**, press `a`, type one memory, and press `Enter`. Repeat
   for each entry, then press `Enter` on the list to continue.
   This step is optional. An empty list skips it cleanly.

5. Choose the main model with `j`/`k` and `Enter`. If the model has variants,
   choose a reasoning effort on the next step.
   The model list comes from OpenCode. If it is empty, fix the host's provider
   configuration and reopen the wizard.

6. Submit the final step.
   The new agent appears under **Homeless** and its direct chat opens. The agent
   now exists even though it has no workspace yet.

7. Press `n` in the rail to create a workspace.
   The workspace wizard opens on **Workspace directory**.

8. Choose the project directory, or choose **Type a path…** and type it.
   One canonical directory belongs to one active workspace.

9. Type a workspace name and press `Enter`.

10. On **Workspace members**, use `Space` to toggle every agent that should
    join, then press `Enter`. At least one member is required.

11. On **Workspace leader**, choose one selected member and press `Enter`.
    The leader receives every group message that names no agent.

12. On **Leader synthesis**, choose whether child replies should combine into
    one final leader answer. Submit the step.

## Expected result

- The workspace opens on its group chat, and the rail lists it under
  **Workspaces**.
- Each selected agent now appears under the workspace as its primary workspace.
- Ensemble writes `.ensemble/config.json`. Run init when you want the generated
  team contract and roster block in `AGENTS.md`.
- If a member had a home direct chat with no workspace, Ensemble asks whether to
  move that chat into the new workspace. Either choice keeps the agent usable.

## Troubleshooting

- **"Choose at least one member."** Create an agent first, then rerun the
  workspace wizard.
- **"A workspace already exists for this directory: <name>."** Open the existing
  workspace instead of creating a second one for the same directory.
- **"No models are available."** Check the OpenCode provider and model list, then
  reload the host.

## Next

- [Edit members and the leader](edit-members-and-leader.md): change the team
  after creation.
- [Route messages](route-messages.md): send the first group or direct message.
- [Configure an agent](configure-an-agent.md): add backups, skills, and settings.
- [Configuration reference](../reference/configuration.md): exact workspace and
  settings fields.
