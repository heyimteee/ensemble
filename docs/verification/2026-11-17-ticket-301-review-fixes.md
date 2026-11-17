# Ticket #301 final documentation review corrections — verification

Status: **PASS for the in-repository documentation contract and tooling.** The
human newcomer usability audit, GitHub Pages publication, and the external
required-check ruleset change remain unrun or pending; none is claimed here.

Date: 2026-11-17
Ticket: [#301](https://github.com/heyimteee/ensemble/issues/301)
Branch: `fix/docs-final-review`
Base: `origin/docs/program` at `8f179f4`

This was a docs/site/tooling change. Product behavior, dependencies other than
the dev-only Markdown linter, workflows' security boundaries, and historical
prerelease evidence were not rewritten.

## Review blockers and resolutions

| Blocker | Resolution |
|---|---|
| Rendered anchors differed from GitHub slugs | `scripts/lib/rendered-anchors.mjs` asks the VitePress markdown renderer for the real ids; `docs-check` uses those for every source link. Full `docs:check` separately crawls the built HTML with `scripts/lib/site-anchors.mjs`, and `docs-site:build` runs `docs-site-anchors` after the VitePress build. Regression tests cover numeric, punctuation, em dash, emoji, duplicate, and named anchors. |
| Actual broken rendered links | The initial built crawl found eight broken fragment links. Added named-anchor aliases to the historical headings that need both GitHub and VitePress targets: `227-re-verification`, `opencode-230-support-286`, `release-sign-off--010-rc2-released-2026-11-17`, and `post-review-remediation-fixv6-review`. The final built crawl reports zero broken fragments. |
| Operations docs still described a prerelease future | `operations/upgrade.md` now installs stable `0.1.0` and keeps rc.2/rc.3 as explicit history. `release.md` records `latest: 0.1.0`, `next: 0.1.0-rc.3`, OIDC trusted publishing, and the stable tag. `rollback.md` documents the installable prerelease pins without claiming an unrun downgrade rehearsal. |
| Destructive media capture path | `docs-media.sh` uses `$LIVE_HOME/dev/acme-notes` inside the unique `live_setup` mktemp tree. The explicit `rm -rf` is gone; the EXIT trap owns cleanup. |
| Hard-coded username in privacy tooling | `scripts/lib/privacy.mjs` derives the running account, home paths, and hostname. The media check, manifest generator, and capture script consume those markers at run time; no new contributor identity is committed. Tests prove current-identity detection and the isolated capture contract. |
| Unevidenced quickstart duration | Removed the ten-minute claim from the quickstart, its frontmatter, and the getting-started index. The page now states the 30–35 s scripted smoke and says human timing varies. |
| Docs rationale falsely implied required | The contributor and release docs now state that `docs-rationale` is advisory until a maintainer changes the GitHub ruleset; no ruleset was configured and no required-check claim remains. |
| Pages deployment implied published | The workflow is retained. The docs explicitly say the PR build does not deploy and that enabling Pages/publication is an external maintainer action. |
| `docs:check` built the site twice in PR CI | `docs:check` remains the full local gate (lint, source, build, built-anchor crawl). `docs:check:fast` runs lint plus source checks without a build. The Docs job runs the fast gate; the Docs site job owns the one PR build. CI contract tests assert the split. |
| No Markdown linter | Added dev-only `markdownlint-cli2` 0.24.1, `.markdownlint-cli2.jsonc` with four structural rules, `npm run docs:lint`, and fast-gate wiring. Historical evidence is excluded from the globs and no prose churn was needed. |
| Evidence-index prose counted as a link | The check now resolves actual Markdown/HTML links and matches the target file path; a prose-only filename test fails. |
| Canonical terminology drift | Authored user pages use "work item" and "agent" instead of card/subtask/assistant; generated reference and historical evidence retain their source wording. |
| README had no badges | Added npm version, verify workflow, and MIT license badges. No Pages badge was added because the site is not published. |

## Verification

| Gate | Result |
|---|---|
| `npm run verify` | 2188 tests pass, 0 fail, 0 skip; typecheck pass (baseline 2175) |
| `npm run docs:check` | ok; site build ok; Markdown lint 75 files, 0 issues; built anchors 2,129 fragment links across 18,306 internal links |
| `npm run docs:check:fast` | ok; site build skipped explicitly; same source/lint contract |
| `npm run docs:site:build` | 185 pages (184 baseline plus this verification record), 51 redirects, local search, sitemap, `llms.txt`, `llms-full.txt`, built anchors ok |
| Independent built-site crawl | 217 HTML pages, 18,306 internal links, 2,129 fragment links, 0 broken targets |
| `npm run docs:media:check` | ok (manifest, hashes, screenshots, cast, alt text, captions, Mermaid, headings) |
| `npm run docs:reference:check` | ok: 6 native tools, 11 legacy tools, 17 `:` commands, 15 `/` commands, 9 generated pages |
| `npm run test:live:quickstart` | PASS at 31.6 s through the packed package, `/ensemble`, two agents, workspace, group message, and REPLIED work item |
| `npm run docs:media` | two regenerations produced the same seven assets and dimensions; no current username, host, home path, or fixture marker reached an asset. Byte hashes differ only on the documented host-rendered elapsed-time/stream frames. |
| Privacy scan | dynamic current-account and host markers pass the committed media and all authored user pages; historical verification records retain their pre-existing local paths and were not rewritten. |

## External actions and limits

- The human newcomer timing audit remains unrun. The 30–35 s figure is the
  deterministic packed-install smoke, not a human completion measurement.
- GitHub Pages is not deployed by this branch. Enabling the Pages environment
  and publishing the site require maintainer action.
- `docs-rationale` is not a required status check. Adding it requires an
  explicit maintainer decision and a GitHub ruleset change; this branch did not
  configure one.
- No push, pull request, deployment, or issue mutation was performed.
- The media generator still depends on host-rendered elapsed-time labels and
  stream-phase glyphs, so byte-for-byte capture determinism is not claimed; the
  committed manifest makes any hand edit or stale asset fail the check.
- Historical verification records already contained pre-existing developer
  workspace paths (for example `/home/<user>/...`). They are not credentials,
  and they were left unchanged rather than rewriting evidence. New user-page
  and media checks derive the current identity dynamically and do not add a
  committed username.
