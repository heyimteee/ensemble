---
title: Upgrade to stable 0.1.0
description: Move a prerelease or checkout install to the stable 0.1.0 package and verify the workspace.
version: 0.1.x
---

# Upgrade to stable 0.1.0

This guide moves an existing workspace to the stable `0.1.0` package. The
runtime is identical to `0.1.0-rc.3`; the stable release only moves npm `latest`
to `0.1.0`. The public prerelease history remains `0.1.0-rc.2` and
`0.1.0-rc.3`.

Node must be `>=22.23.4`; supported OpenCode hosts are 2.2.6, 2.2.7, and 2.3.0.
Pin the exact package version rather than a floating tag.

## Before you upgrade

1. Record the current install:
   ```sh
   opencode --version
   node --version
   opencode plugin list
   ```
   Keep the local path or the exact prerelease version that is currently
   installed.
2. Back up durable state:
   ```sh
   npm run backup -- export --out ./ensemble-backup.json "$PWD"
   npm run backup -- status "$PWD"
   ```
   See [backup and restore](backup-restore.md). The file contains conversation
   content; keep it private.
3. Stop the OpenCode host. The plugin and its RPC surface are replaced on the
   next start; there is no in-place hot swap.
4. If a workspace has uncommitted `.ensemble/config.json` edits, decide whether
   they belong in the backup before restoring anything later.

## Install stable 0.1.0

```sh
opencode plugin add @heyimteee/ensemble@0.1.0
opencode plugin list
```

Expected entry:

```text
ensemble.v2  0.1.0  @heyimteee/ensemble@0.1.0
```

The package entry replaces a linked checkout or older plugin entry. A restart
is required after the install. `opencode plugin check` reports updates and
`opencode plugin update` applies them deliberately; do not use a floating tag
in a shared instruction.

## What happens on the first start

Durable state lives under the `v2/` storage prefixes. There is no separate
store schema number and no destructive rewrite: the first start reads the same
rows, applies additive defaults, and writes only what a later mutation needs.

| Change | Behavior | Evidence |
|---|---|---|
| Native-first default | `nativeFirst: "on"` is persisted once when the meta row has no valid mode. An explicit `off` or `shadow` is preserved and is never flipped. | #240 |
| AGENTS v7 contract | The `<!-- ensemble:start v7 -->` block is reconciled in place. Content and version are compared; project content outside the block is preserved; a newer recorded version is never downgraded. | #238, #253 |
| Native state refactor | One `NativeIngestionState` value per session replaces the split trackers. Bindings are re-indexed, and a start reconciliation repairs missing turn rows without re-running work. | ADR 0010, #231, #218 |
| Durable dispatch ledger | Rows without a group synthesize one from the root ancestor; budgets are granted on first save. | #160 |
| Direct transcripts | Pre-channel `v2/dm/` direct rows merge into conversation channels once; the merge is idempotent. | #226 |
| Legacy v1 agents | A pre-v2 `ensemble.state` row migrates agents that are not already present. | v2 migration |
| Init job phases | A stored single `phase` is read as the last `phases` entry and rewritten on the next advance. | #118 |
| Lease recovery | `working` rows are not rewritten on load. The lease-aware reaper and waiting-work repair decide what can run. | #148 |

The roster table in AGENTS v7 writes member names, titles, and roles into the
workspace file. If a repository is public, review those fields before the
first commit that includes the block. The disclosure policy and the guidance
for disabling or limiting it are in
[Data classes, retention, export, and delete](../privacy/data-and-retention.md).

## Verify the upgrade

1. Start the host and open the workspace.
2. Confirm the plugin entry and the diagnostic read:
   ```sh
   npm run doctor -- "$PWD"
   ```
   Zero mismatches means storage, bindings, and `.ensemble/config.json` agree.
   A package-only install has no `npm` scripts; use `/ensemble` and the in-app
   `:logs` viewer instead.
3. Send one group message and confirm one turn, one work item, and one final
   row. Confirm `$Name` routing behaves as documented.
4. Confirm the AGENTS block is v7 and that project content outside the markers
   is intact.
5. Keep the pre-upgrade backup until the workspace has run successfully for a
   full session.

## If the upgrade is wrong

- Bad package or host incompatibility: [package rollback](rollback.md).
- State damaged or the wrong team restored: run `backup.rollback` for the
  automatic slot, or `backup.restore` with the pre-upgrade file.
- A failed restore is expected to leave the previous state running; see the
  recovery codes in [backup and restore](backup-restore.md#failure-and-rollback).

## Historical prerelease installs

These commands remain valid only when you deliberately need the prerelease
history. `0.1.0-rc.2` was the first public prerelease; `0.1.0-rc.3` is the
latest prerelease and stays on npm `next`.

```sh
opencode plugin add @heyimteee/ensemble@0.1.0-rc.2
opencode plugin add @heyimteee/ensemble@0.1.0-rc.3
```

The [0.1.0 release notes](release-notes-0.1.0.md) record the stable promotion;
the [rc.2 release notes](release-notes-0.1.0-rc.2.md) remain the historical
prerelease record.
