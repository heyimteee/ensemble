---
title: Ensemble 0.1.0 release notes
description: Stable 0.1.0 release notes, package contents, and verification summary.
version: 0.1.0
---

# Ensemble 0.1.0 release notes

Status: **stable 0.x release.** Published from tag `v0.1.0`; the runtime is
identical to `0.1.0-rc.3`, which completed the release-candidate validation.
Prereleases remain available under the npm `next` tag.

## Release identity

| Item | Value |
|---|---|
| Package | `@heyimteee/ensemble` |
| Version | `0.1.0` |
| License | MIT |
| Supported OpenCode | `2.2.6`, `2.2.7`, `2.3.0` |
| Node floor | `22.23.4`; live suites use `26.12.1` |
| npm dist-tags | `latest: 0.1.0`, `next: 0.1.0-rc.3` |
| Publish path | npm trusted publishing (OIDC), provenance, CycloneDX SBOM |
| GitHub release | Normal release, not a prerelease |

## Install

```sh
opencode plugin add @heyimteee/ensemble@0.1.0
opencode plugin list
```

`plugin list` must show `ensemble.v2` at `0.1.0` from the public package source.
Restart OpenCode, then open `/ensemble` or the **Open Ensemble** palette command.

Do not also load the same plugin from `.opencode/plugins/`; that creates a
duplicate plugin ID. Do not use a Git spec with OpenCode 2.2.7: Git dependency
preparation is broken upstream. Use npm.

## Upgrade and rollback

The package and its durable state are described in
[Upgrade](upgrade.md), [Package rollback](rollback.md), and
[Backup and restore](backup-restore.md). Keep a state backup before upgrading.
This is the first public stable version; there is no earlier public package to
downgrade to, so package rollback is not yet rehearsable.

## Verification

- Required CI green across OpenCode 2.2.6/2.2.7/2.3.0 and Node
  22.23.4/24.22.1/26.12.1.
- 4-hour enforced soak PASS on OpenCode 2.2.7 and 2.3.0.
- Full macOS/Herdr checklist PASS, including pane-bounded mouse selection.
- Public-registry install smoke PASS on OpenCode 2.2.7 and 2.3.0.
- The release uses OIDC trusted publishing; no long-lived npm token is used.

## Known limitations

- Windows/WSL are out of scope.
- Git-spec installs fail upstream in OpenCode 2.2.7.
- Herdr prefix control is inconclusive host evidence; automatic copy-on-release
  follows the host's Ghostty setting.
- There is no earlier public version, so a package downgrade is not rehearsed.
- This is a 0.x release: minor versions may still change APIs.
- No telemetry. Diagnostics are local and must be redacted before sharing.

## Support

- Bugs and usage questions: <https://github.com/heyimteee/ensemble/issues/new/choose>
- Security: private reporting through [SECURITY.md](../../SECURITY.md).
- Broken workspace, failed upgrade, or suspected data loss: follow the
  [incident runbook](../support/incident-runbook.md).
