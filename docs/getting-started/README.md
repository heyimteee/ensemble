# Getting started

Install Ensemble, open the workspace, and reach your first group reply with a
small agent team.

## Before you install

- **Supported host:** OpenCode **2.2.6**, **2.2.7**, or **2.3.0** on Linux/tmux.
  The installed macOS/Herdr path is verified on 2.2.7 only. Windows is out of
  scope.
- **Node:** 22.23.4 or newer.
- **Package:** `@heyimteee/ensemble`, installed as one OpenCode plugin. Do not
  load the same package from `.opencode/plugins/` as well; duplicate plugin IDs
  break the workspace.

Check the [support matrix](../support/support-matrix.md) for the current
platform boundary and known limitations before you start.

## Install and first run

The stable install path is maintained in the [root README](../../README.md#install).
It covers:

1. Adding the plugin with `opencode plugin add @heyimteee/ensemble@0.1.0`.
2. Opening Ensemble with `/ensemble` or the **Open Ensemble** palette command.
3. The single-plugin rule and when to reload or restart OpenCode.
4. Installing from a local checkout for development.

The [requirements](../../README.md#requirements) and [keyboard
reference](../../README.md#keyboard) describe the verified runtime and the first
keys to try.

## First team

A first team needs one workspace, two agents, and one unaddressed group message:

1. Create a workspace bound to a project directory.
2. Create two agents; new agents start with no workspace.
3. Add both agents to the workspace and choose a leader.
4. Open the workspace group chat and send a message without `$Name`.
5. Watch the leader answer or delegate, and confirm the resulting work item in
   the Work pane.

For the mental model behind each step, read the [concepts
index](../concepts/README.md). When the first group turn completes, the Work
pane shows a work item for the agent that ran it; press `o` on the focused item
to open that agent's native session.

## What belongs here

- Install and upgrade instructions for the stable package.
- A ten-minute quickstart with expected output.
- The first workspace, agent, membership, leader, message, and Work card.
- Links to troubleshooting when a step fails.

## Next

- [Concepts](../concepts/README.md): understand who receives a message.
- [Guides](../guides/README.md): finish a real task.
- [Support](../support/README.md): get help without posting private data.
