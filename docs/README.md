---
title: Ensemble documentation
description: Install Ensemble, learn the mental model, complete tasks, and look up exact behavior.
version: 0.1.x
---

# Ensemble documentation

Ensemble is a persistent agent team inside OpenCode: one group chat, named
agents, visible work, and each agent's native session underneath. These docs
help you install it, learn the mental model, complete common tasks, and look up
exact behavior.

**Version scope:** stable `0.1.x`, current **v7 roster contract**. Verified on
OpenCode **2.2.6**, **2.2.7**, and **2.3.0** on Linux/tmux, with Node 22.23.4
or newer. Prerelease history lives in the [changelog](../CHANGELOG.md), not in a
separate docs tree.

## See it in motion

<TerminalHero
  src="/media/hero-terminal.cast"
  poster="/media/workspace-shell.png"
  poster-alt="The Ensemble three-pane workspace in the synthetic Acme Notes fixture: agents in the rail, a working Ada card in Work, and a group message in chat."
  caption="A scripted replay of the isolated synthetic fixture. The install command is illustrative; the workspace, message, Work card, and native session were captured from the local host."
  title="Ensemble terminal replay: install, launch, group message, Work card, and native session"
/>

The replay covers the stable install command, `/ensemble`, a group message, the
Work card, and the native session underneath. Read the
[quickstart](getting-started/quickstart.md) for the same path as copyable steps,
or the [workspace shell](concepts/workspace-shell.md) for the pane model.

## Start here

| I want to… | Start with |
|---|---|
| Install Ensemble and get a first reply | [Getting started](getting-started/README.md) |
| Understand agents, workspaces, and routing | [Concepts](concepts/README.md) |
| Finish a task in the app | [Guides](guides/README.md) |
| Look up a command, key, tool, or setting | [Reference](reference/README.md) |
| Back up, upgrade, or recover an install | [Operations](operations/README.md) |
| Fix an install, work, timeout, or model failure | [Troubleshooting](support/troubleshooting.md) |
| Check install tags, platform limits, and diagnostics | [FAQ](support/faq.md) |
| Find support, recovery, security, and privacy in one place | [Operations and support](support/operations.md) |
| Assess security or privacy | [Security](security/README.md) or [Privacy](privacy/README.md) |
| Get help or report a problem | [Support](support/README.md) |
| Contribute code or documentation | [Contributing](contributing/README.md) |

## Learning paths

### New users

1. Read [What is Ensemble?](getting-started/what-is-ensemble.md) and check the
   [support matrix](support/support-matrix.md) before you install on an
   unverified host.
2. Follow [Install](getting-started/install.md) for the stable `0.1.0` package.
3. Complete the [Quickstart](getting-started/quickstart.md): two agents, one
   workspace, one message, and one finished work item.
4. Continue with [First team](getting-started/first-team.md) to delegate work
   and open a native session.
5. Use [Upgrade](getting-started/upgrade.md) when you move from a prerelease.

### Daily users

1. Learn the shared language in [Concepts](concepts/README.md) and the
   [domain glossary](../GLOSSARY.md).
2. Use [Guides](guides/README.md) for routing, the Work pane, approvals, and
   settings.
3. Keep the [keyboard reference](../README.md#keyboard) open while you work.
4. Look up exact behavior in [Reference](reference/README.md) when a guide is not
   enough.

### Team leads

1. Read [Concepts](concepts/README.md) for the leader, group chat, turns, work
   items, and dispatch budgets.
2. Follow [Guides](guides/README.md) to create a workspace, add members, and
   delegate work.
3. Look up exact limits and commands in [Reference](reference/README.md) when a
   delegation is refused or an agent stops.
4. Review [support and operations](support/README.md) before asking a team to
   depend on the preview.

### Operators

1. Start at [Operations](operations/README.md) for backup, restore, upgrade, and
   rollback.
2. Read [Scale, soak, and local diagnostics](operations/scale-and-monitoring.md)
   for the tested envelope and evidence collection.
3. Use the [incident runbook](support/incident-runbook.md) when a workspace is
   broken, work is stuck, or data may be lost.
4. Follow the [support policy](support/README.md) and
   [support matrix](support/support-matrix.md) before filing.

### Contributors

1. Start with [Contributing](contributing/README.md),
   [CONTRIBUTING.md](../CONTRIBUTING.md), and [AGENTS.md](../AGENTS.md).
2. Read the [documentation style guide](style-guide.md) before adding or moving a
   page.
3. Update the [redirect map](redirects.md) when navigation changes.
4. Find architecture decisions and verification evidence in the
   [evidence index](contributing/evidence.md), reached through the contributing
   hub.

### Security reviewers

1. Start at [Security](security/README.md) for the threat model, permission
   review, and accepted risks.
2. Read [Privacy](privacy/README.md) for data classes, retention, export, and
   delete.
3. Follow the private reporting process in [SECURITY.md](../SECURITY.md). Never
   put a vulnerability in a public issue.

## Documentation sections

| Section | Covers |
|---|---|
| [Getting started](getting-started/README.md) | Install, first run, quickstart, and the first team |
| [Concepts](concepts/README.md) | Agents, workspaces, leader, conversations, turns, work items, budgets, native sessions, skills, memory, and approvals |
| [Guides](guides/README.md) | Task-shaped walkthroughs and recipes |
| [Reference](reference/README.md) | Tools, commands, keyboard, configuration, environment, files, CLI, and supported hosts |
| [Operations](operations/README.md) | Backup, restore, upgrade, rollback, release operations, and diagnostics |
| [Security](security/README.md) | Threat model, permission review, and accepted risks |
| [Privacy](privacy/README.md) | Data classes, retention, export, and delete |
| [Support](support/README.md) | Support policy, troubleshooting, FAQ, incident runbook, support matrix, and known limitations |
| [Contributing](contributing/README.md) | Development workflow, docs process, ADRs, and verification evidence |

Operations, security, privacy, and support are user-facing sections. ADRs,
verification records, implementation notes, and assessments are public
engineering evidence: they stay linked from the [contributing hub](contributing/README.md)
and its [evidence index](contributing/evidence.md), not from the primary user
navigation.

## About these docs

- [Documentation style guide](style-guide.md): voice, terminology, page
  template, code samples, and visual rules.
- [Redirect map](redirects.md): where entries from the old documentation index
  moved.
- [Domain glossary](../GLOSSARY.md): the authoritative definitions behind the
  canonical terms.
- [Changelog](../CHANGELOG.md): stable and prerelease history.

`npm run docs:check` validates the page inventory and frontmatter, internal
links and anchors, Markdown and shell fences, the current contract, host, and
Node claims, generated-reference freshness, and the docs site build. It also
keeps every docs section reachable from this home and requires every current
verification record to be linked from the evidence index.
