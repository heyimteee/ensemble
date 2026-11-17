# Guides

Task-shaped walkthroughs for daily use. Each guide states what you need before
you start, the steps to take, the result you should see, and where to go next.
Use [Concepts](../concepts/README.md) when you need the mental model and
[Reference](../reference/README.md) when you need exact behavior.

## Current guides

These existing pages cover the most requested operator and usage paths:

| Task | Guide |
|---|---|
| Back up or restore durable state | [Backup and restore](../operations/backup-restore.md) |
| Upgrade from a prerelease | [Upgrade](../operations/upgrade.md) |
| Reverse a package or state upgrade | [Package rollback](../operations/rollback.md) |
| Recover a broken workspace or stuck work | [Incident runbook](../support/incident-runbook.md) |
| Find a key by context | [Keyboard reference](../../README.md#keyboard) |
| Understand the leader, work, and budgets before delegating | [Concepts](../concepts/README.md) |

## Daily-use guides

These task pages follow the same shape: prerequisites, steps, expected result,
and next link. Until each one exists, the [root README feature
overview](../../README.md#what-it-does), the [keyboard
reference](../../README.md#keyboard), and [Concepts](../concepts/README.md) are
the current sources for:

- Create, edit, archive, and delete a workspace or agent.
- Add members, choose a leader, and move an agent between workspaces.
- Send a group message, address one agent with `$Name`, and reference a file
  with `@path`.
- Use the Work pane: focus, page, delegate, reassign, retry, restart, cancel,
  and open a native session.
- Resolve the sticky approval summary and the full approvals inbox.
- Configure models, backup models, skills, and memory.
- Initialize workspace files and understand the generated `AGENTS.md` block.
- Export or delete workspace data.

## Recipes

Recipes apply Ensemble to a real workflow. Each recipe will state the goal, the
actors, example prompts, what to watch in the Work pane, expected output, and
pitfalls. Planned recipes:

- Parallel research with a leader and two researchers.
- Multi-agent code review with separate reviewers.
- Turn a GitHub issue into an implementation ticket.
- Use an agent-scoped skill without leaking it to the team.

## Writing a guide

Follow the [page template](../style-guide.md#page-template). Lead with the task,
keep one action per step, show expected output where it matters, and end with
the next guide. Put architecture decisions and verification records behind a
**Go deeper** link, not in the steps.

## Next

- [Reference](../reference/README.md): exact tools, commands, and settings.
- [Support](../support/README.md): what to include when a guide does not resolve
  the problem.
