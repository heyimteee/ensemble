#!/usr/bin/env node
/**
 * Built-site anchor check (ticket #301 review correction).
 *
 * Runs after the VitePress build and validates every internal fragment against
 * the ids in the generated HTML. It intentionally does not reuse the source
 * link checker: the built artifact is the user-visible contract.
 *
 * Usage:
 *   node scripts/docs-site-anchors.mjs [--dist DIR] [--base PATH]
 *   ENSEMBLE_DOCS_SITE_ANCHOR_CHECK=0 skips (docs:check owns the failure).
 */
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { BASE, OUT_DIR } from "../docs/.vitepress/site-data.mjs"
import { checkBuiltSiteAnchors } from "./lib/site-anchors.mjs"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function parseArgs(argv) {
  const args = { dist: OUT_DIR, base: BASE, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--dist") {
      const value = argv[++index]
      if (!value || value.startsWith("--")) throw new Error("--dist needs a value")
      args.dist = resolve(REPO_ROOT, value)
    } else if (arg === "--base") {
      const value = argv[++index]
      if (!value || value.startsWith("--")) throw new Error("--base needs a value")
      args.base = value
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
  console.log(`Usage: node scripts/docs-site-anchors.mjs [--dist DIR] [--base PATH]

Reads the built VitePress HTML and fails when an internal link target or its
fragment is not present. The default suite is skipped when
ENSEMBLE_DOCS_SITE_ANCHOR_CHECK=0 so docs:check can report the failure itself.`)
} else if (process.env.ENSEMBLE_DOCS_SITE_ANCHOR_CHECK === "0") {
  console.log("docs:site:anchors: skipped (ENSEMBLE_DOCS_SITE_ANCHOR_CHECK=0)")
} else {
  try {
    const args = parseArgs(process.argv.slice(2))
    const result = checkBuiltSiteAnchors(args.dist, { base: args.base })
    if (result.failures.length > 0) {
      for (const failure of result.failures) console.error(`docs:site:anchors: ${failure}`)
      console.error(`docs:site:anchors: ${result.failures.length} broken built anchor(s)`)
      process.exitCode = 1
    } else {
      console.log(
        `docs:site:anchors: ok (${result.pages} pages, ${result.links} internal links, `
          + `${result.anchors} fragment links)`,
      )
    }
  } catch (error) {
    console.error(`docs:site:anchors: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
