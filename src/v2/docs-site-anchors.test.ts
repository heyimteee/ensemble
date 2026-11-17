import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { checkBuiltSiteAnchors } from "../../scripts/lib/site-anchors.mjs"

function fixture() {
  const dist = mkdtempSync(join(tmpdir(), "ensemble-built-anchors-"))
  mkdirSync(join(dist, "sub"), { recursive: true })
  writeFileSync(
    join(dist, "index.html"),
    [
      '<a href="/ensemble/sub/page#heading">ok</a>',
      '<a href="/ensemble/sub/page#named">named ok</a>',
      '<a href="/ensemble/sub/page#missing">broken</a>',
      '<a href="#local">local ok</a>',
      '<h2 id="local">local</h2>',
    ].join("\n"),
  )
  writeFileSync(
    join(dist, "sub/page.html"),
    '<h2 id="heading">heading</h2><a name="named"></a>',
  )
  return dist
}

test("built-site anchors accept real ids and named anchors, and reject a missing fragment", () => {
  const dist = fixture()
  try {
    const result = checkBuiltSiteAnchors(dist, { base: "/ensemble/" })
    assert.equal(result.pages, 2)
    assert.equal(result.failures.length, 1)
    assert.match(result.failures[0] ?? "", /#missing/)
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})

test("built-site anchors reject an extensionless target that does not exist", () => {
  const dist = fixture()
  try {
    writeFileSync(join(dist, "index.html"), '<a href="/ensemble/sub/missing#heading">bad</a>')
    const result = checkBuiltSiteAnchors(dist, { base: "/ensemble/" })
    assert.equal(result.failures.length, 1)
    assert.match(result.failures[0] ?? "", /target is missing/)
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})
