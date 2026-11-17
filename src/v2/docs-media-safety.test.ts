import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { privateIdentity, privacyViolations } from "../../scripts/lib/privacy.mjs"

const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
const script = readFileSync(join(repoRoot, "scripts/docs-media.sh"), "utf8")
const check = readFileSync(join(repoRoot, "scripts/docs-media-check.mjs"), "utf8")
const manifest = readFileSync(join(repoRoot, "scripts/docs-media-manifest.mjs"), "utf8")

test("privacy markers derive from the running account, home, and host", () => {
  const identity = privateIdentity()
  assert.ok(identity.users.length > 0)
  assert.ok(identity.hosts.length > 0)
  assert.ok(identity.paths.length > 0)
  for (const marker of identity.markers) {
    assert.ok(
      privacyViolations(`captured text contains ${marker} here`).includes(marker),
      `privacy detection must reject ${marker}`,
    )
  }
})

test("privacy detection supports an explicit identity without a committed username", () => {
  const overrides = { username: "alice", hostname: "workstation", home: "/home/alice" }
  assert.ok(privacyViolations("/home/alice/project", overrides).includes("/home/alice"))
  assert.ok(privacyViolations("alice@workstation", overrides).includes("alice"))
  assert.ok(privacyViolations("workstation", overrides).includes("workstation"))
  assert.deepEqual(privacyViolations("a public synthetic fixture", overrides), [])
})

test("media generation uses the isolated live_setup directory and owns no destructive removal", () => {
  assert.match(script, /live_setup "docs-media"/)
  assert.match(script, /LIVE_PROJECT="\$LIVE_HOME\/dev\/acme-notes"/)
  assert.doesNotMatch(script, /\brm\s+-rf\b/)
  assert.doesNotMatch(script, /\/tmp\/opencode\/acme-notes/)
})

test("media generation derives redaction markers at run time", () => {
  assert.match(script, /identity_user=/)
  assert.match(script, /identity_host=/)
  assert.match(script, /privacy_forbid=/)
  assert.match(check, /privateIdentity\(\)/)
  assert.match(check, /ASSET_FORBIDDEN = \[[^\]]*IDENTITY\.markers/s)
  assert.match(check, /PAGE_FORBIDDEN = \[[^\]]*IDENTITY\.markers/s)
  assert.match(manifest, /privateIdentity\(\)\.markers/)
})
