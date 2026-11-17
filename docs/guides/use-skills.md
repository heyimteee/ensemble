---
title: Use a skill
description: Assign a Skillbox and invoke reusable guidance so it reaches the right agent.
version: 0.1.x
---

# Use a skill

A skill is reusable guidance, not a tool permission. Assign optional skills to
one agent's Skillbox, then invoke a skill explicitly in a message.

## Before you start

- The workspace has at least one member, and the host reports a skill catalog.
- You know which agent should own the skill.
- Read [Skills](../concepts/skills.md) for Skillbox ownership and General-skill
  triage.

## Steps

1. Select the agent in the rail and press `s`, then press `l` until the
   **Skillbox** tab is active.

2. Press `/` to filter the catalog, move with `j`/`k`, and press `Space` to
   assign or unassign the focused skill.

3. Press `s` to save and close settings.
   Only a saved Skillbox changes the agent. An unsaved draft changes nothing.

4. Open the workspace group chat, press `i`, and type `/` at the start of the
   message. Choose a skill from the palette.
   The palette flags each row as `Command`, `Skill | General`, or
   `Skill | <Owner>`.

5. Finish the request and press `Enter`.
   An assigned skill goes to its owner. If the owner is not the leader, follow
   the owner choice the composer offers. A General skill goes to the leader for
   triage.

6. To target one agent's Skillbox explicitly, type `$Agent /` and choose from the
   filtered palette.
   This shows only that agent's assigned skills. A message can invoke at most
   eight skills; multiple skills for one agent become one turn.

## Expected result

- The addressed agent receives the exact message text with the skill request.
- One prompt per unique addressed agent is created; Ensemble does not add a
  work item for each skill.
- An assigned skill is usable only by its owner. A General skill is handled by
  the leader, even when you name no agent.
- A direct chat accepts only that agent's assigned skills. A General skill
  requires the workspace group chat.

## Troubleshooting

- **"Unknown skill: /<id>."** The host catalog does not offer that skill. Check
  the installed skills and reopen the palette.
- **"Skill /<id> is assigned but is not available from the host skill catalog."**
  The Skillbox still names a skill the host no longer reports. Remove it from
  the agent's Skillbox before invoking it.
- **A General skill is rejected under a non-leader name.** Mention the leader,
  use the message start, or open the workspace group chat.
- **A direct chat rejects a General skill.** General skills need leader triage,
  so use the workspace group chat.
- **The message is rejected and the draft stays.** Skill validation is atomic:
  an unknown skill, wrong owner, archived agent, or missing workspace rejects
  the whole message before any transcript line or work item exists.

## Next

- [Use the Work pane](use-the-work-pane.md): inspect the turn a skill starts.
- [Configure an agent](configure-an-agent.md): combine skills with models and
  backups.
- [Skills](../concepts/skills.md): review the ownership rules in full.
- [Keyboard reference](../reference/keyboard.md#group-chat-and-direct-conversation):
  exact palette and composer bindings.
