---
title: Memory and approvals
description: Understand what an agent remembers, where that knowledge is scoped, and when work waits for your decision.
version: 0.1.x
---

# Memory and approvals

**Memory** is saved knowledge with provenance. **Approval** is an explicit
decision you make before dependent work continues. Memory changes what an agent
knows; approval changes what the team may do next.

## What you see

- **Memories in settings.** Press `s` on an agent and open **Memories** to add,
  edit, or remove entries. Each entry shows its origin: **Automatic** or
  **Manual**. Later edits do not erase that origin.
- **Workspace memory.** A workspace memory is shared with every member of that
  workspace. Project memory belongs to one agent in one workspace, and global
  memory follows the agent across workspaces.
- **Approvals under Work.** Pending approvals appear as a small summary pinned
  under the Work pane. Press `v` to open the full-height approvals inbox from
  any pane, move with `j`/`k`, press `Enter` to resolve, and `Esc` to return to
  split view.
- **Needs you.** A pending approval keeps its work item in ACTIVE and marks the
  work **NEEDS YOU**. The work item stays until you decide.
- **Resolution.** Only you can approve. Repeating the same decision returns the
  resolved approval; a conflicting decision fails rather than overwriting the
  first one.

## Mental model

Memory is not conversation history. An entry records its scope, its origin
(Automatic or Manual), its source, and its history. Deleting an entry excludes it
from future retrieval; it does not erase native transcripts. See the
[privacy policy](../privacy/data-and-retention.md) for retention and deletion.

| Scope | Who can use it |
|---|---|
| Project | One agent in one workspace |
| Workspace | Every member of that workspace |
| Global | One agent across workspaces; promotion needs approval |

An approval is a request for your decision, not a permission grant. It is
distinct from, and cannot override, OpenCode's tool permissions. Approvals cover
the moments where the server cannot safely infer your intent:

- An agent asks you a direct question.
- Work needs to contact an agent outside the workspace roster.
- A memory is promoted to global scope.
- A transcript or project is shared across a boundary.
- Interrupted work needs a decision before it resumes.

Approvals are workspace-scoped: a workspace cannot see or resolve another
workspace's pending decisions. A pending approval makes the related work
**NEEDS YOU** and overrides the normal completion hold. Cancelling, retrying, or
reassigning that work closes its stale approvals, so an old decision cannot
restart dead work. Approving interrupted work resumes it once; discarding marks
it failed.

## Example

Grace finds the root cause of the sync bug and saves it with
`ensemble_remember` as a project memory. The entry is marked **Automatic** and
belongs to Grace in **Acme Notes**.

The team wants the same fact available in another project, so Grace requests a
promotion to global memory. An approval appears under Work and the related work
item reads **NEEDS YOU**. You press `v`, review the request, and approve it. The
memory becomes available across Grace's workspaces; its Automatic origin stays
visible. If you deny the request, the memory remains project-scoped and the work
item continues with the answer it already has.

## Next

- [Architecture](architecture.md): how the server, TUI, state, and host fit
  together.
- [Guides](../guides/README.md): manage memories and resolve approvals.
- [Reference](../reference/README.md): memory scopes and approval actions.

## Go deeper

- [ADR 0005: Work status and delivery/lease separation](../adr/0005-work-status-and-delivery-lease-separation.md)
- [Implementation notes: memory and approvals](../implementation.md#memory-and-approvals)
- [Security: permission model review](../security/permission-model-review.md)
