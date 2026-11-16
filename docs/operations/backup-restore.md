# Backup and restore

Ticket #273. This is the recovery path for Ensemble's durable plugin state and
the Workspace config it writes. It is release engineering, not a new product
surface: the state lives in OpenCode plugin storage, so the operation runs
through the existing `ensemble.v2` RPC `invoke` method.

## Scope

Included in one backup document:

- every durable `v2/` entity the service owns: agents, workspaces, messages,
  subtasks, dispatch groups, init jobs, native subagents, bindings, memories,
  approvals, the direct-message queue, and legacy direct rows;
- the `v2/meta` row: settings, UI state, and coordination version;
- the derived `.ensemble/config.json` and `.ensemble/init.json` records for
  every non-archived workspace, joined by workspace ID.

Excluded on purpose:

- attachment bytes under `.ensemble/attachments/` (copy the workspace
  directory if you need them);
- `.ensemble/handoffs/` files;
- `AGENTS.md` and other project content;
- OpenCode host sessions, transcripts, provider credentials, and logs.

A backup therefore contains conversation content and Workspace state. Store it
with owner-only permissions, keep it out of the repository, and delete it when
it is no longer needed. Retention and user-facing delete policy belong to
#272; the backup path does not prune or delete existing data.

### Relationship to the user data export

#272 ships `npm run data -- export` and the `ensemble.data-export` format. That
is a deliberate user-facing projection: it excludes bindings, host session
ids, workspace directories, settings, model configuration, and operational
logs. Those exclusions are exactly what a restore needs, so the recovery
document stays `ensemble.backup`. The two formats are intentionally separate;
do not use `ensemble.data-export` to restore a workspace, and do not treat a
recovery backup as a portable data export. See
[Data classes, retention, export, and delete](../privacy/data-and-retention.md).

## Document format

```json
{
  "format": "ensemble.backup",
  "formatVersion": 1,
  "createdAt": 1700000000000,
  "protocol": 4,
  "contractVersion": 7,
  "counts": { "agents": 2, "workspaces": 1 },
  "digest": "<sha256-prefix>",
  "payload": {
    "meta": { "version": 41, "updatedAt": 0, "settings": {}, "ui": {} },
    "entries": [{ "key": "v2/agent/<id>", "value": {} }],
    "workspaceConfigs": [{ "workspaceID": "<id>", "config": {} }]
  }
}
```

- `formatVersion` gates compatibility. A release refuses a newer value with
  `unsupported_backup` instead of guessing.
- `digest` covers the canonical payload. A truncated or edited file fails with
  `backup_corrupt` before storage changes.
- `counts` must match the entries.
- Only the known durable prefixes are accepted; an unknown key is rejected.
- Entity rows are checked for the fields the store indexes and doctor reads;
  older additive fields are preserved untouched.
- The document never duplicates a filesystem path: workspace configs key on
  the workspace ID and resolve the directory from the restored workspace row.

## Commands

From the repository (`Node >=22.23.4`):

```sh
# Export. The file is written atomically with mode 0600.
npm run backup -- export --out ./ensemble-backup.json "$PWD"

# Inspect the stored pre-restore slot (no content is printed).
npm run backup -- status "$PWD"

# Restore. Requires the explicit word and refuses while work is running.
npm run backup -- restore --in ./ensemble-backup.json --confirm RESTORE "$PWD"

# Re-apply the automatic pre-restore slot.
npm run backup -- rollback --confirm ROLLBACK "$PWD"
```

The script resolves the same service descriptor as `doctor`:
`$XDG_STATE_HOME/opencode/service.json`, or
`~/.local/state/opencode/service.json`. `--server <url>` overrides the URL;
`OPENCODE_PASSWORD` takes precedence over the descriptor password. Reports
carry counts, versions, and the output file only. Conversation content,
credentials, and the password are never printed.

Installed users who do not have the repository can call the same RPC
(`POST /api/rpc/ensemble.v2/invoke` with
`{ "input": { "directory": "...", "action": "backup.export", "payload": {} } }`)
or copy `scripts/backup.mjs` from the release tag. It has no dependencies
beyond Node builtins.

## What restore does

1. Validates the document (format, version, digest, counts, keys, entity
   fields) before any write.
2. Captures the current durable state and workspace config text.
3. Writes that capture to one rollback slot at `v2/backup/rollback`.
4. Replaces every durable prefix, writes the meta row last, and restores
   `.ensemble/config.json` for restored workspaces. Configs for workspaces the
   backup does not contain are removed when their recorded ID matches.
5. Rebuilds the in-memory store and publishes an explicit feed reset, because
   the change ring cannot describe a wholesale replacement.

The restored meta version is `max(backup version, current version) + 1`, so a
cursor cannot move backwards. `configVersion` is normalized to the config file
that is actually written, which keeps `doctor` in agreement with storage.

Restore refuses while a run, init job, or background service pass is active
(`busy`). Restart OpenCode afterwards so native bindings are re-established
from the restored rows.

## Failure and rollback

- A write failure during restore automatically re-applies the captured state
  and previous config text, then returns `restore_failed_rolled_back`. The
  service keeps serving the previous state.
- If the automatic recovery also fails, the command returns `restore_failed`,
  but the complete pre-restore document remains at `v2/backup/rollback`. Fix
  the host (for example, free disk space), then run `rollback` or apply a
  backup file. The slot is readable with `status`.
- A process crash leaves the same slot. The next start can roll it back; no
  separate file is required.
- `rollback` never overwrites the slot with the partial state, so a failed
  rollback can be retried.
- `ensemble.reset` removes the slot along with all durable state.

## Verification

`npm run verify` includes the store-seam suite (`src/v2/backup.test.ts`) and
the service-seam suite (`src/v2/service.test.ts`, `ticket273:` cases):

- export/restore round trip, including config and version advance;
- replacement of pre-existing rows and stale configs;
- rejection of foreign, newer, truncated, duplicated, and malformed documents;
- injected write failure with automatic recovery, and permanent failure with
  a recoverable slot;
- config write failure with durable recovery;
- `doctor` reports zero mismatches against restored state;
- the operator CLI writes mode 0600, restores, rolls back, and reports a
  refusal without content.

See [the ticket #273 record](../verification/2026-11-16-ticket-273.md) for the
run evidence. The upgrade and package rollback procedures are in
[upgrade.md](upgrade.md) and [rollback.md](rollback.md). The incident runbook
uses this path for host-owned state recovery:
[support/incident-runbook.md](../support/incident-runbook.md).
