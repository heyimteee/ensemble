import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import {
  OPENCODE_PLUGIN_PEER_RANGE,
  OPENCODE_PLUGIN_VERSION_BY_HOST,
  SUPPORTED_OPENCODE_VERSIONS,
  hostCompatibilityWarning,
  hostVersionSupported,
  normalizeHostVersion,
  warnUnsupportedHost,
} from "./host-compatibility.ts"

const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))

test("host versions are normalized without accepting unrelated text", () => {
  assert.equal(normalizeHostVersion("2.2.7"), "2.2.7")
  assert.equal(normalizeHostVersion("v2.2.7"), "2.2.7")
  assert.equal(normalizeHostVersion("opencode v2.2.7"), "2.2.7")
  assert.equal(normalizeHostVersion(" opencode 2.2.7 "), "2.2.7")
  assert.equal(normalizeHostVersion(""), undefined)
  assert.equal(normalizeHostVersion("latest"), "latest")
  assert.equal(normalizeHostVersion(undefined), undefined)
  assert.equal(normalizeHostVersion(2.2), undefined)
})

test("only the tested OpenCode CLI releases are supported", () => {
  assert.deepEqual([...SUPPORTED_OPENCODE_VERSIONS], ["2.2.6", "2.2.7"])
  assert.equal(hostVersionSupported("2.2.6"), true)
  assert.equal(hostVersionSupported("opencode v2.2.7"), true)
  assert.equal(hostVersionSupported("2.2.5"), false)
  assert.equal(hostVersionSupported("2.2.8"), false)
  assert.equal(hostVersionSupported(undefined), false)
})

test("the peer range covers every tested host API and matches package.json", () => {
  assert.equal(packageJson.peerDependencies["@opencode/plugin"], OPENCODE_PLUGIN_PEER_RANGE)
  for (const version of SUPPORTED_OPENCODE_VERSIONS) {
    assert.match(OPENCODE_PLUGIN_PEER_RANGE, new RegExp(`(^|\\|\\| )${version.replaceAll(".", "\\.")}($| \\|\\|)`))
    assert.equal(OPENCODE_PLUGIN_VERSION_BY_HOST[version], version)
  }
  for (const peer of ["@opencode/plugin", "@opentui/core", "@opentui/solid", "solid-js"]) {
    assert.equal(packageJson.peerDependenciesMeta?.[peer]?.optional, true, `${peer} stays an optional peer`)
  }
})

test("the compatibility workflow runs every supported host through the probe and fake smoke", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/compatibility.yml", import.meta.url), "utf8")
  for (const version of SUPPORTED_OPENCODE_VERSIONS) {
    assert.match(workflow, new RegExp(`"${version.replaceAll(".", "\\.")}"`), `${version} is in the matrix`)
  }
  assert.match(workflow, /npm run test:live:probe/)
  assert.match(workflow, /npm run test:live:fake:all/)
  assert.match(workflow, /ENSEMBLE_LIVE_EXPECT_OPENCODE: \$\{\{ matrix\.opencode \}\}/)
})

test("an unsupported host produces one clear warning", () => {
  const messages: string[] = []
  const warning = warnUnsupportedHost({ app: { version: "opencode v2.2.5" } }, (message) => messages.push(message))
  assert.equal(messages.length, 1)
  assert.equal(warning, messages[0])
  assert.match(warning ?? "", /OpenCode 2\.2\.5 is not supported/)
  assert.match(warning ?? "", /2\.2\.6 and 2\.2\.7/)
  assert.match(warning ?? "", /@opencode\/plugin 2\.2\.6 \|\| 2\.2\.7/)
})

test("a supported or unknown host produces no warning", () => {
  for (const ctx of [{ app: { version: "2.2.6" } }, { app: { version: "v2.2.7" } }, { app: {} }, {}]) {
    const messages: string[] = []
    const warning = warnUnsupportedHost(ctx, (message) => messages.push(message))
    assert.equal(warning, undefined)
    assert.deepEqual(messages, [])
  }
  assert.equal(hostCompatibilityWarning("2.2.6"), undefined)
})
