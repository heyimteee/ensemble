---
title: Manage memory
description: Add, edit, delete, and promote saved knowledge while keeping its scope and provenance clear.
version: 0.1.x
---

# Manage memory

Memory is saved knowledge with provenance. It is not the conversation transcript,
and deleting a memory does not remove native history.

## Before you start

- The agent exists in the roster, and you can open its settings.
- Read [Memory and approvals](../concepts/memory-and-approvals.md) for the
  project, workspace, and global scopes.

## Steps

1. Select the agent in the rail, press `s`, then press `l` until **Memories** is
   active.
   The tab lists the agent's saved memories. Manual entries you add here are
   project-scoped: one agent in one workspace.

2. Press `a`, type the memory, and press `Enter`.
   The entry is saved and the field clears for the next one, while staying
   focused. Press `Esc` to return to the rows.

3. Press `Enter` or `e` on a row to edit it, change the text, and press `Enter`.
   The text and its history update. The recorded origin stays **Manual** or
   **Automatic**; later edits do not rewrite where the memory came from.

4. Press `x` to delete the focused memory.
   The row leaves the list and future retrieval excludes it. Native transcripts
   are not erased.

5. Press `p` to promote a non-global memory.
   This opens a memory approval instead of promoting immediately. The memory
   keeps its current scope until you resolve the approval in the inbox.

6. Press `/` to filter the list and `Esc` to return to settings. Memory
   add, edit, delete, and promote actions are saved immediately; only the other
   settings tabs use the draft-and-save flow.

## Expected result

- A manual add appears immediately as a project memory for that agent.
- A workspace memory is shared with every member of its workspace.
- A promoted memory becomes global only after you approve it, then follows the
  agent across workspaces. Its origin stays visible.
- An automatic memory saved by an agent through `ensemble_remember` is managed
  in the same list. A global save request opens the same promotion approval.

## Troubleshooting

- **The memory is still project-scoped after `p`.** Promotion needs approval.
  Open the approvals inbox and resolve the memory request.
- **A deleted memory still appears in an old conversation.** Deletion stops
  future retrieval; it does not rewrite native transcripts.
- **A workspace export or delete does not include an agent-global memory.**
  Global memories belong to the agent, not the workspace. Manage them from the
  agent's memory settings. See
  [Data classes and retention](../privacy/data-and-retention.md).
- **The edit field stays open after Enter.** That is intended for successive
  entries. Press `Esc` to return to the rows.

## Next

- [Resolve approvals](resolve-approvals.md): decide a memory promotion.
- [Configure an agent](configure-an-agent.md): return to the other settings
  tabs.
- [Back up or restore](back-up-or-restore.md): include durable state in a
  recovery backup.
- [Files and storage reference](../reference/files.md): exact `.ensemble` and
  `AGENTS.md` paths.
