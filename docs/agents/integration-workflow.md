# Integration workflow

Orchestration is the external [`implement-spec`](https://aihero.dev/skills-implement-spec) skill. Run `/implement-spec` with the spec issue; it owns the ticket task graph, implementer subagents, the integration branch, and the closing code review. This document records only the repository-specific commands and gates that skill and the subagents need.

Prerequisites: Git, the pinned Node/npm toolchain from the spec, a primary checkout with `node_modules` installed, and an authenticated `gh` for the tracker. Read the [issue tracker](issue-tracker.md) before claiming work.

## 1. Spec and tickets

Publish the spec and its implementation tickets with blocking edges. Start a ticket only when its blockers are complete. Keep acceptance criteria in the issues; this document does not repeat them.

## 2. Integration branch

Create the integration branch once from the base named by the spec (`main`, or a stacked integration branch while its parent spec is unmerged):

```sh
npm run worktree:create -- 202 \
  --base main \
  --branch integration/env-guardrails \
  --path ../ensemble-202-integration
```

The helper prints the worktree, branch, base commit, and linked dependency directory. It refuses an existing path or branch and a dirty base, and it leaves other worktrees alone. It calls [`scripts/worktree-create.sh`](../../scripts/worktree-create.sh).

## 3. Ticket worktree

```sh
npm run worktree:create -- 205 \
  --base integration/env-guardrails \
  --branch ticket/205-integration-helpers
```

Use the path for that ticket directory for the rest of the work. The new worktree links the primary checkout's `node_modules`; run `npm ci` only if the dependency set changed.

## 4. Implement

Work only in the ticket worktree. For behavior changes, drive [`/tdd`](https://aihero.dev/skills-tdd) one red-green slice at a time; for docs or CI-only tickets, use the existing validation commands instead of inventing a test framework. Keep changes inside the ticket.

Before reporting, merge the integration tip into the ticket branch, resolve conflicts in the ticket branch, and rerun the checks:

```sh
git merge integration/env-guardrails
npm run verify
```

Commit with a conventional message ending in the ticket, for example `tooling: add integration helpers (#205)`. Do not merge into the integration branch from the ticket worktree.

## 5. Merge and verify

```sh
npm run integration:merge -- ticket/205-integration-helpers
```

The merge helper:

- requires a clean integration worktree on the integration branch;
- checks the source range for whitespace errors and conflict residue;
- performs `git merge --no-ff` and stops on conflicts, printing the conflicted paths;
- runs the full `npm run verify` gate in the integration worktree;
- prints the merge commit, its parents, and the verify result.

It calls [`scripts/integration-merge.sh`](../../scripts/integration-merge.sh). It never resolves conflicts, pushes, or edits issues. On conflict it leaves the merge in progress for deliberate resolution:

```sh
git -C ../ensemble-202-integration status
# resolve and commit deliberately, or:
git -C ../ensemble-202-integration merge --abort
```

Use `--integration-branch <branch>` when the integration branch is not `integration/env-guardrails`.

## 6. Code review

Run [`/code-review`](https://aihero.dev/skills-code-review) over the integration branch against the fixed point, or follow the repository [review workflow](review-workflow.md). Send findings back to a fix pass on the ticket branch, then repeat step 5. The merger still owns the final review of the merged result.

## 7. Verification record

Commit a record under `docs/verification/` with the commands, tool versions, evidence, skips, and a reference to the parent spec. A skipped check is not a pass.

## 8. Close tickets

Close tickets only after their verification evidence lands, following [the issue tracker rules](issue-tracker.md). Close a version specification only when every child is closed and its verification record is committed and linked. The merge helper never closes issues.

## 9. Clean up

After a ticket branch is merged into the integration branch, remove only the worktree you created:

```sh
git worktree remove ../ensemble-205
git branch -d ticket/205-integration-helpers
```

Keep the integration worktree until its spec is closed. Never delete or prune another developer's worktrees.
