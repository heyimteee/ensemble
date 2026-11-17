---
title: Getting started
description: Choose the install, quickstart, first-team, and upgrade path for a new installation.
version: 0.1.x
---

# Getting started

Install Ensemble, open the workspace, and reach your first group reply with a
small agent team. The automated packed-install smoke completes this path in about
half a minute; a person's install and model latency will differ.

## Before you install

- **Host:** OpenCode 2.2.6, 2.2.7, or 2.3.0 on Linux with tmux. macOS with Herdr
  is verified on OpenCode 2.2.7 only. Windows is out of scope.
- **Node:** 22.23.4 or newer.
- **Package:** `@heyimteee/ensemble`, installed as one OpenCode plugin. Do not
  also load the same package from `.opencode/plugins/`; a duplicate plugin ID
  breaks the workspace.

Check the [support matrix](../support/support-matrix.md) for the platform
boundary and known limitations before you start.

## The path

| Step | Page | You will |
|---|---|---|
| 1 | [What is Ensemble?](what-is-ensemble.md) | Decide whether the three-pane team model fits how you work. |
| 2 | [Install](install.md) | Add the stable `0.1.1` package, verify the plugin list, and open `/ensemble`. |
| 3 | [Quickstart](quickstart.md) | Create two agents and a workspace, send one message, and see a work item finish. |
| 4 | [First team](first-team.md) | Choose a leader, delegate the first piece of work, and open an agent's native session. |
| 5 | [Upgrade](upgrade.md) | Move from a prerelease to stable `0.1.1`, or roll back. |

## If a step fails

Start with the troubleshooting section on the page you are on, then read
[Troubleshooting](../support/troubleshooting.md) for install, plugin, workspace,
work, native-turn, and model symptoms. If the symptom is not listed, read the
[support policy](../support/README.md) before filing an issue, and use the
[incident runbook](../support/incident-runbook.md) for a broken workspace, stuck
work, or suspected data loss.

## Next

- [Concepts](../concepts/README.md): understand who receives a message and why
  work is waiting.
- [Guides](../guides/README.md): finish real work.
- [Reference](../reference/README.md): look up a key, command, or setting.
