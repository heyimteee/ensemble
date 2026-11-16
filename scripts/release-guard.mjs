#!/usr/bin/env node
// Release preflight (ticket #275).
//
// Runs before the release workflow touches a registry. It refuses a branch
// push or a tag that disagrees with `package.json`, extracts the changelog
// section for the version into the GitHub release notes, and exports the
// version, tag, and dry-run mode to later jobs. It reads no credential and
// prints only the version and tag.
//
// Usage:
//   node --experimental-strip-types scripts/release-guard.mjs \
//     --manifest package.json --changelog CHANGELOG.md --out RELEASE_NOTES.md

import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { distTagFor, releaseNotesFor, validateReleaseRef } from "../src/v2/release.ts"

const root = fileURLToPath(new URL("..", import.meta.url))

function argValue(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  const value = index >= 0 ? process.argv[index + 1] : fallback
  if (!value) {
    console.error(`release-guard: missing --${name}`)
    process.exit(2)
  }
  return value
}

const manifestPath = resolve(root, argValue("manifest", "package.json"))
const changelogPath = resolve(root, argValue("changelog", "CHANGELOG.md"))
const outPath = resolve(root, argValue("out", "RELEASE_NOTES.md"))
const eventName = argValue("event", process.env.GITHUB_EVENT_NAME ?? "")
const ref = argValue("ref", process.env.GITHUB_REF ?? "")

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
} catch (error) {
  console.error(`release-guard: cannot read the package manifest: ${error.message}`)
  process.exit(2)
}

const version = typeof manifest.version === "string" ? manifest.version : ""
if (!version) {
  console.error("release-guard: package.json must declare a version")
  process.exit(2)
}

const mode = validateReleaseRef({ eventName, ref }, version)
if (!mode.ok) {
  console.error(`release-guard: ${mode.error}`)
  process.exit(1)
}

let changelog
try {
  changelog = readFileSync(changelogPath, "utf8")
} catch (error) {
  console.error(`release-guard: cannot read the changelog: ${error.message}`)
  process.exit(2)
}

const notes = releaseNotesFor(changelog, version)
if (!notes) {
  console.error(`release-guard: CHANGELOG.md has no notes for ${version}`)
  process.exit(1)
}

writeFileSync(outPath, `${notes}\n`)

const githubOutput = process.env.GITHUB_OUTPUT
if (githubOutput) {
  appendFileSync(
    githubOutput,
    `version=${version}\ntag=${mode.tag ?? ""}\ndry-run=${mode.dryRun}\ndist-tag=${distTagFor(version)}\n`,
  )
}

console.log(
  `release-guard: ${mode.tag ?? "manual dispatch"} -> ${version} `
    + `(${mode.dryRun ? "dry run" : "publish"}, ${distTagFor(version)}); release notes written`,
)
