---
title: Documentation redirect map
description: Where entries from the old documentation index moved.
version: 0.1.x
---

# Documentation redirect map

The `0.1.x` docs reorganized the old single index into user sections and a
separate evidence index. **No documentation file path changed**, so existing
relative links to a page still resolve. What changed is where each page is
listed and reached from navigation.

Use this map when following an old bookmark, an old section anchor, or a link
from a historical record. `npm run docs:check` keeps the section indexes, the
style guide, and this map reachable from the [docs home](README.md).

## Site redirects

The published site uses clean URLs under `/ensemble/` and rewrites each section
`README.md` to its directory URL. GitHub Pages cannot read `_redirects`, so the
site build emits meta-refresh pages for the old URL forms. The generated map
covers:

- the old docs home (`/docs/`, `/docs/README.html`, `/docs.html`) to `/`;
- section README and `.md`/`.html` forms such as
  `/getting-started/README.html` to `/getting-started/`;
- the old docs home alias `/docs/` to `/`.

Section landing pages are served from their directory routes
(`/getting-started/`, `/reference/`). A separate `.html` alias is not emitted
because it would shadow the real directory index on some static servers.

The site build fails when a redirect target is not a built page or a redirect
would overwrite a real page. See
[`docs-site-check`](../scripts/docs-site-check.mjs) and
[`docs-site-artifacts`](../scripts/docs-site-artifacts.mjs).

## Section redirects

