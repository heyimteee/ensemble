---
title: Run a multi-agent code review
description: Review one change through separate correctness, security, and test lenses, then rank the findings together.
version: 0.1.x
---

# Run a multi-agent code review

Use this recipe when one change needs more than one kind of review. Separate
reviewers keep correctness, security, and test coverage from collapsing into one
generic opinion.

## Goal

Produce independent review notes for one change, then one ranked list of
findings that names the evidence, the affected file or behavior, and the test
that would catch a regression.

## Actors

- **You**: name the change, the comparison point, and the review lenses.
- **Nova (leader)**: splits the review, keeps the scopes disjoint, and merges the
  findings into one ranked answer.
- **Rook**: correctness and failure behavior.
- **Sage**: security, permissions, and data boundaries.
- **Mira**: tests, reproduction, and missing coverage.

Three reviewers are a useful ceiling for one change. More reviewers usually
repeat the same evidence.

## Before you start

- A workspace bound to the repository directory you want reviewed.
- A review target you can describe unambiguously: a branch, a pull request, a
  commit range, or the current working tree.
- A main model on each reviewer. If the reviewers run shell commands, the host
  must be allowed to ask for those permissions.
- Read [Route a group or direct message](../route-messages.md) for `@path` file
  references and [Resolve an approval](../resolve-approvals.md) for the host
  permission prompts a review can trigger.
- Know the [default dispatch budget](../../concepts/dispatch-budgets.md). A
  leader delegation spends a hop; a direct `$Name` peer turn does not.

## How it runs

1. Open the workspace group chat and press `i`.
2. State the change, the comparison point, and one lens per reviewer. Ask each
   reviewer to report findings in the same shape so the leader can rank them.
3. The leader delegates one work item per reviewer. Each delegation spends one
   group and one command hop; the parent work item reads **WAITING** while the reviews
   run.
4. Each reviewer inspects the change in its own native session. If a reviewer
   needs a shell command, the host may ask for permission; resolve it in the
   approvals inbox.
5. The leader deduplicates the findings, checks that each one has evidence, and
   returns one ranked list. A finding without a file, behavior, or reproduction
   step is marked unverified rather than promoted.
6. After the review, send a separate command for fixes. Do not ask the reviewers
   to edit during the review, or the evidence and the change move under them.

For a fast path, mention the reviewers directly in one message:

```text
$Rook review the queue retry change in @src/v2/queue.ts against main for
correctness and failure behavior.
$Sage review the same change for permission, data-boundary, and logging risks.
$Mira review the tests for missing retry and cancellation coverage.
Report findings only; do not edit files. Use severity, evidence, and test gap.
```

That creates three peer work items and no leader synthesis. Ask the leader for the
ranked merge afterward if you want one answer.

## Example prompts

Leader-coordinated review:

```text
Review the change on branch ticket/307-recipes against main before merge.
Delegate three disjoint reviews: Rook covers correctness and failure behavior in
the changed files; Sage covers permissions, data boundaries, and log content;
Mira covers tests and reproduction. Each reviewer must report findings as
severity, file and line, evidence, and the missing test. Mark anything you could
not verify as unverified. Then deduplicate the three reports into one ranked
list and name the single change that most reduces risk.
```

Focused follow-up on one finding:

```text
$Rook the review says a retry can run twice after a lost lease. Reproduce that
path from @src/v2/queue.ts and report whether the second run is possible. Cite
the exact branch and the test that would fail today.
```

Fix command after the review is accepted:

```text
$Nova apply the accepted findings from the review. Rook owns the retry fix,
Mira owns the regression test, and Sage reviews the log redaction change. Do not
change behavior outside the ranked findings.
```

## What to watch in Work

- **One work item per reviewer.** Three lenses produce three work items. A missing work item
  means that reviewer was not addressed.
- **Parent WAITING.** The leader's work item waits for its children. That is normal
  coordination, not a stalled command.
- **NEEDS YOU.** A reviewer's shell or Git command can trigger a host permission
  prompt. Resolve it or the review stays paused.
- **The budget label.** A refusal names the exhausted layer. A review that needs
  more delegation should start a new command with the remaining question.
- **FAILED versus STALLED.** A failed work item has a native model or tool error; a
  stalled work item is a delivery or lease problem. Retry the stalled work item and read
  the failed work item's native session.
- **Native session output.** Press `o` to confirm the reviewer read the intended
  branch or diff, not the wrong working tree.

## Expected result

- Rook, Sage, and Mira each produce review notes for their own lens.
- Every finding names a file or behavior, evidence, severity, and the test that
  would catch a regression.
- The leader returns one ranked list with duplicates merged and unverified
  claims marked.
- The reviewers do not edit the change during review.
- The group transcript keeps the final review, and each work item is in **HISTORY**
  as **REPLIED**.

## Pitfalls

- **Every reviewer reviews the same surface.** Assign a lens and a file set.
  Overlap is useful only when two lenses genuinely need the same code.
- **The change is not pinned.** "Review the code" can read the wrong branch or a
  dirty working tree. Name the branch, commit range, or pull request.
- **Reviewers edit while reviewing.** The evidence moves under the review and
  the ranked list no longer matches the diff. Ask for findings first, fixes in a
  separate command.
- **The leader promotes an unverified claim.** Require evidence and a test gap.
  A plausible risk without a reproduction is a question, not a finding.
- **A reviewer asks for broad shell access.** Approve the narrow command the
  host shows, not a permanent permission. Ensemble approvals do not replace the
  host permission model.
- **Sensitive content enters the prompt.** Do not paste credentials, customer
  data, or private paths into a review brief. Reference the workspace file with
  `@path` and let the agent read it under host permissions.
- **The review exceeds the context or the budget.** Split the change by surface
  or start a new command for the remainder. A long relay is not more thorough.

## Next

- [Turn an issue into a ticket](issue-to-ticket.md): turn accepted findings into
  scoped delivery work.
- [Use the Work pane](../use-the-work-pane.md): retry, restart, and inspect the
  review behind a work item.
- [Resolve an approval](../resolve-approvals.md): decide a host permission
  prompt.
- [Dispatch budgets](../../concepts/dispatch-budgets.md): read a delegated
  review's ceilings.
- [Recipes](README.md): the other workflows.
