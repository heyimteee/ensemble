---
title: Operations and support
description: One front door for troubleshooting, support, recovery, security, privacy, backup, upgrade, and rollback.
version: 0.1.x
---

# Operations and support

Use this page when something is wrong, or when you need the policy that decides
what happens next. It links the self-service symptom guides, the support
channels, the recovery procedures, and the security and privacy boundaries.

## Before you start

- Record the exact Ensemble, OpenCode, and Node versions, the install method, and
  the last known-good version.
- Stop creating new work before a destructive action. Do not delete state,
  storage, logs, or workspace files to reset a symptom.
- Decide whether the problem is security-related. A suspected vulnerability goes
  through the private process in [SECURITY.md](../../SECURITY.md), never a public
  issue.
- Keep evidence local until you have read and redacted it. Never post
  credentials, conversation content, private paths, or raw logs.

## Start with the symptom

| Symptom | Start here |
|---|---|
| Install fails, the plugin is missing, or `/ensemble` does not open | [Troubleshooting](troubleshooting.md#install-fails) |
| Two Ensemble entries or a duplicate plugin ID | [Troubleshooting](troubleshooting.md#duplicate-plugin-id) |
| The header says **no workspace** | [Troubleshooting](troubleshooting.md#no-workspace) |
| Work is stuck, **NEEDS YOU**, **STALLED**, or **FAILED** | [Troubleshooting](troubleshooting.md#stuck-or-needs-you-work) |
| A native turn produces no reply and then reads **NEEDS YOU** | [Troubleshooting](troubleshooting.md#native-turn-timeout) |
| The agent wizard or a turn reports no usable model | [Troubleshooting](troubleshooting.md#missing-model) |
| An upgrade broke the install, or data may be lost | [Incident runbook](incident-runbook.md) |
| A vulnerability or credential exposure is suspected | [SECURITY.md](../../SECURITY.md) privately |

The [FAQ](faq.md) covers npm tags, Git installs, Windows, macOS with Herdr,
copy-on-select, and no-telemetry diagnostics.

## Support

Support is best effort through GitHub Issues. There is no paid support, private
inbox, or contractual SLA.

- [Support policy](README.md): channels, response targets, evidence to include,
  and redaction rules.
- [Support matrix](support-matrix.md): supported platforms, OpenCode and Node
  versions, terminal sizes, and known limitations.
- [Incident runbook](incident-runbook.md): severity, first response, symptom
  guide, diagnostics, rollback, data recovery, and escalation.
- [Troubleshooting](troubleshooting.md): six common failures and their smallest
  safe fix.
- [FAQ](faq.md): install tags, platform boundaries, and diagnostics questions.

Before filing, reproduce on a supported configuration where possible and attach
only redacted evidence. An unsupported host or platform may be closed as out of
scope with a pointer to the matrix.

## Recovery and rollback

Roll back the package first. Restore data only when the package rollback is not
enough, because a restore can discard newer state.

| Task | Page |
|---|---|
| Export or restore durable state and workspace config | [Backup and restore](../operations/backup-restore.md) |
| Move a pre-ledger workspace to the native-first release | [Upgrade](../operations/upgrade.md) |
| Reverse a package upgrade, with state rollback only when required | [Package rollback](../operations/rollback.md) |
| Plan the full operator sequence | [Operations](../operations/README.md) |

A recovery backup contains conversation content. Keep it private, store it with
owner-only permissions, and never attach it to an issue. A package downgrade
does not delete state; if the older package cannot read newer rows, stop and use
the documented restore path rather than editing storage.

## Security and privacy

- [Security](../security/README.md): threat model, permission-model review,
  accepted risks, and the private reporting route.
- [Privacy](../privacy/README.md): data classes, the 24-hour Work and 7-day log
  retention, the `ensemble.data-export` format, delete, and the `AGENTS.md`
  roster disclosure.
- [SECURITY.md](../../SECURITY.md): the authoritative vulnerability process.
  Never open a public issue for a vulnerability.

Ensemble does not replace OpenCode's tool permissions. An Ensemble approval is a
workflow decision, not a permanent host grant. Diagnostics are local and
user-initiated; there is no telemetry or automatic upload.

## Expected result

You know which page owns the symptom, whether the configuration is supported,
and which recovery action is reversible. You can file a support issue with
redacted evidence or report a vulnerability privately without exposing sensitive
data.

## Next

- [Troubleshooting](troubleshooting.md): the six common failure paths.
- [FAQ](faq.md): the install and platform boundaries.
- [Support policy](README.md): what to include and what stays private.
- [Incident runbook](incident-runbook.md): the full recovery procedure.
- [Operations](../operations/README.md): backup, upgrade, rollback, and release
  operations.
