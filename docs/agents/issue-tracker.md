# Issue tracker: GitHub

Specifications and tickets live in GitHub Issues for **heyimteee/ensemble**. Use the `gh` CLI. Read the complete issue body and comments before working from it.

## Conventions

- Publish an approved specification as a parent issue. Publish approved, narrow, end-to-end implementation slices as its sub-issues.
- Apply `ready-for-agent` and appropriate type labels to approved specifications and tickets. Read `triage-labels.md` for the vocabulary.
- A parent specification is a reference, not a single implementation assignment.
- Prefer native GitHub issue dependencies. When unavailable, include an explicit `Blocked by` section linking every blocker.
- Start only a ticket whose blockers are complete. Claim selected implementation work by assigning the issue to the driving developer.
- Completing a child ticket must not close or modify its parent specification.
- Keep code paths and speculative architecture out of issue acceptance criteria; describe observable behavior.

## Operations

- Read: `gh issue view <number> --repo heyimteee/ensemble --json number,title,body,labels,comments`
- List: `gh issue list --repo heyimteee/ensemble --state open --json number,title,labels,assignees`
- Create: `gh issue create --repo heyimteee/ensemble --title "..." --body-file <file>`
- Label: `gh issue edit <number> --repo heyimteee/ensemble --add-label "..."`
- Comment: `gh issue comment <number> --repo heyimteee/ensemble --body-file <file>`
- Close a completed ticket: `gh issue close <number> --repo heyimteee/ensemble --comment "Verification evidence..."`

Use GitHub's REST sub-issue endpoint to attach children when the installed CLI lacks native flags: `POST repos/heyimteee/ensemble/issues/<parent>/sub_issues` with `sub_issue_id` set to the child's numeric database ID.

Use `POST repos/heyimteee/ensemble/issues/<child>/dependencies/blocked_by` with `issue_id` set to the blocker's numeric database ID to add dependencies. Database IDs are not issue numbers or GraphQL node IDs. Verify the resulting relationships; if unsupported, use explicit issue links instead.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Publishing from skills

“Publish to the issue tracker” means create GitHub issues, not local ticket files. Confirm test boundaries and the proposed ticket breakdown before publication. Do not infer approval to implement from approval to publish.
