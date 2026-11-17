---
title: What is Ensemble?
description: Decide in one minute whether a persistent agent team inside OpenCode fits how you work.
version: 0.1.x
---

# What is Ensemble?

Ensemble is a persistent agent team inside OpenCode: you and a group of named
agents share one chat, a leader routes the work, and every agent's native
session stays inspectable underneath.

## Who this is for

You already use OpenCode and you split work across research, review,
implementation, and follow-up. You want those steps to share one conversation
and one visible queue instead of separate sessions.

## The problem

One OpenCode session is one conversation. When work needs several
perspectives, you either serialize it through one agent or open more sessions
and copy context between them. Neither option shows who owns which piece, what
is still running, or why something stopped.

Ensemble adds the missing shared space. The group chat is the shared record, the
leader receives unaddressed messages and decides whether to answer or delegate,
and the Work pane keeps every unit of work visible until it reaches a terminal
state.

## What you get

| Surface | What it shows |
|---|---|
| Agents and workspaces | Your roster grouped by workspace, plus a separate Workspaces list. A workspace is one project directory. |
| Group chat | The shared transcript. An unaddressed message goes to the leader; `$Name` addresses a teammate; `@path` references a workspace file. |
| Direct chat | A private conversation with one agent. Work and history are scoped to that conversation. |
| Work pane | Work items in ACTIVE and HISTORY, with states such as WORKING, WAITING, NEEDS YOU, REPLIED, FAILED, and STALLED. |
| Native session | The OpenCode session where an agent runs. Press `o` on a work item to inspect it; `F2` returns to Ensemble. |

The shell has three panes: the rail on the left, the conversation in the middle,
and Work on the right. Below 118 columns it compacts; below 96 columns Work
becomes a right drawer.

## What Ensemble is not

- **Not a hosted service.** Ensemble runs in your OpenCode installation with
  your providers and files. It has no telemetry.
- **Not a model.** Agents use the models OpenCode reports.
- **Not a replacement for OpenCode.** It is one plugin inside the host. The
  native prompt, host commands, and host permissions remain authoritative.
- **Not a permission system.** An approval is a team decision and cannot
  override OpenCode's tool permissions.
- **Not a Windows product.** Linux/tmux is the supported path in `0.1.x`.

## A first look

With the plugin installed, open Ensemble with `/ensemble` or the **Open
Ensemble** palette command. Before you create a workspace, the header reads:

```text
ENSEMBLE │ no workspace
```

That empty state is the starting point for the [quickstart](quickstart.md).

## Next

- [Install](install.md): add the stable `0.1.0` package.
- [Quickstart](quickstart.md): create two agents, a workspace, and a first
  message.
- [Concepts](../concepts/README.md): go deeper on the leader, work items,
  dispatch budgets, and native sessions.
