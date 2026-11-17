---
title: Turn an issue into a ticket
description: Read a GitHub issue, inspect the code it names, and produce one scoped implementation ticket with criteria and tests.
version: 0.1.x
---

# Turn an issue into a ticket

Use this recipe when an issue describes a problem but is not yet a piece of
delivery work. The output is one implementation ticket: context, scope,
observable acceptance criteria, test seams, dependencies, and open questions.

## Goal

Turn one issue and its comments into a ticket another agent can implement
without re-reading the whole tracker. The ticket states what will change, what
will not, and how a reviewer will know it worked.

## Actors

- **You**: supply the issue reference and the repository boundary.
- **Nova (leader)**: coordinates the read, the draft, and the merge.
- **Grace**: reads the issue, comments, and the code paths it names; reports
  facts, conflicts, and reproduction gaps.
- **Linus**: drafts the implementation ticket from Grace's facts.
- **Sage (optional)**: reviews the draft for untestable criteria, hidden
  dependencies, and scope creep.

## Before you start

- A workspace bound to the repository the issue concerns.
- The issue number or URL, and access to the repository it references. If the
  agent cannot read GitHub, paste the issue body and relevant comments into the
  prompt; do not paste credentials or private data.
- `gh` available and authenticated in the host if an agent should read the issue
  directly. The host decides whether a shell command is allowed.
- A main model on each agent, and the [default dispatch
  budget](../../concepts/dispatch-budgets.md) available for the delegation.
- Read [Route a group or direct message](../route-messages.md) for `$Name` and
  `@path`.

## How it runs

1. Open the workspace group chat and press `i`.
2. Give the leader the issue reference, the repository, and the ticket shape you
   want. Ask for facts before drafting.
3. The leader delegates the issue-and-code read to Grace and the draft to Linus.
   Each delegation creates a child work item; the parent card reads **WAITING**.
4. Grace reports what the issue asks for, what the comments change, which files
   or behaviors are involved, and what cannot be reproduced. Grace cites the
   issue section or file rather than paraphrasing silently.
5. Linus drafts the ticket from those facts. If the issue is ambiguous, Linus
   lists an open question instead of inventing a requirement.
6. The leader merges the draft, checks every acceptance criterion is observable,
   and returns one ticket body. It does not post to GitHub unless you ask.
7. You review the ticket, then post it yourself or send a separate command to
   create it. Approval to draft is not approval to publish or implement.

A direct two-agent path works when you do not need the leader to coordinate:

```text
$Grace read issue <issue-number> in <owner>/<repo>, including its comments, and
report the requested behavior, conflicts, affected files, and reproduction gaps.
$Linus turn Grace's report into one implementation ticket with observable
acceptance criteria, test seams, blockers, and out-of-scope items.
Do not modify the issue. Mark anything unresolved as an open question.
```

## Example prompts

Leader-coordinated command:

```text
Read issue <issue-number> in <owner>/<repo> and turn it into one implementation
ticket. Delegate the fact-finding to Grace and the draft to Linus. Grace must
cite the issue sections and the files or behaviors involved, and must name any
claim that is not reproducible from the repository. Linus must produce a title,
problem, scope, non-goals, acceptance criteria, test plan, dependencies, and open
questions. Sage reviews the draft for untestable criteria and hidden coupling.
Do not comment on or close the issue. Return the ticket body for my review.
```

Focused reproduction prompt:

```text
$Grace reproduce the failure described in issue <issue-number>. Use the smallest
synthetic case you can, record the exact command and output, and say whether the
issue's claimed cause matches the code in @src/v2/queue.ts. Do not propose a fix
yet.
```

Publish after approval:

```text
$Nova create the accepted ticket in <owner>/<repo> as a new issue. Use the
approved body unchanged, link the source issue as context, and do not close the
source issue. Report the new issue number.
```

## What to watch in Work

- **One card for the read and one for the draft.** The two work items have
  different jobs. If only one card exists, the leader collapsed the work and the
  facts may not have been checked.
- **Parent WAITING.** The leader waits for the child that supplies facts or the
  draft. A waiting parent is coordination, not a stall.
- **NEEDS YOU.** A `gh` command, a file read outside the workspace, or another
  host permission can pause the card. Resolve it or the ticket stays incomplete.
- **Native session evidence.** Press `o` on Grace's card to confirm the issue
  comments were read, not only the title. Press `o` on Linus's card to see the
  files the draft relies on.
- **Budget label.** A refusal names the exhausted layer. Drafting a large ticket
  does not need a long relay; start a new command with the remaining section.
- **STALLED versus FAILED.** Retry a stalled card. Read a failed card's native
  session for the missing command, authentication error, or model problem.

## Expected result

- Grace returns cited facts, conflicting comments, affected code, and
  reproduction gaps.
- Linus returns one ticket with a title, problem, scope, non-goals, observable
  acceptance criteria, test plan, dependencies, and open questions.
- The leader returns the merged ticket body without posting it.
- The source issue is unchanged. Publishing is a separate, explicit action.
- The work items finish in **HISTORY** as **REPLIED**, and the group transcript
  holds the ticket body.

## Pitfalls

- **The draft restates the issue without adding delivery detail.** Require
  acceptance criteria that a reviewer can observe and a test seam for each one.
- **Comments are treated as approved scope.** A comment can add context without
  approval. List unresolved product decisions as open questions.
- **An agent cannot read the issue.** Paste the issue body and comments, or grant
  the narrow host permission the agent asks for. Do not paste a token into the
  prompt.
- **Acceptance criteria name code paths.** Describe observable behavior and the
  command or test that proves it, not an implementation file to edit.
- **The draft silently expands scope.** Ask for non-goals and a "not in this
  ticket" list. A ticket that fixes everything cannot be reviewed.
- **The agent posts or closes the issue without approval.** Drafting and
  publishing are separate commands. Ask for the issue number before accepting a
  publish result.
- **Sensitive issue content enters a public comment.** Keep customer data,
  private paths, and credentials out of the prompt and the ticket. Redact before
  sharing.
- **A dependency is discovered late.** The reader should inspect linked issues,
  open pull requests, and blocked-by relationships before the draft is accepted.

## Next

- [Run a multi-agent code review](multi-agent-code-review.md): review the change
  the ticket produces.
- [Use the Work pane](../use-the-work-pane.md): inspect, retry, or reassign the
  fact-finding and drafting work.
- [Route a group or direct message](../route-messages.md): address one agent or
  several in a single command.
- [Dispatch budgets](../../concepts/dispatch-budgets.md): understand the hops a
  coordinated ticket uses.
- [Recipes](README.md): the other workflows.
