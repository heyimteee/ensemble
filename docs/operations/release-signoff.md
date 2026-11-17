---
title: Release sign-off checklist
description: Historical 0.1.0-rc.2 sign-off checklist and evidence.
version: 0.1.0-rc.2
---

# Release sign-off checklist

Ticket #275. Complete every item before creating the release tag, then copy the
completed table into the release ticket and the verification record. Mark each
item **PASS**, **FAIL**, **BLOCKED**, or **PENDING** with a linked command
output or record. A blocked or pending check is not a pass; the release
manager must state why the release proceeds without it.

Release: `v0.1.0-rc.2` at commit `ccd13eb`
Release manager: maintainer (publish run)
Date: 2026-11-17

The table below records the released sign-off. The checklist in sections 1–9
is retained as the reusable final gate for a future release.

<a name="release-sign-off--010-rc2-released-2026-11-17"></a>

## Release sign-off — 0.1.0-rc.2 (released 2026-11-17)

This is the released sign-off for the first public prerelease. The pre-tag
checklist in sections 1–9 below remains the reusable final gate for a future
release.

| Area | Status | Evidence | Scope and remaining work |
|---|---|---|---|
| MIT license and package identity (#269) | **PASS** | [record](../verification/2026-11-16-ticket-269.md), [`LICENSE`](../../LICENSE), `package.json` | MIT text; `@heyimteee/ensemble`; scoped publish metadata; runtime-only `dist` allowlist. Published as the `0.1.0-rc.2` prerelease. The third-party runtime dependency license review remains the final pre-tag checklist item for a future release. |
| Security and privacy (#271) | **PASS** | [record](../verification/2026-11-16-ticket-271.md), [threat model](../security/threat-model.md), [permission review](../security/permission-model-review.md), [accepted risks](../security/accepted-risks.md) | Threat model, permission matrix, supported-version policy, Dependabot, handoff symlink containment. Production audit is clean; dev/peer advisories are accepted with owners and review dates. |
| Data retention, export, and delete (#272) | **PASS** | [record](../verification/2026-11-16-ticket-272.md), [data policy](../privacy/data-and-retention.md) | Scoped export/delete, 24-hour Work and 7-day log retention, AGENTS v7 roster disclosure guidance. |
| Backup/restore, upgrade, and state rollback (#273) | **PASS** | [record](../verification/2026-11-16-ticket-273.md), [backup/restore](../operations/backup-restore.md), [rollback](../operations/rollback.md) | Versioned backup document, RPC/CLI, automatic rollback slot, injected-failure rehearsal, doctor on restored state. Package downgrade is not possible until a previous public version exists. |
| Support and operator readiness (#274) | **PASS** | [record](../verification/2026-11-16-ticket-274.md), [support policy](../support/README.md), [runbook](../support/incident-runbook.md), [matrix](../support/support-matrix.md) | GitHub Issues intake, private security route, response targets, issue/PR templates, redaction rules. |
| Release workflow, publish, and provenance (#275) | **PASS (published)** | [record](../verification/2026-11-16-ticket-275.md), [release guide](../operations/release.md), [GitHub release](https://github.com/heyimteee/ensemble/releases/tag/v0.1.0-rc.2) | Tag-only publish path, npm publish with provenance, CycloneDX SBOM, GitHub prerelease, and attached assets. Published under `next`; npm also requires `latest`, so both tags point at the only version. |
| Required checks at `a7f1eb3` | **PASS (first attempt, no rerun)** | [parent #268 CI section](../verification/2026-11-17-ticket-268.md#required-ci-at-a7f1eb3) | Verify (`verify`, `live-fake`, `live-native`, `live-multilocation`, `latency-smoke`), Compatibility (OpenCode 2.2.6, 2.2.7, and 2.3.0), Docs, and Node Matrix are green. The earlier `a0c39c0` Compatibility failure and `4ccc410` reruns are superseded. |
| OpenCode 2.3.0 support (#286) | **PASS** | [parent #268 2.3.0 section](../verification/2026-11-17-ticket-268.md#opencode-230-support-286) | Supported range `2.2.6 || 2.2.7 || 2.3.0`; compatibility matrix and ruleset context added. Linux host probe 14/14, size matrix, fake E2E 416 s, loopback install PASS. 2.2.7 fake E2E still PASS. Required CI at `a7f1eb3` is green for all three hosts. macOS/Herdr remains 2.2.7 only. |
| Live TUI readiness (#287) | **PASS** | [record](../verification/2026-11-17-ticket-287.md), [CI section](../verification/2026-11-17-ticket-268.md#required-ci-at-a7f1eb3) | Fixed the harness false positive after Backspace (`:setting` → retype `s` → `:settings` restored) and header-only readiness. `live_open_ensemble` waits for the statusline and configured geometry; retype waits for `:settings` to disappear. No product runtime change; 2,121 tests; CI green. |
| Clean install (#270, #279) | **PASS** | [parent #268 public smoke](../verification/2026-11-17-ticket-268.md#public-registry-smoke), [built-package record](../verification/2026-11-16-ticket-279.md), [macOS record](../verification/2026-11-16-ticket-277.md) | Final-tip `a0c39c0` loopback install passed; the published `0.1.0-rc.2` public-registry install then passed on OpenCode 2.2.7 and 2.3.0 / Node 26.12.1 with six native tools, TUI route, and `/ensemble`. The `0.1.0-rc.1` TUI failure is superseded, not hidden. |
| Built package (#280) | **PASS** | [built-package record](../verification/2026-11-16-ticket-279.md) | Solid-compiled `dist` server/TUI/RPC entries; runtime dependencies resolve from the plugin cache; pack guard passes. |
| macOS/Herdr (#277) | **PASS** | [macOS record](../verification/2026-11-16-ticket-277.md) | Installed package, six server tools, Herdr/Ghostty TUI route, full manual checklist including 1.7 pane-bounded Shift+drag with explicit `copy_to_clipboard`, fake E2E and size matrix. No checklist item unrun. Automatic copy-on-release is not claimed (Ghostty `copy-on-select` off); Herdr prefix control is inconclusive. Closed at `7efd9a6`. |
| Regression fixes (#281–#284) | **PASS** | [macOS record](../verification/2026-11-16-ticket-277.md) | Init interruption restore, `NO_COLOR` Work and transcript suppression, and durable Work feed reconstruction were re-verified on macOS. |
| Scale, soak, and no telemetry (#276) | **PASS for 4h on OpenCode 2.2.7 and 2.3.0** | [soak record](../verification/2026-11-17-soak.md), [record](../verification/2026-11-16-ticket-276.md), [scale policy](scale-and-monitoring.md) | Enforced 4-hour soak at `b194b95`: PASS on both supported hosts. 2.2.7: 240 samples, 14,439 s, 5,234 messages, 0 failures, 92.59 MiB/h and 18.71 MiB/1k, settled, no findings. 2.3.0: 240 samples, 5,240 messages, 0 failures, 94.89 MiB/h and 19.14 MiB/1k, settled, no findings. Harness, support bundle, and no-upload stance remain PASS. |
| Package-level downgrade rollback (#273) | **PENDING** | [rollback guide](rollback.md#rehearsal) | No previous public package exists, so `opencode plugin add @heyimteee/ensemble@<previous>` cannot be rehearsed. State rollback is rehearsed. |
| Final artifact identity | **PASS** | [parent #268 record](../verification/2026-11-17-ticket-268.md#final-tip-evidence) | Final-tip install and 2.2.7/2.3.0 fake E2E pass at `a0c39c0`; required CI is green at `a7f1eb3`; #287 introduces no product runtime change; the full macOS checklist including 1.7 is PASS. 2.2.x soak evidence is from `b194b95` and the 2.3.0 soak is supported. The published tarball was rebuilt by `prepack` from the tagged release commit. |
| Final tag and npm publish | **PASS** | [GitHub release](https://github.com/heyimteee/ensemble/releases/tag/v0.1.0-rc.2) | Tag `v0.1.0-rc.2` exists at release commit `ccd13eb`; npm serves `0.1.0-rc.2`. npm dist-tags are `latest: 0.1.0-rc.2` and `next: 0.1.0-rc.2`. |
| Provenance attestation and GitHub release assets | **PASS** | [GitHub release](https://github.com/heyimteee/ensemble/releases/tag/v0.1.0-rc.2) | npm provenance; GitHub prerelease with tarball, CycloneDX SBOM, CHANGELOG, and release notes attached. |
| Public-registry install smoke | **PASS** | [parent #268 public smoke](../verification/2026-11-17-ticket-268.md#public-registry-smoke) | OpenCode 2.2.7 and 2.3.0, Node 26.12.1; public package source, `ensemble.v2 0.1.0-rc.2`, server/TUI/RPC active, six tools, `/ensemble` with no plugin failure. Isolated roots were removed. |
| npm `latest` behavior | **PASS with caveat** | npm registry | npm requires `latest` and rejects deleting it with E400. Because this is the first/only version, `latest` points at the RC even though the workflow used `--tag next`. |
| Launch announcement | **PENDING / not claimed** | [launch plan](launch-plan-0.1.0-rc.2.md) | Separate decision; the release itself is published. |

**Decision: RELEASED.** `0.1.0-rc.2` is live on npm and as GitHub prerelease
`v0.1.0-rc.2`. Every verification gate is PASS: required CI at `a7f1eb3`, both
4-hour soaks, the public installs on 2.2.7 and 2.3.0, the full macOS checklist
including 1.7, and #281–#287.

The only inherent gap is the package-downgrade rehearsal, because there is no
previous public version. The launch announcement is a separate, unclaimed
decision. npm `latest` points at the RC because npm requires the tag and this is
the only published version.

## 1. Release identity and notes

- [ ] `package.json` and `package-lock.json` declare the same version, and the
      tag is exactly `v<version>`.
- [ ] `CHANGELOG.md` has a non-empty section for that version; the release
      preflight extracted it into `RELEASE_NOTES.md`.
- [ ] The release notes were reviewed by a human (#278 owns the final notes and
      the launch announcement).
- [ ] No dependency, workflow, or packaging change landed after the last green
      required check.

## 2. Security

- [ ] `npm run verify` and `npm run docs:check` pass on the release commit.
- [ ] `npm audit --audit-level=high` is clean, or every remaining advisory is
      listed in [accepted risks](../security/accepted-risks.md) with an owner
      and review date.
- [ ] [Threat model](../security/threat-model.md) and
      [permission-model review](../security/permission-model-review.md) still
      match the code; no new filesystem, shell, tool, cross-workspace, skill, or
      approval surface is unexplained.
- [ ] `SECURITY.md` supported versions cover this release line; an unpublished
      release candidate is unsupported until it is the latest published
      `0.1.x` release, and the private reporting path works.
- [ ] The release workflow contains no secret echo, shell tracing, private
      absolute path, or credential in an artifact. `NPM_TOKEN` is a repository
      secret exposed only to the publish step.
- [ ] Provenance is enabled (`id-token: write`, `--provenance`), and the npm
      attestation is visible after publish.
- [ ] Dependabot configuration and security-update settings are current, or the
      gap is recorded.

## 3. License and legal

- [ ] `LICENSE` contains the MIT text; `package.json` says `"license": "MIT"`;
      the README still states the MIT license.
- [ ] The tarball ships `LICENSE` and does not ship a conflicting license or
      notice.
- [ ] Third-party licenses were reviewed for the runtime dependencies
      (`@opentui/core`, `@opentui/solid`, `solid-js`, and the host-supplied
      `@opencode/plugin`). Any copyleft or missing-license dependency is
      recorded.
- [ ] No trademark, attribution, or export-control issue is introduced by the
      package name, README, or release notes.

## 4. Package contents

- [ ] `npm pack --dry-run --json` was reviewed: the tarball is `package.json`,
      `README.md`, `LICENSE`, and the built `dist/` JavaScript only.
- [ ] No tests, fixtures, docs, scripts, raw TypeScript, source maps,
      `node_modules`, or development-only modules are packed.
- [ ] All three exports resolve from the tarball (`.`, `./tui`, `./rpc`), and
      `dist/tui/index.js` uses the Solid OpenTUI runtime.
- [ ] The package name is `@heyimteee/ensemble`, the version is exact, and
      `publishConfig.access` is `public`.
- [ ] A CycloneDX SBOM was generated with `npm sbom --sbom-format=cyclonedx`
      and attached to the GitHub release.
- [ ] The tarball was produced from the tagged commit, not an uncommitted
      working tree.

## 5. Clean-install proof

- [ ] `npm run test:install:rc` passed against an isolated OpenCode **2.3.0**
      host (`OPENCODE_BIN=<opencode-2.3.0>/bin/opencode`), using a loopback
      registry or a Git spec. No workspace link and no user global
      configuration were used.
- [ ] `opencode plugin list` reports the package source and exact version.
- [ ] One host turn registered the six native Ensemble tools.
- [ ] The TUI loaded the Ensemble route and the `/ensemble` command.
- [ ] The record for this version is linked from
      [the evidence index](../contributing/evidence.md#verification-records), and
      its environment, commands, passes, and blocked checks are recorded.
- [ ] The same install path is scheduled or completed on macOS/Herdr (#277); a
      blocked macOS run is recorded as blocked, not passed.

## 6. Required checks and dry run

- [ ] Every required check is green on the release commit: `verify`,
      `live-fake`, `live-native`, `live-multilocation`, `latency-smoke`,
      `docs:check`, `verify (Node 22.23.4)`, `verify (Node 24.22.1)`,
      `verify (Node 26.12.1)`, `OpenCode 2.2.6`, `OpenCode 2.2.7`, and
      `OpenCode 2.3.0`.
- [ ] The `Release` workflow dry run passed: preflight, package, SBOM, and
      `npm publish --dry-run` with no registry token.
- [ ] No required status context was renamed or invented; the ruleset matches
      `REQUIRED_STATUS_CHECKS` in `src/v2/ci-workflows.ts`.
- [ ] Any branch-protection bypass is recorded with its reason.

## 7. Rollback readiness

- [ ] The previous installable version is known and can be reinstalled with
      `opencode plugin add @heyimteee/ensemble@<previous-version>`.
- [ ] The pre-upgrade backup exists and the restore path was rehearsed for this
      candidate ([backup and restore](backup-restore.md)).
- [ ] [Package rollback](rollback.md) and [upgrade](upgrade.md) still describe
      the shipped state shape; no undocumented migration landed.
- [ ] The deprecate-versus-unpublish decision is recorded. Prefer `npm
      deprecate` plus a patch release; `npm unpublish` is reserved for the
      72-hour window and a version nothing depends on.
- [ ] The pre-upgrade state and rollback slot are kept until the release has
      run successfully for a full session.

## 8. Support readiness

- [ ] [Support policy](../support/README.md),
      [incident runbook](../support/incident-runbook.md), and
      [support matrix](../support/support-matrix.md) match the release.
- [ ] Issue and pull-request templates are present and warn against posting
      credentials or conversation content.
- [ ] Known limitations, supported OpenCode/Node versions, and the
      no-telemetry/local-diagnostics stance are current.
- [ ] Support response targets are achievable for the launch window, or the
      launch plan states the reduced capacity.
- [ ] The launch plan and announcement are owned (#278), and the release notes
      link the support path.

## 9. Publish and post-release

- [ ] The tag was created on the merged release commit and pushed; no plain
      branch push can publish.
- [ ] npm trusted publishing/provenance and `NPM_TOKEN` are configured; the
      publish job used `--provenance --access public`.
- [ ] The GitHub release exists, its body is the changelog section, and the
      notes, changelog, tarball, and SBOM are attached.
- [ ] The npm provenance attestation and the release assets were checked after
      publish.
- [ ] The macOS/Herdr run (#277) and the launch sign-off (#278) are tracked;
      the parent spec #268 closes only after the release verification record.
- [ ] The `NPM_TOKEN` rotation/revocation decision is recorded.
