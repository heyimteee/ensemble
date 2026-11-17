import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

import { VERIFIED_OPENTUI_CLIPBOARD_VERSION } from "./opentui-clipboard.ts"

const require = createRequire(import.meta.url)
const installedCore = JSON.parse(
  readFileSync(join(dirname(require.resolve("@opentui/core")), "package.json"), "utf8"),
)

test("the clipboard shim records the installed OpenTUI runtime it was verified against", () => {
  assert.equal(VERIFIED_OPENTUI_CLIPBOARD_VERSION, installedCore.version)
})
