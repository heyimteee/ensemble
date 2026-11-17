---
title: Concepts
description: Learn the mental models behind Ensemble, from the three-pane shell to dispatch budgets and native sessions.
version: 0.1.x
---

# Concepts

Short, example-led explanations of how Ensemble works. Read this section when you
need to know who receives a message, why work is waiting, or what a budget
refusal means. Each page starts with what you see in the product, then explains
the model behind it.

The [domain glossary](../../GLOSSARY.md) is authoritative for definitions. The
[documentation style guide](../style-guide.md#canonical-terms) fixes the
user-facing term for each concept.

## Learning path

Read these pages in order on a first pass. Each one stands alone when you need a
single answer.

1. [The workspace shell](workspace-shell.md): the rail, chat, and Work panes,
   and how to move between them.
2. [Agents, workspaces, and the leader](agents-and-workspaces.md): reusable
   teammates, project spaces, and who receives an unaddressed message.
3. [Conversations and routing](conversations-and-routing.md): group chat versus
   direct chat, `$Name`, `@path`, and assignment.
4. [Turns and synthesis](turns-and-synthesis.md): what happens after a message
   arrives, through an agent turn and the leader's final answer.
5. [Work lifecycle](work-lifecycle.md): pending, working, waiting, retrying,
   needs you, replied, failed, stalled, and cancelled, plus ACTIVE and HISTORY.
6. [Dispatch budgets](dispatch-budgets.md): the command, group, task, and depth
   ceilings, with a worked example.
7. [Native sessions](native-sessions.md): where each agent actually runs, why
   conversations are isolated, and what "underneath" means.
8. [Skills](skills.md): reusable guidance, Skillboxes, and General-skill triage.
9. [Memory and approvals](memory-and-approvals.md): saved knowledge and the
   decisions that wait for you.
10. [Architecture overview](architecture.md): the server, TUI, durable state, and
    OpenCode host boundary.

## Find the answer

| Question | Page |
|---|---|
| What are the three panes? | [The workspace shell](workspace-shell.md) |
| Who is the leader, and what does leadership change? | [Agents, workspaces, and the leader](agents-and-workspaces.md) |
| Why did `$Name` create work in the group but not in a direct chat? | [Conversations and routing](conversations-and-routing.md) |
| Why did the command produce only one synthesis? | [Turns and synthesis](turns-and-synthesis.md) |
| What does a work item status mean? | [Work lifecycle](work-lifecycle.md) |
| Why was a continuation refused? | [Dispatch budgets](dispatch-budgets.md) |
| Why does an agent have more than one native session? | [Native sessions](native-sessions.md) |
| Who can use a skill? | [Skills](skills.md) |
| Why is work waiting for me? | [Memory and approvals](memory-and-approvals.md) |
| Where does state live, and what keeps running when I close the page? | [Architecture overview](architecture.md) |

## Next

- [Getting started](../getting-started/README.md): install Ensemble and reach a
  first group reply.
- [Guides](../guides/README.md): apply these concepts to a task.
- [Reference](../reference/README.md): look up exact commands, keys, tools, and
  settings.

## Go deeper

- [ADR index](../adr/README.md): every accepted architecture decision.
- [Implementation notes](../implementation.md): service, TUI, storage, and
  native-tool boundaries.
- [Evidence index](../contributing/evidence.md): verification records for the
  behavior described here.
