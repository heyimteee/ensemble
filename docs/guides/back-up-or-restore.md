---
title: Back up or restore
description: Choose the right artifact, follow the operator procedure, and know what a restore does and does not recover.
version: 0.1.x
---

# Back up or restore

Use a recovery backup when you need to restore Ensemble's durable state and
workspace config. Use a data export when you need a portable copy of one
workspace's user data. They are different formats with different jobs.

## Before you start

- You can run the operator commands from an Ensemble `0.1.0` checkout, or call
  the documented RPC from an installed integration.
- You know that a recovery backup contains conversation content and workspace
  state. Store it with owner-only permissions and keep it out of the repository.
- Read [Data classes and retention](../privacy/data-and-retention.md) before you
  choose an export, delete, or reset path.

## Steps

1. Choose the artifact. For recovery, use the `ensemble.backup` document in
   [Backup and restore](../operations/backup-restore.md#scope). For a portable
   user-data projection, use `npm run data -- export` in
   [Data classes and retention](../privacy/data-and-retention.md#export).
   Do not use a data export to restore a workspace, and do not treat a recovery
   backup as a portable data export.

2. For a recovery backup, follow the export command and permission behavior in
   [the operator commands](../operations/backup-restore.md#commands).
   The report names counts, versions, and the output file; it does not print
   conversation content or credentials.

3. Before a restore, let running work and init jobs finish. The restore refuses
   while work is active.
   Then follow the restore command and the ordered steps in
   [What restore does](../operations/backup-restore.md#what-restore-does).

4. Restart OpenCode after a successful restore so native bindings are
   re-established from the restored rows.
   Reopen the workspace and confirm its members, leader, and conversation
   history are present.

5. If a restore fails or you need to reverse it, use
   [Failure and rollback](../operations/backup-restore.md#failure-and-rollback).
   The automatic pre-restore slot remains available until it is consumed.

## Expected result

- An export writes one `ensemble.backup` document with counts and a digest.
- A restore validates the document before writing, captures the current state
  into one rollback slot, restores durable state and workspace config, and
  reports success.
- After OpenCode restarts, the workspace opens with its restored team and
  native bindings.
- A failed restore either re-applies the captured state automatically or leaves
  the rollback slot for a retry.

## Troubleshooting

- **The restore reports `busy`.** A run, init job, or background service pass is
  active. Wait for it to finish and retry.
- **`unsupported_backup`.** The backup is newer than this release supports. Use
  a matching Ensemble version or an older backup.
- **`backup_corrupt`.** The document is truncated or edited. Use another backup;
  nothing was written.
- **`restore_failed_rolled_back`.** The previous state was restored
  automatically. Check the host (for example, free disk space) before retrying.
- **`restore_failed`.** The automatic recovery also failed. The complete
  pre-restore document remains in the rollback slot. Fix the host, then follow
  the rollback procedure.
- **Attachments or handoff files are missing after restore.** They are excluded
  from the recovery backup. Copy the workspace directory or
  `.ensemble/handoffs/` separately if you need them.

## Next

- [Incident runbook](../support/incident-runbook.md): recover a broken workspace
  or suspected data loss.
- [Backup and restore](../operations/backup-restore.md): read the full operator
  procedure.
- [Data classes and retention](../privacy/data-and-retention.md): review export,
  delete, retention, and the `AGENTS.md` roster disclosure.
- [Operator CLI reference](../reference/cli.md): exact backup, restore, and
  rollback commands and exit codes.
