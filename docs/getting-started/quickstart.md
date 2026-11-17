---
title: Quickstart
description: Go from a fresh install to a first group reply and a finished work item in about ten minutes.
version: 0.1.x
---

# Quickstart

Install the stable `0.1.0` package, create two agents and a workspace, send one
message, and watch the work item finish. The example uses an `acme-notes`
workspace with two synthetic agents, `Nova` and `Rook`.

## Before you start

- OpenCode 2.2.6, 2.2.7, or 2.3.0 on Linux with tmux, and Node 22.23.4 or
  newer.
- A project directory you can open in OpenCode.
- At least one provider and model configured in OpenCode. The agent wizard reads
  the model list from the host.
- The plugin installed. If it is not, follow [Install](install.md) first.

## Step 1: Install and verify

```sh
opencode plugin add @heyimteee/ensemble@0.1.0
opencode plugin list
```

Expected entry:

```text
ensemble.v2  0.1.0  @heyimteee/ensemble@0.1.0
```

If the entry is missing, restart OpenCode and run `opencode plugin list` again.

## Step 2: Open Ensemble

Restart OpenCode, then run `/ensemble` or the **Open Ensemble** palette command.
With no workspace yet, the header reads:

```text
ENSEMBLE │ no workspace
```

## Step 3: Create the first agent

A workspace needs at least one member, so create the agents before the
workspace.

1. Press `h` to focus the rail, then `a` to open the agent wizard.
2. Enter the agent name `Nova` and press `Enter`.
3. Enter a short title, for example `Research`, and press `Enter`.
4. Enter a role, for example `You research project material and summarize it.`,
   and press `Enter`.
5. Skip the optional memories step with `Enter`.
6. Choose a main model from the host list and press `Enter`. If a reasoning
   effort step appears, choose one and press `Enter`.

Expected toast, and a direct chat opens:

```text
Nova created. Opening a direct chat.
```

## Step 4: Create the second agent

1. Press `h` to return to the rail, then `a`.
2. Name the agent `Rook`, give it a title such as `Review`, and write a role such
   as `You review changes and report risks.`
3. Skip memories, choose the main model, and confirm.

Expected toast:

```text
Rook created. Opening a direct chat.
```

Both agents appear in the rail under Homeless until they join a workspace.

## Step 5: Create the workspace

1. Press `h` to return to the rail, then `n`.
2. On **Workspace directory**, choose **Use current directory** for the project
   you opened, or choose **Type a path…** and enter another directory. Press
   `Enter`.
3. On **Workspace name**, enter `acme-notes` and press `Enter`.
4. On **Workspace members**, press `Space` on `Nova` and `Space` on `Rook` so
   both are selected, then press `Enter`.
5. On **Workspace leader**, choose `Nova` and press `Enter`.
6. On **Leader synthesis**, choose `Yes — let the leader synthesize` and press
   `Enter`.

Expected toast:

```text
#acme-notes created.
```

Ensemble then offers to move each agent's no-workspace direct chat into the
workspace. Answer `y` to both prompts:

```text
Move Nova into #acme-notes?
Move Rook into #acme-notes?
```

## Step 6: Send the first message

The workspace is now active and the group chat is selected.

1. Press `i` to focus the composer.
2. Type `Summarize what this project is for in three bullets.`
3. Press `Enter`.

The message goes to the leader because it has no `$Name`. Nova answers in the
group chat, and the reply streams in before it settles as Markdown.

## Step 7: Watch the Work pane

While the turn runs, the Work pane shows one active group:

```text
WORK ACTIVE │ 1 group · 1 active · 0 done │ page 1/1
```

When the turn finishes, the work item moves from `WORKING` to `REPLIED` and
settles into HISTORY.

1. Press `l` to select the Work pane, then `Enter` to enter it.
2. Press `f` to switch between ACTIVE and HISTORY.
3. In HISTORY, press `Enter` on the rolled-up group to expand it, focus the
   finished work item, and press `o` to open Nova's native session.
4. Press `F2` to return to Ensemble.

## Expected result

You have one workspace, two agents, and one group reply. The Work pane has a
`REPLIED` work item, and `o` opens the native session that produced it. The
next page turns this into a working team: [First team](first-team.md).

## Troubleshooting

| Symptom | What to do |
|---|---|
| The agent wizard says no models are available | Configure a provider and model in OpenCode, then reopen the wizard. The list refreshes from the host. |
| The workspace wizard rejects the members step | Select at least one member with `Space` before you continue. |
| The leader step has no options | The leader must be one of the members selected in the previous step. Go back with `N` and select a member. |
| The work item stays QUEUED | Confirm the workspace is not paused and that the agent has a model. If it stays stuck, use the [incident runbook](../support/incident-runbook.md). |
| `o` does not open a native session | Focus the work item first with `j`/`k`, then press `o`. On a group chat, `o` asks which member's session to open. |

## Next

- [First team](first-team.md): choose a leader, delegate work, and inspect a
  native session.
- [Concepts](../concepts/README.md): learn why unaddressed messages reach the
  leader.
- [Guides](../guides/README.md): apply Ensemble to a real workflow.