| Old `docs/README.md` section | New home |
|---|---|
| Product | [Docs home](README.md) for the overview; [Reference](reference/README.md) for compatibility and look-up material |
| Working agreements | [Contributing](contributing/README.md) for workflow; [Evidence index](contributing/evidence.md) for ADRs; [Security](security/README.md) and [Privacy](privacy/README.md) for their own sections |
| Support | [Support](support/README.md) |
| Operations | [Operations](operations/README.md) |
| Verification | [Evidence index: verification records](contributing/evidence.md#verification-records) |
| Architecture status | [Evidence index: implementation and assessments](contributing/evidence.md#implementation-and-assessments) |

## Product entries

| Old index entry | New home |
|---|---|
| Project overview (`README.md`) | [Root README](../README.md) (path unchanged); [docs home](README.md) |
| Changelog (`CHANGELOG.md`) | [Changelog](../CHANGELOG.md) (path unchanged) |
| Domain glossary (`GLOSSARY.md`) | [Domain glossary](../GLOSSARY.md) (path unchanged); canonical terms in [the style guide](style-guide.md#canonical-terms) |
| Implementation and acceptance notes (`docs/implementation.md`) | [Evidence index: implementation](contributing/evidence.md#implementation-and-assessments) |
| Scale, soak, and local diagnostics (`docs/operations/scale-and-monitoring.md`) | [Operations: diagnosis and capacity](operations/README.md#diagnosis-and-capacity); evidence remains [here](contributing/evidence.md#verification-records) |
| v2 product specification (#17) | External issue link; see [Contributing](contributing/README.md) for workflow |
| v2 implementation tickets (#18–#29) | External issue links; see [Contributing](contributing/README.md) for workflow |
| Historical v1 specification (#1) | External issue link; historical only |
| OpenCode host support range (`docs/compatibility/opencode-host-range.md`) | [Reference: supported hosts](reference/supported.md); evidence in [the evidence index](contributing/evidence.md#compatibility-evidence) |
| OpenCode 2.2.1 compatibility report (`docs/compatibility/opencode-2.2.1.md`) | [Reference: historical compatibility](reference/README.md#historical-compatibility); evidence in [the evidence index](contributing/evidence.md#compatibility-evidence) |

## Working-agreement entries

| Old index entry | New home |
|---|---|
| ADR index (`docs/adr/README.md`) | [Evidence index: architecture decisions](contributing/evidence.md#architecture-decisions) |
| ADR 0001, 0009, 0010, 0011, and every other ADR (`docs/adr/*.md`) | [Evidence index: architecture decisions](contributing/evidence.md#architecture-decisions); file paths unchanged |
| Agent instructions (`AGENTS.md`) | [Contributing](contributing/README.md) (path unchanged) |
| Handoff contract (`docs/agents/handoff.md`) | [Contributing: review and process](contributing/README.md#review-and-process) |
| OpenCode/OpenTUI runtime guide (`docs/agents/opencode-tui-runtime.md`) | [Contributing: before you start](contributing/README.md#before-you-start) |
| Issue tracker (`docs/agents/issue-tracker.md`) | [Contributing: before you start](contributing/README.md#before-you-start) |
| Labels (`docs/agents/triage-labels.md`) | [Contributing: before you start](contributing/README.md#before-you-start) |
| Review workflow (`docs/agents/review-workflow.md`) | [Contributing: review and process](contributing/README.md#review-and-process) |
| Reviewer standards (`docs/agents/review-standards.md`) | [Contributing: review and process](contributing/README.md#review-and-process) |
| Domain document conventions (`docs/agents/domain.md`) | [Contributing: review and process](contributing/README.md#review-and-process) |
| Contributing (`CONTRIBUTING.md`) | [Contributing hub](contributing/README.md) (root path unchanged) |
| Security policy (`SECURITY.md`) | [Security](security/README.md) (root path unchanged) |
| Threat model (`docs/security/threat-model.md`) | [Security: security documents](security/README.md#security-documents) |
| Permission-model review (`docs/security/permission-model-review.md`) | [Security: security documents](security/README.md#security-documents) |
| Accepted risks (`docs/security/accepted-risks.md`) | [Security: security documents](security/README.md#security-documents) |
| Data classes, retention, export, and delete (`docs/privacy/data-and-retention.md`) | [Privacy](privacy/README.md) |

## Support entries

| Old index entry | New home |
|---|---|
| Support policy (`docs/support/README.md`) | [Support](support/README.md) (path unchanged) |
| Incident runbook (`docs/support/incident-runbook.md`) | [Support](support/README.md) and [Operations: recovery](operations/README.md#recovery) |
| Support matrix and known limitations (`docs/support/support-matrix.md`) | [Support](support/README.md) and [Getting started: before you install](getting-started/README.md#before-you-install) |

## Operations entries

| Old index group | New home |
|---|---|
| Backup and restore (`docs/operations/backup-restore.md`) | [Operations: recovery](operations/README.md#recovery) |
| Upgrade from the pre-release (`docs/operations/upgrade.md`) | [Operations: recovery](operations/README.md#recovery) |
| Package rollback (`docs/operations/rollback.md`) | [Operations: recovery](operations/README.md#recovery) |
| Release operations (`docs/operations/release.md`) | [Operations: release](operations/README.md#release) |
| Release notes for 0.1.0 (`docs/operations/release-notes-0.1.0.md`) | [Operations: release](operations/README.md#release) |
| Release notes for 0.1.0-rc.2 (`docs/operations/release-notes-0.1.0-rc.2.md`) | [Operations: release history](operations/README.md#release-history) |
| Launch plan for 0.1.0-rc.2 (`docs/operations/launch-plan-0.1.0-rc.2.md`) | [Operations: release history](operations/README.md#release-history) |
| Release sign-off checklist (`docs/operations/release-signoff.md`) | [Operations: release](operations/README.md#release) |
| Scale, soak, and local diagnostics (`docs/operations/scale-and-monitoring.md`) | [Operations: diagnosis and capacity](operations/README.md#diagnosis-and-capacity) |

## Verification entries

Every record that appeared under the old `Verification` section, including the
current release, soak, compatibility, security, documentation, native-first,
accessibility, and v5.x records, now lives in the
[evidence index](contributing/evidence.md#verification-records). The file paths
under `docs/verification/` are unchanged.

This includes every record pattern listed below:

- `docs/verification/<date>-*.md`
- `docs/verification/flake-policy.md`
- `docs/verification/latency-budget.md`
- `docs/verification/macos-herdr-checklist.md`
- `docs/verification/terminal-accessibility-checklist.md`

## Architecture status

The old **Architecture status** paragraph moved to the
[evidence index](contributing/evidence.md#implementation-and-assessments) and
the [implementation notes](implementation.md). User-facing architecture
concepts belong in [Concepts](concepts/README.md).

## Unchanged root pages

These paths did not move and remain the source of truth:

| Page | Path |
|---|---|
| Product overview and install | [`README.md`](../README.md) |
| Changelog | [`CHANGELOG.md`](../CHANGELOG.md) |
| Domain glossary | [`GLOSSARY.md`](../GLOSSARY.md) |
| Contributor quickstart | [`CONTRIBUTING.md`](../CONTRIBUTING.md) |
| Security policy | [`SECURITY.md`](../SECURITY.md) |
| Repository agent instructions | [`AGENTS.md`](../AGENTS.md) |
