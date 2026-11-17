---
title: Use an agent-scoped skill
description: Assign a skill to one agent's Skillbox and invoke it without leaking the guidance to the rest of the team.
version: 0.1.x
---

# Use an agent-scoped skill

Use this recipe when a skill belongs to one agent's job. The Skillbox scopes the
guidance to that agent, and the composer routes an invocation to the owner rather
than to the whole team.

## Goal

Run one task with a skill assigned to exactly one agent, confirm the right agent
owns the turn, and leave every other agent's Skillbox unchanged.

## Actors

- **You**: choose the owner, invoke the skill, and check the result.
- **Linus**: the skill owner and assignee.
- **Nova (leader)**: receives a General skill for triage when no owner is
  assigned.
- **Grace**: a team member who must not receive the skill or its output.

## Before you start

- The host reports a skill catalog. An empty catalog means there is nothing to
  assign yet.
- The owner agent exists and belongs to the workspace.
- You know which agent should own the skill. An assigned skill is usable only by
  its owner.
- Read [Skills](../../concepts/skills.md) for Skillbox ownership and General
  skills, and [Use a skill](../use-skills.md) for the exact settings keys.
- Open the workspace group chat for a normal invocation. A direct chat accepts
  only that agent's assigned skills.

## How it runs

1. Select **Linus** in the rail and press `s`.
2. Press `l` until the **Skillbox** tab is active. Press `/` to filter the
   catalog, move with `j`/`k`, and press `Space` to assign the skill.
3. Press `s` to save and close settings. The header stops showing **UNSAVED**.
   An unsaved draft does not change the agent.
4. Open the workspace group chat, press `i`, and type `$Linus /`. The palette
   shows only Linus's assigned skills. Choose one.
5. Finish the request and press `Enter`. Linus receives the exact message text
   with the skill request, and one work item is created for Linus.
6. Open Linus's work item and press `o` to confirm the native session loaded the skill
   and produced the result.

For a General skill with no owner, type `/` at the start of the message in the
workspace group chat. The leader receives it for triage. A direct chat rejects a
General skill because only the group chat can reach the leader.

## Example prompts

Owner-scoped invocation:

```text
$Linus /release-notes Draft the 0.2.0 notes from the merged changes on main.
Group the entries under Added, Changed, Fixed, and Breaking. Cite the change or
pull request for each entry, and leave out anything you cannot verify.
```

General skill with leader triage:

```text
/research-brief Compare the two queue options in @docs/architecture.md. Return
one brief with sources, assumptions, and the strongest counterargument.
```

Direct chat with the owner's own skill:

```text
/release-notes Draft the notes for the change described in @CHANGELOG.md. Do not
use a skill assigned to another agent.
```

Follow-up after an incomplete result:

```text
$Linus /release-notes the notes are missing the Fixed section. Re-read the merged
changes since the last tag and add only verified fixes. Keep the existing format.
```

## What to watch in Work

- **One work item for Linus.** A skill does not create one work item per skill.
  Multiple skills for the same agent become one prompt and one work item.
- **The assignee is the owner.** If a different agent receives the work item, the
  skill was invoked without the owner scope or the owner picker chose another
  member.
- **No work item for Grace.** Another agent must not receive a copy of the skill or
  the task. A work item for Grace means the message addressed Grace instead.
- **The draft stays after a rejection.** An unknown skill, a stale assignment, a
  wrong owner, or a direct-chat General skill rejects the whole message before a
  transcript line or work item exists.
- **One prompt per unique agent.** Up to eight skills can appear in one message.
  Additional mentions of the same agent collapse into the same prompt.
- **Native session evidence.** Press `o` to see the skill the agent loaded and
  the tool activity behind the answer.

## Expected result

- Only Linus's Skillbox contains the skill; Grace's Skillbox is unchanged.
- `$Linus /` shows the owner's assigned skills and nothing from another agent.
- The group chat creates one work item for Linus, and Linus's native session
  loads the skill.
- A General skill reaches the leader for triage, not a random member.
- The exact message text remains the prompt body; Ensemble adds routing, not a
  rewritten request.

## Pitfalls

- **The Skillbox was not saved.** An unsaved draft changes nothing. Press `s`
  and confirm the header is clean before invoking.
- **The catalog moved.** A skill removed from the host catalog remains rejected
  even if the Skillbox still names it. Remove the stale assignment and reopen the
  palette.
- **A General skill is sent to a non-leader.** Mention the leader, use the
  message start, or open the workspace group chat. The message is rejected
  atomically.
- **A direct chat is used for a General skill.** General skills need leader
  triage, so they belong in the group chat.
- **The wrong owner is chosen.** `$Agent /` filters to that agent's Skillbox.
  The owner picker and the assignee on the work item must agree.
- **The message names too many skills for one agent.** At most eight skills fit
  in one request, and they become one prompt. Split the request if you need a
  second turn.
- **`@` is used to address an agent.** `@path` is a workspace file reference. It
  never routes work and never selects a skill.
- **A skill is treated as a tool permission.** A skill is guidance. Host tool
  permissions and approvals still apply.

## Next

- [Configure an agent](../configure-an-agent.md): edit models, backups, and the
  Skillbox in one place.
- [Use a skill](../use-skills.md): the single-agent assignment and invocation
  steps.
- [Skills](../../concepts/skills.md): ownership, General triage, and atomic
  validation.
- [Use the Work pane](../use-the-work-pane.md): inspect the turn a skill starts.
- [Recipes](README.md): the other workflows.
