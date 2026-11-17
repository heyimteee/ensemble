---
title: Run parallel research
description: Split one research question across two agents, watch both work items, and combine the findings into one answer.
version: 0.1.x
---

# Run parallel research

Use this recipe when one question has two independent tracks and you want the
tracks to run at the same time. The leader coordinates by default; a direct
mention of two agents is the faster, less synthesized path.

## Goal

Produce two evidence-backed research briefs in parallel, then one answer that
states where they agree, where they disagree, and what remains unknown.

## Actors

- **You**: state the decision, the two tracks, and the output format.
- **Nova (leader)**: receives the unaddressed command, delegates the tracks, and
  synthesizes when leader synthesis is on.
- **Grace and Linus**: researchers who own one track each.
- **Sam (optional)**: fact checker for a disputed claim.

The names are synthetic. Use your own roster.

## Before you start

- A workspace group chat with a leader and two member agents.
- A main model on each agent, and ideally a backup model on each.
- **Leader synthesis** enabled if you want one combined final answer. It is set
  when you create or edit the workspace.
- The [default dispatch budget](../../concepts/dispatch-budgets.md): 24 command
  hops, an 8-hop root group, and depth 8. A leader delegation spends one group
  and one command hop; a `$Name` peer turn spends no hop.
- Read [Route a group or direct message](../route-messages.md) if `$Name` is new
  to you.

## How it runs

1. Open the workspace group chat and press `i`.
2. Send one command that names the two tracks and asks for a combined answer.
   Give each track a different question, a source boundary, and an output shape.
3. The leader either delegates two work items or answers alone. A delegation
   creates a child work item per researcher, and the parent card reads
   **WAITING** until both settle.
4. Watch both cards in **ACTIVE**. Open a native session with `o` when you need
   to see which files or commands produced a claim.
5. When both researchers reply, the leader synthesizes if synthesis is enabled.
   If it is not, ask for the synthesis as a new command after the two briefs
   arrive.

For a faster path with no leader delegation, address both researchers in one
message:

```text
$Grace research the current caching options and their operational cost.
$Linus research the current queue options and their failure behavior.
Return two separate briefs with sources and open questions.
```

That creates one work item per named agent. It does not create a leader
synthesis; ask for one in a follow-up if you need a single recommendation.

## Example prompts

Leader-coordinated command:

```text
Prepare a build-versus-buy recommendation for the sync worker. Delegate two
independent tracks: Grace covers hosted queue cost, limits, and exit paths;
Linus covers self-hosted queue operations, failure modes, and recovery. Each
brief must cite the files or pages it used, separate facts from assumptions,
and end with the strongest counterargument. Then combine both briefs into one
recommendation with a decision, three risks, and the next check.
```

Direct parallel command:

```text
$Grace review the hosted queue option in @docs/architecture.md and report cost,
limits, and exit path.
$Linus review the self-hosted queue option in @docs/architecture.md and report
operating cost, failure modes, and recovery.
Use the same headings in both briefs so I can compare them.
```

Follow-up when the briefs disagree:

```text
$Nova compare Grace's and Linus's conclusions. Name the two points of
disagreement, ask each researcher for the missing evidence, and do not pick a
winner until both answer.
```

## What to watch in Work

- **Two cards, not one.** Each researcher owns one work item. If only the leader
  card exists, the leader answered alone; send the direct `$Name` form or ask it
  to delegate explicitly.
- **Parent WAITING.** A coordinated command shows the leader card **WAITING**
  while the child cards run. That is the correct state, not a stuck command.
- **The budget label.** `hops 3/8 · cmd 21 left` means the group has spent three
  of eight hops. A refusal names the exhausted layer; start a new command rather
  than forcing a continuation you do not need.
- **NEEDS YOU.** A host permission request pauses the related card until you
  resolve it with `v`. Approving an Ensemble approval does not grant a host tool
  permission permanently.
- **STALLED versus FAILED.** Retry a stalled card; inspect a failed card's native
  session for the model or tool error.
- **One native session per researcher.** Press `o` on each card to compare what
  each agent actually read.

## Expected result

- Grace and Linus each produce one brief with sources, assumptions, and open
  questions.
- The leader produces one combined answer that names agreement, disagreement,
  and the next check, or you ask for that synthesis explicitly.
- Both child cards move to **HISTORY** as **REPLIED**, and the group transcript
  holds the final answer.
- The two briefs are independent: neither researcher repeats the other's scope.

## Pitfalls

- **The leader answers without delegating.** An unaddressed command is a request,
  not a guaranteed split. Name both agents in one message, or say "delegate two
  tracks" and name the owners.
- **Both tracks ask the same question.** Give each track a different decision or
  evidence boundary. Duplicate briefs waste two work items and a hop each.
- **Direct mentions produce no synthesis.** `$Grace` and `$Linus` create peer
  turns, not a leader command. Ask the leader for the comparison afterward.
- **The command runs out of group hops.** The default root group allows eight
  hops. A long relay stops with a budget refusal; start a new command with the
  remaining question instead of restating the whole brief.
- **One provider rate-limits both agents.** Parallel work shares your provider
  quota. Add backup models or stagger the two tracks.
- **A card sits in NEEDS YOU.** A host permission or an interrupted run is
  waiting for your decision. Resolve it in the approvals inbox; retrying does not
  grant the missing permission.
- **A native turn looks silent for minutes.** Do not restart on time alone. Open
  the native session with `o`; if the host never settled the turn, Ensemble marks
  it interrupted. Restart the card with `R`, or resolve the interrupted-work
  approval with `v` when one is attached.

## Next

- [Run a multi-agent code review](multi-agent-code-review.md): apply the same
  split to one change.
- [Route a group or direct message](../route-messages.md): exact `$Name` and
  `@path` grammar.
- [Use the Work pane](../use-the-work-pane.md): delegate, retry, restart, and
  open a native session.
- [Dispatch budgets](../../concepts/dispatch-budgets.md): read a refusal and a
  continuation.
- [Recipes](README.md): the other workflows.
