/**
 * Pull-request documentation rationale guard (ticket #310).
 *
 * A user-visible change must either update documentation or state an explicit
 * `docs-not-needed: <reason>` in the pull request body. This module is pure so
 * the workflow can pass a fetched file list and body without executing any
 * pull-request code.
 */
export interface DocsRationaleResult {
  ok: boolean
  requiresDocs: boolean
  docsUpdated: boolean
  rationale?: string
  message: string
}

const DOC_FILES = new Set([
  "README.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  "GLOSSARY.md",
  "SECURITY.md",
  "CHANGELOG.md",
])

const TEST_FILE = /(?:^|\/)(?:__tests__|fixtures)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/

function normalise(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "")
}

function isDocs(path: string): boolean {
  return path.startsWith("docs/") || DOC_FILES.has(path)
}

function isUserVisible(path: string): boolean {
  if (path === "package.json") return true
  // Tests and their fixtures verify behavior; they do not ship it.
  if (TEST_FILE.test(path)) return false
  if (path.startsWith("src/")) return true
  return false
}

export function extractDocsRationale(body: string): string | undefined {
  const match = /(?:^|\n)\s*(?:[-*]\s*)?docs-not-needed\s*:\s*([^\n]*)/i.exec(body)
  const rationale = match?.[1]?.trim()
  if (!rationale || rationale.length < 12) return undefined
  return rationale
}

export function evaluateDocsRationale(
  files: readonly string[],
  body: string,
): DocsRationaleResult {
  const changed = files.map(normalise).filter(Boolean)
  const docsUpdated = changed.some(isDocs)
  const visible = changed.filter(isUserVisible)
  const requiresDocs = visible.length > 0
  const rationale = extractDocsRationale(body)

  if (!requiresDocs) {
    const testOnly = changed.length > 0 && changed.every((path) => TEST_FILE.test(path))
    return {
      ok: true,
      requiresDocs: false,
      docsUpdated,
      rationale,
      message: testOnly
        ? "No user-visible change: test-only exception."
        : "No user-visible change: documentation not required.",
    }
  }
  if (docsUpdated) {
    return {
      ok: true,
      requiresDocs,
      docsUpdated,
      rationale,
      message: "User-visible change includes a documentation update.",
    }
  }
  if (rationale) {
    return {
      ok: true,
      requiresDocs,
      docsUpdated,
      rationale,
      message: `User-visible change records docs-not-needed: ${rationale}`,
    }
  }
  return {
    ok: false,
    requiresDocs,
    docsUpdated,
    message:
      "User-visible files changed without a documentation update. "
      + "Update docs/ (or a root documentation file), or add "
      + '"docs-not-needed: <reason>" to the pull request body.',
  }
}
