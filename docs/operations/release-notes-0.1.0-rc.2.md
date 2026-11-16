# Ensemble 0.1.0-rc.2 release notes

Status: **release candidate, not published at the time of writing.** The
public npm version/tag, GitHub release, and announcement are human-gated and
pending. This note describes the artifact that was built, installed through
`opencode plugin add`, and checked on Linux and macOS.

Ensemble is a persistent agent team inside OpenCode. One plugin package carries
the server that owns state, routing, Work, native sessions, and RPC, plus the
TUI workspace and the `/ensemble` route. This is the first package release
candidate.

## Release identity

| Item | Value |
|---|---|
| Package | `@heyimteee/ensemble` |
| Version | `0.1.0-rc.2` |
| License | MIT |
| Supported OpenCode | `2.2.6` and `2.2.7` |
| Node floor | `22.23.4`; live suites use `26.12.1` |
| npm dist-tag when published | `next` (a prerelease never becomes `latest`) |
| Public release tag | Not cut; pending the remaining manual check and publish approval |
| Verification tag | `rc-0.1.0-rc.2` (evidence base at `d74fc3d`; it predates the #281–#284 fixes) |

The candidate version is unchanged. No rebuild or version bump is planned for
the remaining manual check. The final public version and tag are cut only
after that check and the human publish approval. If the approved artifact stays
at `0.1.0-rc.2`, the workflow requires the tag `v0.1.0-rc.2` and publishes
under `next`; a final `0.1.0` is a separate version and tag. Do not publish
from the older `rc-0.1.0-rc.2` evidence tag.

## What is in this candidate

- MIT-licensed package identity with a runtime-only `dist/` tarball.
- A compiled server, TUI, and RPC package; the TUI uses the Solid OpenTUI
  transform and resolves its runtime dependencies from the plugin cache.
- A clean-install proof against isolated OpenCode 2.2.7 hosts: six native
  Ensemble tools, the installed TUI route, and the `/ensemble` command.
- Security and privacy work: threat model, permission-model review, accepted
  risks, supported-version security policy, Dependabot updates, scoped data
  export and delete, and the AGENTS v7 roster disclosure guidance.
- Backup/restore, upgrade, and package/state rollback procedures, including a
  rehearsed failed-restore path.
- A tag-driven release workflow with a token-free dry run, npm provenance, a
  CycloneDX SBOM, and changelog-based GitHub release notes.
- macOS/Herdr verification of the installed package through SSH, including the
  deterministic fake E2E.
- Fixes in this candidate: interrupted init restores `AGENTS.md` (#281),
  `NO_COLOR` suppresses Work and transcript decoration (#282, #284), and the
  Work feed rebuilds after a service restart (#283).

## Install after publish

Pin the exact candidate; do not rely on `latest` while a prerelease is the only
package on the `next` channel.

```sh
opencode plugin add @heyimteee/ensemble@0.1.0-rc.2
opencode plugin list
```

`opencode plugin list` must show `ensemble.v2` with version `0.1.0-rc.2` and the
package source `@heyimteee/ensemble@0.1.0-rc.2`. Restart OpenCode after the
install, then open `/ensemble` or the **Open Ensemble** palette command.

Do not also load the same plugin from `.opencode/plugins/`; that creates a
duplicate plugin ID. Do not use a Git spec with OpenCode 2.2.7: `github:`,
`git+https://`, and `owner/repo#tag` installs fail upstream during Git
dependency preparation, before Ensemble is loaded.

## Upgrade

1. Record the current install and back up durable state:
   ```sh
   opencode --version
   node --version
   opencode plugin list
   npm run backup -- export --out ./ensemble-backup.json "$PWD"
   ```
   The backup command runs from a checkout and contains conversation content;
   keep the file private.
2. Stop the OpenCode host. The plugin and its RPC surface are replaced on the
   next start; there is no in-place hot swap.
3. Install the exact version, restart, and verify:
   ```sh
   opencode plugin add @heyimteee/ensemble@0.1.0-rc.2
   opencode plugin list
   ```
4. Open the workspace, confirm the AGENTS block is v7 with project content
   outside the markers intact, and send one group message. Confirm one turn,
   one Work card, and one final row.
5. Keep the pre-upgrade backup until the workspace has run successfully for a
   full session.

An explicit `nativeFirst: "off"` or `"shadow"` is preserved. Durable state
migrations are additive; see [Upgrade from the pre-release](upgrade.md) for the
full behavior table.

## Rollback

If `0.1.0-rc.2` is wrong, reinstall the previous exact package and restart:

```sh
opencode plugin add @heyimteee/ensemble@<previous-version>
opencode plugin list
```

There is no earlier public npm version for this first candidate, so a
package-level downgrade is not available yet. For this release, rollback means
restoring the pre-upgrade state backup and either removing the plugin entry or
returning to the checkout install. Restore state only when the older code
cannot read newer rows. Do not restore a backup produced by a newer
`formatVersion`.

The full decision table, automatic rollback slot, and failure codes are in
[Package rollback](rollback.md) and [Backup and restore](backup-restore.md).
Keep the pre-upgrade backup and rollback slot until the rolled-back workspace
has run successfully.

## Support

Support is best effort through GitHub Issues:

- Bug report or support request:
  <https://github.com/heyimteee/ensemble/issues/new/choose>
- Security vulnerability: private reporting through
  [SECURITY.md](../../SECURITY.md). Never open a public issue.
- Broken workspace, failed upgrade, or suspected data loss: follow the
  [incident runbook](../support/incident-runbook.md) first.

Include the Ensemble version, OpenCode and Node versions, operating system,
terminal host, install method, exact commands, and redacted evidence. Never
post credentials, conversation content, private project files, or unredacted
logs. Maintainer response targets are best effort, not an SLA.

## Known limitations

- **Windows is out of scope.** Native Windows and WSL are untested.
- **macOS mouse drag is not claimed.** Manual checklist item 1.7 was not run,
  so selection and drag-copy behavior are unverified. Cmd+C and Cmd+V passed.
- **Herdr prefix control is inconclusive.** The host-level test produced no tab
  or pane; no Ensemble key was observed to be intercepted, but the host claim
  is not proven.
- **Git-spec installs fail upstream in OpenCode 2.2.7.** Use the npm package or
  a loopback registry; do not recommend Git installs for this host.
- **No telemetry.** Ensemble does not upload logs or usage data. Diagnostics
  are local, and the support bundle is opt-in and redacted.
- **The 4-hour soak is a nightly/opt-in gate.** The recorded evidence is a
  smoke run; the multi-hour gate has not been claimed as passed.
- **macOS size-matrix load probe is Linux-only.** Exact sizes pass with the
  load probe skipped. Braille glyphs depend on terminal font fallback on the
  tested Mac.
- **The package is not on the public registry yet.** The commands above become
  valid only after the human-gated publish completes.

## Proven and pending

| Item | Status | Evidence |
|---|---|---|
| Build, pack, and runtime-only contents | **PASS** | [#269](../verification/2026-11-16-ticket-269.md), [#279](../verification/2026-11-16-ticket-279.md) |
| Clean install through `opencode plugin add` (Linux, OpenCode 2.2.7) | **PASS** | [#279](../verification/2026-11-16-ticket-279.md) |
| Six native tools, installed TUI route, `/ensemble` | **PASS** | [#279](../verification/2026-11-16-ticket-279.md), [#277](../verification/2026-11-16-ticket-277.md) |
| macOS/Herdr install, TUI, fake E2E, checklist except 1.7 | **PASS except 1.7** | [#277](../verification/2026-11-16-ticket-277.md) |
| macOS mouse drag (1.7) | **PENDING** | Not run; no selection/copy claim |
| Public npm publish, tag, GitHub release, announcement | **PENDING** | Human-gated; see [launch plan](launch-plan-0.1.0-rc.2.md) |
| 4-hour soak | **PENDING** | Nightly/opt-in gate; smoke only in [#276](../verification/2026-11-16-ticket-276.md) |

The full release decision, sign-offs, and remaining gates are in
[Release sign-off](release-signoff.md#candidate-sign-off--010-rc2-2026-11-17)
and [Parent #268 verification](../verification/2026-11-17-ticket-268.md).
