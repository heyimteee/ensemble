#!/usr/bin/env node
/**
 * Pull-request docs rationale evaluator (ticket #310).
 *
 * The workflow fetches the changed-file list and PR body as data, then runs
 * this trusted-base script. It never imports or executes pull-request code.
 *
 * Usage:
 *   node scripts/docs-rationale.mjs --files changed-files.txt --body pr-body.md
 */
import { readFileSync } from "node:fs"
import { evaluateDocsRationale } from "./lib/docs-rationale.ts"

function parseArgs(argv) {
  const args = { files: "", body: "" }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--files") {
      args.files = argv[++index] ?? ""
    } else if (arg === "--body") {
      args.body = argv[++index] ?? ""
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
  console.log(`Usage: node --experimental-strip-types scripts/docs-rationale.mjs --files FILE --body FILE

Fails when a pull request changes user-visible source without a documentation
update or a "docs-not-needed: <reason>" line in the pull request body.`)
} else {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (!args.files) throw new Error("--files is required")
    if (!args.body) throw new Error("--body is required")
    const files = readFileSync(args.files, "utf8").split(/\r?\n/).filter((line) => line.trim())
    const body = readFileSync(args.body, "utf8")
    const result = evaluateDocsRationale(files, body)
    if (!result.ok) {
      console.error(`docs-rationale: ${result.message}`)
      process.exitCode = 1
    } else {
      console.log(`docs-rationale: ok (${result.message})`)
    }
  } catch (error) {
    console.error(`docs-rationale: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
