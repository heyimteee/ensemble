# Guides

Task-shaped walkthroughs for daily use. Each guide states what you need before
you start, the steps to take, the result you should see, and where to go next.
Use [Concepts](../concepts/README.md) when you need the mental model and
[Reference](../reference/README.md) when you need exact behavior.

## Set up your team

| Task | Guide |
|---|---|
| Create agents, then bind them to a project workspace | [Create a workspace and agents](create-workspace-and-agents.md) |
| Change members or the leader | [Edit members and the leader](edit-members-and-leader.md) |
| Add the generated `AGENTS.md` block and `.ensemble` metadata | [Initialize a workspace](initialize-a-workspace.md) |

## Work day to day

| Task | Guide |
|---|---|
| Send a group or direct message, use `$Name`, or reference a file with `@path` | [Route a group or direct message](route-messages.md) |
| Assign and invoke reusable guidance | [Use a skill](use-skills.md) |
| Focus and page through work, then delegate, reassign, retry, restart, cancel, or open a native session | [Use the Work pane](use-the-work-pane.md) |
| Resolve the sticky summary or the full approvals inbox | [Resolve an approval](resolve-approvals.md) |

## Configure and protect

| Task | Guide |
|---|---|
| Set identity, main and backup models, Skillbox, and save behavior | [Configure an agent](configure-an-agent.md) |
| Add, edit, delete, or promote saved knowledge | [Manage memory](manage-memory.md) |
| Choose a recovery backup or data export, then restore or roll back | [Back up or restore](back-up-or-restore.md) |

## Operator procedures

These existing pages cover recovery and upgrade paths:

| Task | Guide |
|---|---|
| Back up or restore durable state | [Backup and restore](../operations/backup-restore.md) |
| Upgrade from a prerelease | [Upgrade](../operations/upgrade.md) |
| Reverse a package or state upgrade | [Package rollback](../operations/rollback.md) |
| Recover a broken workspace or stuck work | [Incident runbook](../support/incident-runbook.md) |
| Find a key by context | [Keyboard reference](../../README.md#keyboard) |
| Understand the leader, work, and budgets before delegating | [Concepts](../concepts/README.md) |

## Recipes

Recipes apply Ensemble to a real workflow. Each recipe states the goal, the
actors, example prompts, what to watch in the Work pane, expected output, and
pitfalls. Start with the [recipe index](recipes/README.md), or go straight to a
workflow:

| Workflow | Recipe |
|---|---|
| Split one research question across two agents and combine the findings | [Run parallel research](recipes/parallel-research.md) |
| Review one change through separate correctness, security, and test lenses | [Run a multi-agent code review](recipes/multi-agent-code-review.md) |
| Turn an issue into a scoped implementation ticket | [Turn an issue into a ticket](recipes/issue-to-ticket.md) |
| Use one agent's skill without leaking it to the team | [Use an agent-scoped skill](recipes/agent-scoped-skills.md) |

## Writing a guide

Follow the [page template](../style-guide.md#page-template). Lead with the task,
keep one action per step, show expected output where it matters, and end with
the next guide. Put architecture decisions and verification records behind a
**Go deeper** link, not in the steps.

## Next

- [Reference](../reference/README.md): exact tools, commands, and settings.
- [Support](../support/README.md): what to include when a guide does not resolve
  the problem.
