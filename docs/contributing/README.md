# Contributing

How to work on Ensemble code and documentation. Start with the repository
[CONTRIBUTING.md](../../CONTRIBUTING.md) and [AGENTS.md](../../AGENTS.md); this
hub collects the contributor-only documentation that used to sit in the main
docs index.

## Before you start

1. Read [CONTRIBUTING.md](../../CONTRIBUTING.md) for setup, verification, and
   pull-request expectations.
2. Read [AGENTS.md](../../AGENTS.md) and the [domain glossary](../../GLOSSARY.md).
3. Follow the [issue tracker workflow](../agents/issue-tracker.md) and the
   [triage labels](../agents/triage-labels.md).
4. For TUI or host integration work, read the
   [OpenCode/OpenTUI runtime guide](../agents/opencode-tui-runtime.md).

## Documentation work

- [Documentation style guide](../style-guide.md): voice, canonical terms, page
  template, code samples, visuals, and review checklist.
- [Redirect map](../redirects.md): old docs-index entries and their new homes.
- [Docs home](../README.md): the user navigation this work must keep accurate.
- [Evidence index](evidence.md): ADRs, verification records, implementation
  notes, assessments, and compatibility evidence.

Build the docs site locally with `npm run docs:site` and publish-preview it with
`npm run docs:site:preview`. `npm run docs:site:build` runs the sidebar,
reachability, redirect, SEO, sitemap, and generated-artifact checks before the
VitePress build; keep `npm run docs:check` separate and fast as the Docs
workflow does.

Update user documentation when externally visible behavior changes. Keep ADRs
and verification records public, but do not put them in the primary user
navigation; link them from the [evidence index](evidence.md) or as a **Go
deeper** link at the end of a concept page.

## Review and process

| Document | Purpose |
|---|---|
| [Review workflow](../agents/review-workflow.md) | The two-axis review process |
| [Reviewer standards](../agents/review-standards.md) | Judgement calls that stay manual |
| [Handoff contract](../agents/handoff.md) | Server-owned completion, migration handoff, batch review, loop guards, and mentions |
| [Domain document conventions](../agents/domain.md) | Glossary and ADR conventions |

## Architecture and evidence

| Resource | What it contains |
|---|---|
| [ADR index](../adr/README.md) | Every accepted architecture decision |
| [Evidence index](evidence.md) | Current and historical verification records |
| [Implementation notes](../implementation.md) | Service, TUI, storage, native tools, and acceptance notes |
| [OpenTUI assessment](../assessments/opentui.md) | Historical host-evaluation evidence |
| [OpenCode host support range](../compatibility/opencode-host-range.md) | Supported CLI releases, peer range, and runtime warning |
| [OpenCode 2.2.1 compatibility report](../compatibility/opencode-2.2.1.md) | Historical extension behavior and gaps |

## Boundaries

- Keep credentials, conversation content, and private paths out of the repository
  and public issues. The [support policy](../support/README.md) lists the
  redaction rules.
- Do not rewrite an ADR or verification record to match a new claim; add a new
  record or supersede the decision.
- Do not hand-maintain generated reference lists. Run `npm run docs:reference`
  after changing a catalog; `npm run docs:check` fails when a generated page is
  stale, missing, or unreachable from the reference index.
