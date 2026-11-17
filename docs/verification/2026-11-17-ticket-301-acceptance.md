# Ticket #301 documentation acceptance — verification

Status: **PASS for the in-repository documentation contract, the human
quickstart walkthrough, and the full built-site UI/accessibility scan.** GitHub
Pages publication and the required-check ruleset remain external actions.

Date: 2026-11-17
Ticket: [#301](https://github.com/heyimteee/ensemble/issues/301)
Branch: `docs/program`
Base: `main` at `4b46940`

This record closes the documentation program after the per-ticket work in
#302–#310. It does not rewrite those records or their historical evidence.

## Human quickstart walkthrough

The maintainer followed the Quickstart on macOS using the local site preview
built from `9a95b88`, with a fresh OpenCode profile in which Ensemble was not
installed.

| Item | Value |
| --- | --- |
| Host | MacBook Pro, Apple silicon (arm64) |
| macOS | 27.2.1 |
| Node / npm | 26.12.1 / 11.21.1 |
| OpenCode / tmux | 2.3.0 / 3.5a |
| Path | stable `0.1.0` install, `/ensemble`, Nova and Rook, `acme-notes`, group message, `REPLIED` work item |
| Elapsed | **5 minutes**, reported by the maintainer |
| Failures | none reported |

The walkthrough started from the published Quickstart rather than the
deterministic smoke harness. The maintainer is familiar with the product, so
this is human completion evidence, not an independent first-time-user
usability study.

## Post-audit fixes

The walkthrough and the review of the live site found three presentation
defects. All three are fixed in the acceptance branch.

| Defect | Cause | Fix |
| --- | --- | --- |
| Heading anchors showed a literal `&ZeroWidthSpace;` on hover | The docs HTML-escaping rule treated VitePress's invisible anchor symbol as author HTML and escaped it | Preserve the generated anchor symbol; `docs-site-artifacts` now fails when the escaped form appears in any built page |
| Terminal hero was clipped and started as an almost empty black frame | The frame used a columns/rows aspect ratio that did not match the fitted terminal's rendered height | Frame ratio now matches the player (`110 / 81.3`), the poster uses `contain`, and the replay waits for **Play** instead of autoplaying |
| Section landing URLs redirected to themselves in the local preview | Generated `concepts.html`-style redirect stubs shadowed the real `concepts/index.html` page | Removed the nine section `.html` aliases; the directory routes serve the real pages. Other redirects remain (`42` total) |

The brand mark is now a first-class asset at `docs/public/logo.svg`, used in
the site navigation and at the top of the README. The existing `favicon.svg`
keeps its dark tile for browser chrome. The README uses the public GitHub raw
URL so the logo also loads on the npm package page.

The quickstart E2E now waits for Insert mode in each wizard field instead of racing the field focus. The synthetic captures were regenerated at 140×40 with full-window framing.
The earlier 110×34 shell view and cropped pane views made the UI feel cramped;
every screenshot and the replay now show all three panes with surrounding
space. Images are 1400×800 and remain clickable to full size.

## Built-site scan

The full site was served locally and scanned at 1440×1000 and 390×844.

| Check | Result |
| --- | --- |
| Routes scanned | 186 |
| Navigation errors | 0 |
| Horizontal overflow (desktop and mobile) | 0 |
| Broken images | 0 |
| Console errors, page errors, failed responses | 0 |
| Escaped anchor symbols in heading anchors | 0; this record mentions the entity in prose intentionally |
| Axe WCAG 2 A/AA and 2.1 A/AA, light | 0 violations across 186 routes |
| Axe WCAG 2 A/AA and 2.1 A/AA, dark | 0 violations across 185 routes before the acceptance record was added; the new page is prose-only |
| Mermaid diagrams | All rendered; source and SVG counts matched |
| Representative visual review | Home, Quickstart, Concepts, Work lifecycle, Guides, Native tools, Operations, Security, Support, and Evidence at desktop, mobile, and dark |

Code blocks use Shiki's `github-light-high-contrast` and
`github-dark-high-contrast` themes. The default light palette failed AA on
keyword and comment colours.

## Gates

| Gate | Result |
| --- | --- |
| `npm run verify` | 2,188 tests pass, 0 fail, 0 skip; typecheck pass |
| `npm run docs:check` | ok; Markdown lint, page inventory, frontmatter, links and rendered anchors, generated reference, media, site build, built-anchor crawl |
| `npm run docs:check:fast` | ok; no site build |
| `npm run docs:site:build` | ok; 186 pages, 42 redirects, local search, sitemap, `llms.txt`, `llms-full.txt`; built anchors 2,136 fragments across 18,387 internal links |
| `npm run docs:media:check` | ok |
| `npm run docs:reference:check` | ok: 6 native tools, 11 legacy tools, 17 `:` commands, 15 `/` commands, 9 generated pages |
| `npm run test:live:quickstart` | PASS twice locally after hardening; packed install through `REPLIED` work item |

## Remaining external actions

- GitHub Pages is configured for GitHub Actions but the site is not published
  until this branch merges to `main`.
- `docs-rationale` is implemented but is not yet a required status check. It
  is added to the `main` ruleset after the workflow exists on the default
  branch.
- No custom domain, analytics, or external search service is configured.
