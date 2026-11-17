# Changelog

All notable changes to Ensemble are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The tag-driven release workflow reads the `## [<version>]` section for the
version in `package.json` and uses it as the GitHub release body. A version
without a non-empty section is refused by the release preflight. Ticket #278
owns the final `0.1.0` notes and the launch sign-off; the entries below are the
release scaffolding, not the launch announcement.

## [Unreleased]

- OpenCode 2.3.0 is in the supported host range. The compatibility matrix,
  peer range, and runtime preflight accept 2.2.6, 2.2.7, and 2.3.0; the
  deterministic live harness accepts the host's `#eeeeee` high-contrast focus
  text alongside exact white (ticket #286).
- Final `0.1.0` release notes, launch plan, and the macOS/Herdr verification
  record land with ticket #278 and #277.

## [0.1.0-rc.2] - 2026-11-16

Release candidate for the first public package release: one MIT-licensed
OpenCode plugin package containing the server and TUI parts.

### Added

- `@heyimteee/ensemble` package identity with the MIT license, scoped npm
  name, repository metadata, and a runtime-only `dist` allowlist.
- A Solid-compiled TUI build so the installed package loads its server, TUI,
  and RPC entries from compiled JavaScript.
- A clean-install proof through `opencode plugin add` against isolated
  OpenCode 2.2.7 hosts, including the six server tools and the `/ensemble` TUI
  route.
- Threat model, permission-model review, accepted risks, and dependency update
  automation.
- Data retention, export, delete, and the AGENTS v7 roster disclosure guidance.
- Backup/restore, upgrade, and package/state rollback guides with an injected
  failure rehearsal.
- Incident runbook, support intake, support matrix, and issue/PR templates.
- A tag-driven release workflow with a token-free dry run, npm provenance,
  a CycloneDX SBOM, and changelog-based GitHub release notes.
- A release sign-off checklist covering security, license, package contents,
  rollback, support readiness, and the clean-install proof.

### Verified

- `npm run verify` and `npm run docs:check` on the release candidate.
- The deterministic fake and native E2E matrices on OpenCode 2.2.6 and 2.2.7.
- The Node 22.23.4, 24.22.1, and 26.12.1 unit/typecheck matrix.

## [0.1.0-rc.1] - 2026-11-16

Unpublished clean-install candidate. It proved the server plugin install and
the six native tools; the TUI source entry failed to load, which led to the
built package in `0.1.0-rc.2`. Keep this entry for traceability; no public
artifact was published for it.
