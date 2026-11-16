#!/usr/bin/env node
// Build the published JavaScript for the server, TUI, and RPC entries
// (ticket #279).
//
// The OpenCode Node/Bun plugin loader does not transform installed sources and
// the OpenTUI runtime Solid transform excludes `node_modules`, so the package
// must ship compiled JavaScript. TypeScript alone emits runtime `jsx()` calls;
// the TUI instead needs the Solid compile-time transform (`babel-preset-solid`)
// with `@opentui/solid` as the element runtime. This script applies that
// transform to `.tsx`, strips types from `.ts`, and rewrites the repository's
// explicit `.ts`/`.tsx` import extensions to `.js` for Node's resolver.

import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { transformAsync } from "@babel/core"
import typescript from "@babel/preset-typescript"
import solid from "babel-preset-solid"

const root = fileURLToPath(new URL("..", import.meta.url))
const sourceRoot = join(root, "src", "v2")
const outputRoot = join(root, "dist")

/** Development-only modules, kept out of the published runtime closure. */
const DEV_ONLY = new Set([
  "ci-workflows.ts",
  "data-cli.ts",
  "doctor-cli.ts",
  "doctor.ts",
  "flake-policy.ts",
  "latency-budget.ts",
  "live-matrix.ts",
  "prompt-benchmark.ts",
  "soak-metrics.ts",
  "support-bundle.ts",
  "test-service.ts",
])

const sources = []
const walk = (directory) => {
  for (const name of readdirSync(directory).sort()) {
    const full = join(directory, name)
    if (statSync(full).isDirectory()) walk(full)
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      const path = relative(sourceRoot, full).split("\\").join("/")
      if (!DEV_ONLY.has(path)) sources.push({ full, path })
    }
  }
}
walk(sourceRoot)

/** Rewrite relative `.ts`/`.tsx` import and export specifiers to `.js`. */
function rewriteRelativeExtensions() {
  const rewrite = (node) => {
    if (node && node.value.startsWith(".") && /\.(ts|tsx)$/.test(node.value)) {
      node.value = node.value.replace(/\.(ts|tsx)$/, ".js")
    }
  }
  return {
    visitor: {
      ImportDeclaration(path) {
        rewrite(path.node.source)
      },
      ExportNamedDeclaration(path) {
        rewrite(path.node.source)
      },
      ExportAllDeclaration(path) {
        rewrite(path.node.source)
      },
      CallExpression(path) {
        const [argument] = path.node.arguments
        if (path.node.callee.type === "Import" && argument?.type === "StringLiteral") rewrite(argument)
      },
    },
  }
}

rmSync(outputRoot, { recursive: true, force: true })

for (const { full, path } of sources) {
  const jsx = path.endsWith(".tsx")
  const presets = []
  if (jsx) presets.push([solid, { moduleName: "@opentui/solid", generate: "universal" }])
  presets.push([typescript])
  const result = await transformAsync(readFileSync(full, "utf8"), {
    filename: full,
    configFile: false,
    babelrc: false,
    sourceType: "module",
    presets,
    plugins: [rewriteRelativeExtensions],
    comments: true,
  })
  const target = join(outputRoot, path.replace(/\.tsx?$/, ".js"))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${result?.code ?? ""}\n`)
}

// The three public entries must exist before the package can be packed.
for (const entry of ["server.js", "rpc.js", "tui/index.js"]) {
  statSync(join(outputRoot, entry))
}

execFileSync(process.execPath, [join(root, "scripts", "check-build.mjs")], { stdio: "inherit" })
