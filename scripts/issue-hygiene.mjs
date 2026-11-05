#!/usr/bin/env node
/**
 * Read-only GitHub issue hygiene listing.
 *
 * Lists parent issues whose sub-issues are all closed. By default only open
 * parents are shown, because those are the ones awaiting a closure decision;
 * `--all` also shows closed parents for an audit against known deliveries.
 *
 * The listing never edits or closes anything. See docs/agents/issue-tracker.md
 * for the closure rule.
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function usage() {
  return `Usage: node scripts/issue-hygiene.mjs [--all] [--repo owner/name]
       [--input issues.json] [--root <repo-root>]

Lists parent issues whose sub-issues are all closed.
  --all        include closed parents (audit known completed specs)
  --repo       GitHub repository; defaults to the current checkout
  --input      read gh issue list JSON from a file instead of calling gh
  --root       repository root used to find docs/verification
  --help       show this help
`
}

export function parseArgs(argv) {
  const args = { all: false, repo: null, input: null, root: REPO_ROOT, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--all") args.all = true
    else if (arg === "--help" || arg === "-h") args.help = true
    else if (arg === "--repo") args.repo = requireValue(argv, ++index, "--repo")
    else if (arg === "--input") args.input = requireValue(argv, ++index, "--input")
    else if (arg === "--root") args.root = requireValue(argv, ++index, "--root")
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

function requireValue(argv, index, flag) {
  const value = argv[index]
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`)
  return value
}

export function normalizeIssues(raw) {
  const list = Array.isArray(raw) ? raw : raw.issues
  if (!Array.isArray(list)) throw new Error("Expected an array of issues or an object with an issues array")
  return list.map((issue) => {
    const summary = issue.subIssuesSummary ?? issue.sub_issues_summary ?? {}
    return {
      number: issue.number,
      title: issue.title ?? "",
      state: String(issue.state ?? "").toUpperCase(),
      completed: Number(summary.completed ?? 0),
      total: Number(summary.total ?? 0),
    }
  })
}

export function loadIssues(args) {
  if (args.input) return normalizeIssues(JSON.parse(readFileSync(args.input, "utf8")))
  const command = ["issue", "list", "--state", "all", "--limit", "1000", "--json", "number,title,state,subIssuesSummary"]
  if (args.repo) command.push("--repo", args.repo)
  const output = execFileSync("gh", command, { encoding: "utf8" })
  return normalizeIssues(JSON.parse(output))
}

export function versionFromTitle(title) {
  const match = /Ensemble\s+v(\d+(?:\.\d+)*)/i.exec(title)
  return match ? match[1] : null
}

export function verificationRecord(version, root) {
  if (!version) return { label: "n/a", path: null }
  const directory = join(root, "docs", "verification")
  if (!existsSync(directory)) return { label: "missing", path: null }
  const token = `v${version.replaceAll(".", "")}`.toLowerCase()
  const exact = new RegExp(`(?:^|[-_.])${token}(?:[-_.]|$)`, "i")
  const match = readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .find((name) => exact.test(name))
  if (!match) return { label: "missing", path: null }
  return { label: `docs/verification/${match}`, path: join(directory, match) }
}

export function completedParents(issues, options) {
  return issues
    .filter((issue) => issue.total > 0 && issue.completed === issue.total)
    .filter((issue) => options.all || issue.state === "OPEN")
    .sort((left, right) => right.number - left.number)
}

export function render(issues, args) {
  const parents = completedParents(issues, args)
  const lines = [
    "Issue hygiene — parent issues whose sub-issues are all closed",
    args.all
      ? "Filter: open and closed parents (audit mode)"
      : "Filter: open parents (pass --all to include closed parents)",
    "",
  ]
  if (parents.length === 0) {
    lines.push("No matching parent issues.")
  } else {
    for (const parent of parents) {
      const record = verificationRecord(versionFromTitle(parent.title), args.root)
      lines.push(
        `#${parent.number}  ${parent.state.padEnd(6)}  ${parent.completed}/${parent.total} closed  ` +
          `verification: ${record.label}  ${parent.title}`,
      )
    }
  }
  const open = parents.filter((parent) => parent.state === "OPEN").length
  lines.push("", `${parents.length} parent issue${parents.length === 1 ? "" : "s"} with all sub-issues closed (${open} open).`)
  return lines.join("\n")
}

export function main(argv = process.argv.slice(2)) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`issue-hygiene: ${error.message}\n\n${usage()}`)
    return 2
  }
  if (args.help) {
    process.stdout.write(usage())
    return 0
  }
  try {
    process.stdout.write(`${render(loadIssues(args), args)}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`issue-hygiene: ${error.message}\n`)
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
