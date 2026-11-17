# Privacy

What Ensemble stores, where it stays, how long it is retained, and how to export
or delete it. Ensemble has no telemetry: operational diagnostics stay on the
local machine, and credentials are never stored in Ensemble rows, exported, or
printed by the data commands.

## Data policy

[Data classes, retention, export, and delete](data-and-retention.md) is the
authoritative user-facing policy. It covers:

- What Ensemble stores in OpenCode plugin storage and workspace config.
- The 24-hour Work and 7-day log retention.
- The `ensemble.data-export` format.
- The scoped delete path.
- The v7 `AGENTS.md` roster disclosure guidance and manual opt-out.

## Related

- [Security](../security/README.md): threat model, permissions, and accepted
  risks.
- [Backup and restore](../operations/backup-restore.md): durable-state backup
  and recovery.
- [Support](../support/README.md): how to redact evidence before posting.
- [Evidence index](../contributing/evidence.md): the privacy review and
  verification record.
