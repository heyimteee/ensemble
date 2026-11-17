# Release sign-off checklist

Ticket #275. Complete every item before creating the release tag, then copy the
completed table into the release ticket and the verification record. Mark each
item **PASS**, **FAIL**, or **BLOCKED** with a linked command output or record.
A blocked check is not a pass; the release manager must state why the release
proceeds without it.

Release: `v<version>` at commit `<sha>`
Release manager: `<name>`
Date: `<YYYY-MM-DD>`

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
