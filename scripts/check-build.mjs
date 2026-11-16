#!/usr/bin/env node
// Prepack guard for the built package (ticket #279).
//
// `npm pack`/`npm publish` run `prepack`, which builds `dist` and then runs
// this check. A tarball must never be produced with a missing export target,
// raw TypeScript, a `.ts` import, or a TUI entry that asks for the classic
// React JSX runtime instead of the Solid OpenTUI runtime.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))

function fail(message) {
  console.error(`check-build: ${message}`)
  process.exit(1)
}

if (!Array.isArray(manifest.files) || manifest.files.length !== 1 || manifest.files[0] !== "dist") {
  fail(`files must be exactly ["dist"], found ${JSON.stringify(manifest.files)}`)
}

const exports = Object.entries(manifest.exports ?? {})
if (exports.length === 0) fail("package.json declares no exports")

for (const [name, target] of exports) {
  if (typeof target !== "string" || !target.startsWith("./dist/") || !target.endsWith(".js")) {
    fail(`export ${name} must point at a built .js file, found ${JSON.stringify(target)}`)
  }
  if (!existsSync(join(root, target))) fail(`export ${name} is missing ${target}; run npm run build`)
}

const built = []
const walk = (directory) => {
  for (const name of readdirSync(directory).sort()) {
    const full = join(directory, name)
    if (statSync(full).isDirectory()) walk(full)
    else built.push(relative(root, full).split("\\").join("/"))
  }
}
walk(join(root, "dist"))

for (const path of built) {
  if (!path.endsWith(".js")) fail(`${path} is not JavaScript; the tarball ships built .js only`)
  const source = readFileSync(join(root, path), "utf8")
  const typescriptImport = /\bfrom\s*["'][^"']+\.(ts|tsx|mts|cts)["']/.exec(source)
  if (typescriptImport) fail(`${path} imports TypeScript source: ${typescriptImport[0]}`)
}

const tui = readFileSync(join(root, "dist/tui/index.js"), "utf8")
if (!/\bfrom\s*["']@opentui\/solid["']/.test(tui)) {
  fail("dist/tui/index.js must use the @opentui/solid runtime")
}
if (/\breact\b|react\/jsx/.test(tui)) fail("dist/tui/index.js must not reference react")
if (/\b_?jsx(?:s|DEV)?\s*\(/.test(tui)) fail("dist/tui/index.js must be Solid-compiled, not runtime JSX calls")

const allBuilt = built.map((path) => readFileSync(join(root, path), "utf8")).join("\n")
if (!/\bfrom\s*["']solid-js["']/.test(allBuilt)) {
  fail("the built TUI must use Solid's reactive runtime (solid-js)")
}
if (/\bfrom\s*["']react["']/.test(allBuilt)) fail("the built package must not import react")

if (built.length === 0) fail("dist is empty")

console.error(`check-build: ${built.length} built JavaScript files for ${exports.length} exports`)
