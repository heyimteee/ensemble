---
title: Upgrade Ensemble
description: Move from a 0.1.0 prerelease to stable 0.1.0, verify the workspace, and roll back if needed.
version: 0.1.x
---

# Upgrade Ensemble

Move an existing install from a `0.1.0` prerelease to stable `0.1.0`, confirm
that the workspace still opens, and know the rollback path before you start.

## Before you start

- The current install is a `0.1.0` prerelease, for example `0.1.0-rc.3`.
- OpenCode is 2.2.6, 2.2.7, or 2.3.0 on Linux/tmux, with Node 22.23.4 or newer.
  macOS with Herdr is verified on OpenCode 2.2.7 only.
- No group turn is running. Finish, cancel, or let the current work settle
  before you restart the host.

## Record the current install

```sh
opencode --version
node --version
opencode plugin list
```

Keep the printed plugin version. It is the version you reinstall if you need to
roll back.

## Install stable

```sh
opencode plugin add @heyimteee/ensemble@0.1.0
opencode plugin list
```

Expected entry:

```text
ensemble.v2  0.1.0  @heyimteee/ensemble@0.1.0
```

Restart OpenCode. The plugin and its RPC surface are replaced on the next start;
there is no in-place hot swap.

## What changes on first start

The upgrade is additive. Ensemble reads the same durable rows, applies defaults,
and writes only what a later change needs.

- The workspace instruction block is reconciled to contract v7 in place.
  Project content outside the markers is preserved, and a newer recorded version
  is never downgraded.
- A workspace with a pre-ledger dispatch history gets synthesized groups on
  first access. Used hops come from the existing delegations and handoffs, caps
  are raised to at least the observed usage, and live rows without a per-call
  dispatch budget receive the group's remaining budget. In-flight work is not
  retroactively refused.
- `settings.maxDepth` is deprecated and ignored for enforcement. Depth now comes
  from `dispatchDepth` per group.
- If an older install left a partial init job, the stored phase is read from the
  last recorded phase and advances on the next run.

The roster table in contract v7 writes member names, titles, and roles into the
workspace file. If the repository is public, review those fields before the
first commit that includes the block. See
[data classes and retention](../privacy/data-and-retention.md).

## Verify the upgrade

1. Run `/ensemble` and open the workspace.
2. Confirm the group chat loads the existing transcript.
3. Send one group message and confirm one reply and one work item.
4. If you installed from a checkout, check storage, bindings, and workspace
   config:

   ```sh
   npm run doctor -- "$PWD"
   ```

   Zero mismatches means the roster, workspaces, membership, bindings, and
   dispatch ledger agree.
5. Open `AGENTS.md` and confirm the block starts with `<!-- ensemble:start v7`
   and that project content outside the markers is unchanged.

A package-only install has no `npm` scripts. Use `/ensemble` and the in-app
`:logs` viewer instead of the doctor.

## Roll back

1. Reinstall the recorded version:

   ```sh
   opencode plugin add @heyimteee/ensemble@<previous-version>
   ```

2. Restart OpenCode and confirm `opencode plugin list` shows that version.
3. Send one group message. Durable `v2/` rows are additive within the 0.x line,
   so a package-only rollback is usually enough.

If the older release reports an unknown state shape, restore state before you
start it. From a checkout:

```sh
npm run backup -- status "$PWD"
npm run backup -- rollback --confirm ROLLBACK "$PWD"
```

Restoring from a file and the full failure procedure are in
[backup and restore](../operations/backup-restore.md) and
[package rollback](../operations/rollback.md). A backup contains conversation
content; keep it private.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `opencode plugin list` still shows the prerelease | Restart the host, then repeat the install with the exact `0.1.0` version. |
| The workspace does not open | Confirm the host version is supported, then check `:logs` and the host log. |
| The `AGENTS.md` block changed unexpectedly | The block is reconciled to v7 in place. Review the diff; content outside the markers must be unchanged. |
| A work item is refused with a budget reason after the upgrade | Capture the work item and ledger state before you retry, then report it through the support path. |
| The host warns that the OpenCode release is unsupported | Move to 2.2.6, 2.2.7, or 2.3.0. |

For a broken workspace or suspected data loss, use the
[incident runbook](../support/incident-runbook.md). For a new symptom, follow
the [support policy](../support/README.md).

## Next

- [First team](first-team.md): delegate work and inspect a native session.
- [Operations](../operations/README.md): backup, restore, rollback, and
  release procedures.
- [Support](../support/README.md): what to include when the upgrade does not
  settle.
