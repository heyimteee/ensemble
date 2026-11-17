# Release sign-off checklist

Ticket #275. Complete every item before creating the release tag, then copy the
completed table into the release ticket and the verification record. Mark each
item **PASS**, **FAIL**, **BLOCKED**, or **PENDING** with a linked command
output or record. A blocked or pending check is not a pass; the release
manager must state why the release proceeds without it.

Release: `v<version>` at commit `<sha>`
Release manager: `<name>`
Date: `<YYYY-MM-DD>`

The three fields above are for the final tagged release. The candidate record
below is dated separately.

## Candidate sign-off — 0.1.0-rc.2 (2026-11-17)

This is the release-candidate sign-off, not the final publish authorization.
The pre-tag checklist in sections 1–9 below remains the final gate. A pending
or blocked item is not a pass.

| Area | Status | Evidence | Scope and remaining work |
|---|---|---|---|
| MIT license and package identity (#269) | **PASS** | [record](../verification/2026-11-16-ticket-269.md), [`LICENSE`](../../LICENSE), `package.json` | MIT text; `@heyimteee/ensemble`; scoped publish metadata; runtime-only `dist` allowlist. No public publish. The third-party runtime dependency license review remains the final pre-tag checklist item. |
| Security and privacy (#271) | **PASS** | [record](../verification/2026-11-16-ticket-271.md), [threat model](../security/threat-model.md), [permission review](../security/permission-model-review.md), [accepted risks](../security/accepted-risks.md) | Threat model, permission matrix, supported-version policy, Dependabot, handoff symlink containment. Production audit is clean; dev/peer advisories are accepted with owners and review dates. |
| Data retention, export, and delete (#272) | **PASS** | [record](../verification/2026-11-16-ticket-272.md), [data policy](../privacy/data-and-retention.md) | Scoped export/delete, 24-hour Work and 7-day log retention, AGENTS v7 roster disclosure guidance. |
| Backup/restore, upgrade, and state rollback (#273) | **PASS** | [record](../verification/2026-11-16-ticket-273.md), [backup/restore](../operations/backup-restore.md), [rollback](../operations/rollback.md) | Versioned backup document, RPC/CLI, automatic rollback slot, injected-failure rehearsal, doctor on restored state. Package downgrade is not possible until a previous public version exists. |
| Support and operator readiness (#274) | **PASS** | [record](../verification/2026-11-16-ticket-274.md), [support policy](../support/README.md), [runbook](../support/incident-runbook.md), [matrix](../support/support-matrix.md) | GitHub Issues intake, private security route, response targets, issue/PR templates, redaction rules. |
| Release workflow and provenance configuration (#275) | **PASS (dry run)** | [record](../verification/2026-11-16-ticket-275.md), [release guide](../operations/release.md) | Tag-only publish path, token-free dry run, changelog notes, `--provenance`, CycloneDX SBOM, sign-off checklist. No real publish or attestation yet. |
| Required checks at `a7f1eb3` | **PASS (first attempt, no rerun)** | [parent #268 CI section](../verification/2026-11-17-ticket-268.md#required-ci-at-a7f1eb3) | Verify (`verify`, `live-fake`, `live-native`, `live-multilocation`, `latency-smoke`), Compatibility (OpenCode 2.2.6, 2.2.7, and 2.3.0), Docs, and Node Matrix are green. The earlier `a0c39c0` Compatibility failure and `4ccc410` reruns are superseded. |
| OpenCode 2.3.0 support (#286) | **PASS** | [parent #268 2.3.0 section](../verification/2026-11-17-ticket-268.md#opencode-230-support-286) | Supported range `2.2.6 || 2.2.7 || 2.3.0`; compatibility matrix and ruleset context added. Linux host probe 14/14, size matrix, fake E2E 416 s, loopback install PASS. 2.2.7 fake E2E still PASS. Required CI at `a7f1eb3` is green for all three hosts. macOS/Herdr remains 2.2.7 only. |
| Live TUI readiness (#287) | **PASS** | [record](../verification/2026-11-17-ticket-287.md), [CI section](../verification/2026-11-17-ticket-268.md#required-ci-at-a7f1eb3) | Fixed the harness false positive after Backspace (`:setting` → retype `s` → `:settings` restored) and header-only readiness. `live_open_ensemble` waits for the statusline and configured geometry; retype waits for `:settings` to disappear. No product runtime change; 2,121 tests; CI green. |
| Clean install (#270, #279) | **PASS** | [parent #268 final-tip evidence](../verification/2026-11-17-ticket-268.md#final-tip-evidence), [built-package record](../verification/2026-11-16-ticket-279.md), [macOS record](../verification/2026-11-16-ticket-277.md) | Final-tip `a0c39c0` install through `opencode plugin add` into isolated OpenCode 2.2.7 / Node 26.12.1: PASS; 507,907 bytes; six native tools, TUI route, and `/ensemble` loaded. The earlier `b194b95` install passed at 124 runtime files and 507,824 bytes. Still a loopback registry, not public npm; a public-registry smoke of the final tagged build is pending. The `0.1.0-rc.1` TUI failure is superseded, not hidden. |
| Built package (#280) | **PASS** | [built-package record](../verification/2026-11-16-ticket-279.md) | Solid-compiled `dist` server/TUI/RPC entries; runtime dependencies resolve from the plugin cache; pack guard passes. |
| macOS/Herdr (#277) | **PASS** | [macOS record](../verification/2026-11-16-ticket-277.md) | Installed package, six server tools, Herdr/Ghostty TUI route, full manual checklist including 1.7 pane-bounded Shift+drag with explicit `copy_to_clipboard`, fake E2E and size matrix. No checklist item unrun. Automatic copy-on-release is not claimed (Ghostty `copy-on-select` off); Herdr prefix control is inconclusive. Closed at `7efd9a6`. |
| Regression fixes (#281–#284) | **PASS** | [macOS record](../verification/2026-11-16-ticket-277.md) | Init interruption restore, `NO_COLOR` Work and transcript suppression, and durable Work feed reconstruction were re-verified on macOS. |
| Scale, soak, and no telemetry (#276) | **PASS for 4h on OpenCode 2.2.7 and 2.3.0** | [soak record](../verification/2026-11-17-soak.md), [record](../verification/2026-11-16-ticket-276.md), [scale policy](scale-and-monitoring.md) | Enforced 4-hour soak at `b194b95`: PASS on both supported hosts. 2.2.7: 240 samples, 14,439 s, 5,234 messages, 0 failures, 92.59 MiB/h and 18.71 MiB/1k, settled, no findings. 2.3.0: 240 samples, 5,240 messages, 0 failures, 94.89 MiB/h and 19.14 MiB/1k, settled, no findings. Harness, support bundle, and no-upload stance remain PASS. |
| Package-level downgrade rollback (#273) | **PENDING** | [rollback guide](rollback.md#rehearsal) | No previous public package exists, so `opencode plugin add @heyimteee/ensemble@<previous>` cannot be rehearsed. State rollback is rehearsed. |
| Final artifact identity | **PASS for `a0c39c0` + `a7f1eb3` CI; final tagged build PENDING** | [parent #268 record](../verification/2026-11-17-ticket-268.md#final-tip-evidence) | Final-tip install and 2.2.7/2.3.0 fake E2E pass at `a0c39c0`; required CI is green at `a7f1eb3`; #287 introduces no product runtime change; the full macOS checklist including 1.7 is PASS. 2.2.x soak evidence is from `b194b95` and the 2.3.0 soak is supported. If any runtime source changes, rebuild and rerun the clean-install proof; do not publish an unproven runtime. The final tag rebuild gets a public-registry smoke. |
| Final tag, npm publish, provenance attestation, GitHub release | **PENDING** | [launch plan](launch-plan-0.1.0-rc.2.md) | Human-gated. Requires the approved commit and version, the matching `v<version>` tag, credentials, green required checks, and a successful publish. |
| Public-registry install smoke | **PENDING** | [launch plan](launch-plan-0.1.0-rc.2.md) | Must pass from the published registry on a supported host before announcing. |
| Launch announcement | **PENDING** | [launch plan](launch-plan-0.1.0-rc.2.md) | Must follow a successful publish and install smoke. |

**Decision: READY FOR PUBLISH APPROVAL.** Every verification gate is PASS:
required CI at `a7f1eb3`, both 4-hour soaks, the final installs on 2.2.7 and
2.3.0, the full macOS checklist including 1.7, and #281–#287.

**Publish action: HOLD until credentials and human approval exist.** The final
tag, npm publish, provenance attestation, GitHub release, public-registry
install smoke, and announcement are not claimed. The only inherent gap is the
package-downgrade rehearsal, because there is no previous public version.

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
- [ ] `SECURITY.md` supported versions cover this release line; a release
      candidate is explicitly unsupported for security reports until it is the
      latest published `0.1.x` release, and the private reporting path works.
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
      [the verification index](../README.md), and its environment, commands,
      passes, and blocked checks are recorded.
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
