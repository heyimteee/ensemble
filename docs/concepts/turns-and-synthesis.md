---
title: Turns and synthesis
description: Follow one prompt from the composer through an agent turn, a relay, and the leader's final answer.
version: 0.1.x
---

# Turns and synthesis

A message starts a **turn**: one prompt-and-execution cycle in an agent's native
session. Most turns are ordinary work. A few are **terminal** and decide how a
command ends.

## What you see

- **A turn starts.** When you send a message, the addressed agent begins a turn.
  Its reply streams into the chat and a work item appears in Work.
- **The final text is the message.** An agent does not call a separate
  send-message tool. Its final native text becomes the group message.
- **Waiting.** A leader that delegated work shows a **WAITING** work item while
  its children run. The chat can receive their answers before the leader's final
  answer.
- **One synthesis.** When the workspace enables synthesis, a command with
  delegated results produces one leader synthesis at the command root. If the
  leader wrote a relay, that relay is not a second synthesis.
- **Terminal notice.** On a terminal turn, `$Name` is a reference. If the turn
  mentions someone but creates no work, a notice says so and explains how to
  continue.

## Mental model

A **turn** is durable. It starts with an inbox item, runs in the conversation's
native session, and ends with a result. Closing the Ensemble page does not stop
it. A host retry stays inside the same turn rather than creating a second one.

In a workspace group, every user command creates a **command root** and a
**dispatch group** (the work caused by that command). The task tree looks like
this:

1. Your command becomes the root work item.
2. The leader answers, or delegates typed work to members.
3. Delegated work runs as child turns.
4. The root settles with the leader's synthesis.

A **normal turn** is an ordinary agent turn, a handoff, or a peer turn. It can
use `$Name` to ask a teammate for help, subject to the routing and budget rules.

A **terminal turn** is one of three review moments:

| Terminal turn | What it does |
|---|---|
| Synthesis | Combines the command's results into the final answer |
| Completion review | Reviews a child result that was rooted under another member |
| Batch review | Decides coalesced completions from one dispatch group |

Only the command root synthesizes. An intermediate handoff or delegation parent
settles with its child's result and relays it upward; it does not wake the
leader for a second summary. The leader reads a bounded set of terminal leaf
results, so the final answer does not grow with every hop.

Terminal turns treat `$Name` as a reference and cannot accidentally create peer
work. Explicit decision tools remain available. A terminal turn can start the
next ticket through `ensemble_dispatch`, which creates a **new command root**
with a fresh group, command, depth, and continuation budget. One terminal turn
starts at most one new command. This is a **terminal continuation**, and it is
different from a budget continuation group, which stays inside the same command.

## Example

In **Acme Notes** you ask, "Draft the release note for the sync fix." Ada, the
leader, receives the command and delegates research to Grace and drafting to
Linus. Grace and Linus each run a normal turn; their results appear in the
group, and Ada's root work item reads **WAITING** while they work.

When both children reply, the workspace's synthesis setting allows one final
leader turn. Ada reads the two results and writes the release note as the
group message. No intermediate relay produces a second summary. If Ada then
starts the next ticket from that terminal turn, the next ticket is a new command
with its own budget rather than more hops in the finished command.

## Next

- [Work lifecycle](work-lifecycle.md): what pending, working, and the other
  states mean.
- [Guides](../guides/README.md): delegate work and review a synthesis.
- [Reference](../reference/README.md): the native tools that start and review
  work.

## Go deeper

- [ADR 0012: Terminal turns and root synthesis](../adr/0012-terminal-turns-and-root-synthesis.md)
- [ADR 0010: Native turn ingestion](../adr/0010-native-turn-ingestion.md)
- [Implementation notes: native tools](../implementation.md#native-tools)
