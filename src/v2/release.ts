/**
 * Release guard and notes extraction (ticket #275).
 *
 * The tag-driven workflow must never publish from a branch, must never release
 * a tag that disagrees with `package.json`, and must always ship notes that a
 * human wrote. These pure helpers keep that contract testable without running
 * the workflow; `scripts/release-guard.mjs` is the thin process wrapper.
 */
export interface ReleaseRef {
  eventName: string
  ref: string
}

export type ReleaseMode =
  | { ok: true; dryRun: boolean; tag?: string }
  | { ok: false; error: string }

/** The Git tag that releases `version`. */
export function releaseTagFor(version: string): string {
  return `v${version}`
}

/**
 * The npm dist-tag for `version`. A prerelease publishes under `next` so it
 * never becomes the default install; a final release publishes under `latest`.
 * npm refuses a prerelease without an explicit tag, so the release workflow
 * always passes one.
 */
export function distTagFor(version: string): string {
  return version.includes("-") ? "next" : "latest"
}

/**
 * Resolve the workflow trigger into a release mode. A tag push releases that
 * exact version; a manual dispatch is always a dry run; every other push is
 * refused before a registry command runs.
 */
export function validateReleaseRef(input: ReleaseRef, version: string): ReleaseMode {
  if (input.eventName === "workflow_dispatch") {
    return { ok: true, dryRun: true }
  }
  if (input.eventName !== "push") {
    return {
      ok: false,
      error: `a release runs from a version tag or a manual dispatch, not a ${input.eventName} event`,
    }
  }

  const expected = releaseTagFor(version)
  const prefix = "refs/tags/"
  if (!input.ref.startsWith(prefix)) {
    return { ok: false, error: `a release push must be the tag ${expected}, not ${input.ref}` }
  }

  const tag = input.ref.slice(prefix.length)
  if (tag !== expected) {
    return {
      ok: false,
      error: `tag ${tag} does not match package version ${version} (expected ${expected})`,
    }
  }
  return { ok: true, dryRun: false, tag }
}

/**
 * The body of the `## <version>` changelog section, without the heading or the
 * sections that follow it. Returns `null` when the version has no section or
 * the section is empty, so a release cannot publish placeholder notes.
 */
export function releaseNotesFor(changelog: string, version: string): string | null {
  const lines = changelog.split(/\r?\n/)
  const heading = /^##\s+\[?v?([^\]\s]+)\]?(?:\s|$)/

  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    const match = heading.exec(lines[index]!)
    if (match && match[1] === version) {
      start = index + 1
      break
    }
  }
  if (start < 0) return null

  const body: string[] = []
  for (let index = start; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index]!)) break
    body.push(lines[index]!)
  }

  const notes = body.join("\n").trim()
  return notes.length > 0 ? notes : null
}
