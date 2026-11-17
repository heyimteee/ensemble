#!/usr/bin/env node
/**
 * Write the generated reference pages (ticket #305).
 *
 * Usage:
 *   node --experimental-strip-types scripts/reference-gen.mjs [--root DIR]
 *
 * The pages are committed. `npm run docs:check` re-renders them in memory and
 * fails when the committed copy differs.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { REFERENCE_PAGES, renderReferenceDocs } from "./reference-docs.mjs"

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname)

function parseArgs(argv) {
  const args = { root: REPO_ROOT, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--root") {
      const value = argv[++index]
      if (!value || value.startsWith("--")) throw new Error("--root needs a value")
      args.root = resolve(value)
    } else if (arg === "--help" || arg === "-h") {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
}

const help = process.argv.includes("--help") || process.argv.includes("-h")
if (help) {
  console.log("Usage: node --experimental-strip-types scripts/reference-gen.mjs [--root DIR]")
} else {
  try {
    const args = parseArgs(process.argv.slice(2))
    const pages = renderReferenceDocs()
    const expected = new Set(REFERENCE_PAGES)
    for (const path of Object.keys(pages)) {
      if (!expected.has(path)) throw new Error(`rendered page ${path} is not listed in REFERENCE_PAGES`)
    }
    for (const path of expected) {
      if (!(path in pages)) throw new Error(`REFERENCE_PAGES lists ${path} but the generator does not render it`)
    }
    for (const [path, content] of Object.entries(pages)) {
      const full = join(args.root, path)
      if (!existsSync(dirname(full))) mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content)
      console.log(`wrote ${path}`)
    }
  } catch (error) {
    console.error(`reference-gen: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
