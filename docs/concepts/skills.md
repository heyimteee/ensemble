---
title: Skills
description: Learn how an agent loads reusable guidance, who owns a skill, and how General skills reach the leader.
version: 0.1.x
---

# Skills

A **skill** is reusable guidance an agent loads through OpenCode's native skill
tool. The **Skillbox** decides which optional skills an agent may use. A skill
is not a tool permission.

## What you see

- **The palette.** Type `/` at the start of a message. The composer lists
  commands, the built-in Ensemble init entry, and skills. An assigned skill
  appears as `Skill | <Owner>`; an unassigned catalog skill appears as
  `Skill | General`.
- **One agent's skills.** Type `$Agent /` to show only that agent's Skillbox.
- **Routing.** An assigned skill goes to its owner. A General skill goes to the
  leader for triage, even when you name no agent.
- **Refusals.** A General skill under a non-leader mention is rejected with a
  message naming the leader. A direct chat rejects General skills and points to
  the workspace group chat.
- **Atomic validation.** An unknown skill, wrong owner, archived agent, missing
  workspace, or too many skills for one request rejects the whole message before
  a transcript line or work item exists. The error names the specific problem
  and your draft stays in the composer.

## Mental model

The host catalog supplies skills; the Skillbox assigns them. Two ownership rules
cover the normal cases:

| Kind | Owner | Route |
|---|---|---|
| Assigned skill | One agent | Only that agent |
| General skill | No workspace member | The leader, for triage |

The leader receives a one-run native `skill` permission allow for exactly the
General skills in the request, plus a prompt directive to read them with the
native skill tool and then use or delegate them. The Skillbox permission
baseline is restored after the turn. A delegatee receives the leader's
self-authored instruction, not a host skill grant.

Skill invocation is deliberate. Ensemble does not attach skill bodies to every
prompt or create one work item per skill. One composer message creates at most
one prompt per unique addressed agent; multiple `/skill` tokens for the same
agent group into that prompt. The exact user text stays the prompt body, and the
service adds routing directives outside it.

A direct chat is one-to-one, so it accepts only the direct agent's own
assigned skills. A General skill needs the leader's triage and therefore belongs
in the workspace group.

The built-in `/init` entry is shown as General but runs the System Agent init
job. It is not assignable in a Skillbox and remains solo-only.

## Example

Linus has the **release-notes** skill in its Skillbox. In the **Acme Notes**
group chat you type `/release-notes` and send the message. The composer opens an
owner picker; choose Linus, and the skill routes to Linus, because Linus is its
owner. Linus receives one prompt containing your exact text.

You later select a General **research** skill with no `$Name`. The leader, Ada,
receives it for triage. In Grace's direct chat, the same General skill is
rejected with a pointer to the workspace group chat; Grace's own assigned skills
still work there.

## Next

- [Memory and approvals](memory-and-approvals.md): what an agent remembers and
  when work waits for your decision.
- [Guides](../guides/README.md): assign a Skillbox and use a skill in a message.
- [Reference](../reference/README.md): the skill palette and agent settings.

## Go deeper

- [ADR 0001: Native-skill boundary](../adr/0001-native-skill-boundary.md)
- [Implementation notes: skill invocation](../implementation.md#skill-invocation-and-leader-triage)
- [Implementation notes: native tools](../implementation.md#native-tools)
