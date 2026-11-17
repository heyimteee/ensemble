---
title: Recipes
description: Apply Ensemble to a real workflow, with actors, prompts, Work signals, output, and pitfalls.
version: 0.1.x
---

# Recipes

A recipe is a worked example, not a new feature. Each one names the actors, the
prompts that start the work, the signals to watch in the Work pane, the output
to expect, and the mistakes that waste a command.

## Recipes

| Goal | Recipe |
|---|---|
| Run two independent research tracks and combine the results | [Run parallel research](parallel-research.md) |
| Review one change through separate correctness, security, and test lenses | [Run a multi-agent code review](multi-agent-code-review.md) |
| Turn an issue into a scoped implementation ticket | [Turn an issue into a ticket](issue-to-ticket.md) |
| Give one agent a skill without exposing it to the team | [Use an agent-scoped skill](agent-scoped-skills.md) |

## Before you start

- Complete the [quickstart](../../getting-started/quickstart.md) and
  [first team](../../getting-started/first-team.md). You need a workspace, a
  leader, and at least two members.
- Give every agent a main model. A recipe that names an agent without a model
  cannot produce a result.
- Read [Conversations and routing](../../concepts/conversations-and-routing.md)
  for `$Name` and `@path`, and
  [Dispatch budgets](../../concepts/dispatch-budgets.md) for the ceilings a
  recipe can hit.
- Open the workspace group chat for multi-agent work. A direct chat stays
  one-to-one and never routes a mention to another agent.

## How to use a recipe

1. Read **Actors** and **Before you start** and adjust the synthetic names to
   your own roster.
2. Copy an **Example prompt** into the group composer with `i`, then press
   `Enter`. Replace `<placeholders>` before you send it.
3. Follow **What to watch in Work** while the work runs. Open a native session
   with `o` when a result needs inspection.
4. Compare the result with **Expected result**. If it differs, read **Pitfalls**
   before you retry.
5. Use **Next** to continue to the neighboring task or the exact reference page.

## Expected result

Each recipe produces visible work items, a durable answer in the group chat, and
a finished history you can inspect. You can name the actor behind each result and
the Work state it passed through.

## Next

- [Run parallel research](parallel-research.md): the first multi-agent recipe.
- [Guides](../README.md): the single-agent task guides behind these recipes.
- [Concepts](../../concepts/README.md): the mental model for actors and Work.
