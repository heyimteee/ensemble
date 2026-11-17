import test from "node:test"
import assert from "node:assert/strict"

import {
  extractLinks,
  fencedBlocks,
  githubSlug,
  pageAnchors,
  parseFrontmatter,
  shellSyntaxFailures,
} from "../../scripts/lib/docs-quality.ts"

test("frontmatter parses metadata and leaves the body", () => {
  const parsed = parseFrontmatter("---\ntitle: Quickstart\ndescription: Go from zero.\nversion: 0.1.x\n---\n\n# Quickstart\n")
  assert.equal(parsed.hasFrontmatter, true)
  assert.deepEqual(parsed.values, {
    title: "Quickstart",
    description: "Go from zero.",
    version: "0.1.x",
  })
  assert.match(parsed.body, /^# Quickstart/m)
})

test("frontmatter reports a malformed block instead of guessing", () => {
  const parsed = parseFrontmatter("---\ntitle: Quickstart\n# Quickstart\n")
  assert.equal(parsed.hasFrontmatter, false)
  assert.deepEqual(parsed.values, {})
})

test("GitHub heading slugs match the anchors used by the docs", () => {
  assert.equal(
    githubSlug("Release sign-off — 0.1.0-rc.2 (released 2026-11-17)"),
    "release-sign-off--010-rc2-released-2026-11-17",
  )
  assert.equal(githubSlug("Composer · Insert"), "composer--insert")
  assert.equal(githubSlug("`ensemble_review` tool"), "ensemble_review-tool")
  assert.equal(githubSlug("2.2.7 re-verification"), "227-re-verification")
})

test("page anchors include headings, custom HTML names, and duplicate suffixes", () => {
  const anchors = pageAnchors([
    "# Quickstart",
    "## Setup",
    "## Setup",
    '<a name="legacy-anchor"></a>',
    "```md",
    "## Not a heading",
    "```",
  ].join("\n"))
  assert.deepEqual([...anchors].sort(), ["legacy-anchor", "quickstart", "setup", "setup-1"])
})

test("link extraction ignores fenced code and inline code", () => {
  const links = extractLinks([
    "See [Install](install.md) and [Setup](#setup).",
    "`[Not a link](hidden.md)`",
    "```md",
    "[Also not a link](hidden.md)",
    "```",
    '<a href="docs/README.md#start">start</a>',
  ].join("\n"))
  assert.deepEqual(
    links.map((link) => link.href),
    ["install.md", "#setup", "docs/README.md#start"],
  )
})

test("fenced blocks report an unclosed fence with its start line", () => {
  const blocks = fencedBlocks("# Title\n\n```sh\nnpm run verify\n")
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.language, "sh")
  assert.equal(blocks[0]?.closed, false)
  assert.equal(blocks[0]?.startLine, 3)
})

test("shell syntax accepts documented angle-bracket placeholders", () => {
  assert.deepEqual(
    shellSyntaxFailures("```sh\nopencode plugin add @heyimteee/ensemble@<previous-version>\n```\n"),
    [],
  )
})

test("shell syntax rejects a genuinely invalid block", () => {
  const failures = shellSyntaxFailures("```sh\nif true; then\n```\n")
  assert.equal(failures.length, 1)
  assert.match(failures[0] ?? "", /shell syntax/)
})
