---
title: Operations
description: Back up, upgrade, roll back, diagnose, and release Ensemble safely.
version: 0.1.x
---

# Operations

Procedures for running Ensemble safely: back up durable state, upgrade the
package, roll back a bad release, collect diagnostics, and follow the release
process. These pages are for operators and maintainers; daily use is covered in
[Guides](../guides/README.md).

## Recovery

| Task | Page |
|---|---|
| Back up or restore the durable-state document and workspace config | [Backup and restore](backup-restore.md) |
| Upgrade a prerelease or checkout install to stable `0.1.1` | [Upgrade to stable 0.1.1](upgrade.md) |
| Reverse a package upgrade, with state rollback only when required | [Package rollback](rollback.md) |
| Resolve a broken workspace, stuck work, or suspected data loss | [Incident runbook](../support/incident-runbook.md) |

## Diagnosis and capacity

| Task | Page |
|---|---|
| Check the tested operating envelope, run the soak harness, or collect a redacted support bundle | [Scale, soak, and local diagnostics](scale-and-monitoring.md) |
| Compare roster, workspace, membership, binding, and dispatch-ledger state across locations | [Runtime diagnosis](../../README.md#runtime-diagnosis) |
| Export or delete this workspace's Ensemble data | [Data classes and retention](../privacy/data-and-retention.md) |

## Release

| Task | Page |
|---|---|
| Run the tag-driven release workflow and dry run | [Release operations](release.md) |
| Complete the pre-tag sign-off checklist | [Release sign-off checklist](release-signoff.md) |
| Read the stable `0.1.1` release notes | [Ensemble 0.1.1 release notes](release-notes-0.1.1.md) |

## Release history

These pages are retained as history. Their version claims are scoped to the
release they describe.

- [Release notes for 0.1.0](release-notes-0.1.0.md)
- [Release notes for 0.1.0-rc.2](release-notes-0.1.0-rc.2.md)
- [Launch plan for 0.1.0-rc.2](launch-plan-0.1.0-rc.2.md)

## Related

- [Operations and support](../support/operations.md): the combined front door for
  troubleshooting, support, recovery, security, and privacy.
- [Support policy](../support/README.md): channel, response targets, and
  redaction rules.
- [Support matrix](../support/support-matrix.md): supported hosts and known
  limitations.
- [Security](../security/README.md): threat model, permissions, and accepted
  risks.
- [Privacy](../privacy/README.md): retention, export, and delete.
- [Evidence index](../contributing/evidence.md): verification records for these
  procedures.
