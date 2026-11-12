import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  MINIMUM_NODE_VERSION,
  TESTED_NODE_LINES,
  assertSupportedNode,
  isSupportedNodeVersion,
  parseNodeVersion,
} from "./node-version.ts"

test("ticket258: Node versions parse with or without a v prefix and ignore pre-release suffixes", () => {
  assert.deepEqual(parseNodeVersion("22.23.4"), { major: 22, minor: 23, patch: 4 })
  assert.deepEqual(parseNodeVersion("v26.12.1"), { major: 26, minor: 12, patch: 1 })
  assert.deepEqual(parseNodeVersion("24.0.0-nightly20260101"), { major: 24, minor: 0, patch: 0 })
  assert.equal(parseNodeVersion("node"), null)
  assert.equal(parseNodeVersion(""), null)
})

test("ticket258: the supported floor is the oldest verified Node line", () => {
  assert.equal(MINIMUM_NODE_VERSION, "22.23.4")
  assert.match(TESTED_NODE_LINES, /22\.23\.4/)
  assert.match(TESTED_NODE_LINES, /24\.x/)
  assert.match(TESTED_NODE_LINES, /26\.x/)
})

test("ticket258: the version gate accepts the tested lines and every newer release", () => {
  for (const version of ["22.23.4", "22.23.5", "22.24.0", "23.0.0", "24.22.1", "26.12.1", "27.0.0"]) {
    assert.equal(isSupportedNodeVersion(version), true, version)
  }
})

test("ticket258: the version gate rejects anything older than the floor or unparseable", () => {
  for (const version of ["22.23.3", "22.22.9", "22.0.0", "20.20.2", "21.7.3", "not-a-version"]) {
    assert.equal(isSupportedNodeVersion(version), false, version)
  }
})

test("ticket258: a too-old Node fails with the supported range and upgrade guidance", () => {
  assert.doesNotThrow(() => assertSupportedNode())
  assert.doesNotThrow(() => assertSupportedNode("22.23.4"))
  assert.throws(
    () => assertSupportedNode("22.23.3"),
    (error: any) => {
      assert.equal(error.name, "NodeVersionError")
      assert.equal(error.code, "unsupported_node")
      assert.match(error.message, />=22\.23\.4/)
      assert.match(error.message, /22\.23\.4, 24\.x, and 26\.x/)
      assert.match(error.message, /22\.23\.3/)
      assert.match(error.message, /Upgrade Node/)
      return true
    },
  )
})

test("ticket258: the server plugin entry rejects an unsupported runtime at load", () => {
  const entry = fileURLToPath(new URL("./server.ts", import.meta.url))
  const script = `
    Object.defineProperty(process.versions, "node", { value: "22.0.0" })
    try {
      await import(${JSON.stringify(entry)})
      console.error("server entry loaded on an unsupported runtime")
      process.exit(1)
    } catch (error) {
      console.log(error.name)
      console.log(error.code)
      console.log(error.message)
    }
  `
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script],
    { encoding: "utf8" },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /NodeVersionError/)
  assert.match(result.stdout, /unsupported_node/)
  assert.match(result.stdout, /Ensemble requires Node >=22\.23\.4/)
  assert.match(result.stdout, /this process is running Node 22\.0\.0/)
})
