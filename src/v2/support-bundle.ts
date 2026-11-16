/**
 * Ticket #276: redaction helpers for the local support bundle.
 *
 * A bundle is produced only when a user runs the command. There is no
 * telemetry upload. These helpers remove home/state paths, redact credential
 * shapes, and drop conversation/content keys before any evidence reaches the
 * bundle directory.
 */

export const SUPPORT_BUNDLE_FORMAT = "ensemble-support-bundle"
export const SUPPORT_BUNDLE_VERSION = 1

/** Keys whose values are user content and never belong in support evidence. */
export const SUPPORT_CONTENT_KEYS = [
  "text",
  "title",
  "instruction",
  "prompt",
  "content",
  "body",
  "result",
  "patch",
  "diff",
  "fileBytes",
  "attachments",
  "files",
] as const

const CONTENT_KEYS = new Set<string>(SUPPORT_CONTENT_KEYS)
const MAX_STRING = 4_096
const MAX_ARRAY = 200

export type RedactionContext = {
  home?: string
  stateDirectory?: string
  logDirectory?: string
  /** Longer workspace, live-harness, or temp roots to replace first. */
  roots?: string[]
  /** Exact secrets to remove in addition to the shape rules. */
  secrets?: string[]
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Replace known directories with stable placeholders. Longest first. */
export function redactSupportText(value: string, context: RedactionContext = {}): string {
  let result = value
  const ordered: Array<[string, string]> = []
  for (const root of context.roots ?? []) {
    if (root) ordered.push([root, "<path>"])
  }
  if (context.stateDirectory) ordered.push([context.stateDirectory, "<state>"])
  if (context.logDirectory) ordered.push([context.logDirectory, "<logs>"])
  if (context.home) ordered.push([context.home, "~"])
  ordered.sort((a, b) => b[0].length - a[0].length)
  for (const [root, replacement] of ordered) {
    if (!root || root === "/") continue
    result = result.replace(new RegExp(`${escape(root)}(?![\\w.~-])`, "g"), replacement)
  }
  for (const secret of context.secrets ?? []) {
    if (secret) result = result.split(secret).join("[redacted]")
  }
  return result
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, "//[redacted]@")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "[redacted]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{12,})\b/g, "[redacted]")
    .replace(/(password|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|token)\s*[:=]?\s*\S+/gi, "$1=[redacted]")
    .slice(0, MAX_STRING)
}

/**
 * Deep-redact a value. Content keys are omitted rather than truncated so a
 * transcript line can never survive in a bundle. Arrays are bounded and depth
 * is capped, matching the logger's own redaction rules.
 */
export function redactSupportValue(value: unknown, context: RedactionContext = {}, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]"
  if (typeof value === "string") return redactSupportText(value, context)
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value
  if (typeof value === "bigint") return String(value)
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => redactSupportValue(item, context, depth + 1))
  if (typeof value === "object") {
    const result: Record<string, unknown> = {}
    let count = 0
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (CONTENT_KEYS.has(key)) continue
      if (/^(password|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|token)$/i.test(key)) {
        result[key] = "[redacted]"
        continue
      }
      if (count++ >= 100) {
        result.truncated = true
        break
      }
      result[key] = redactSupportValue(item, context, depth + 1)
    }
    return result
  }
  return redactSupportText(String(value), context)
}

/** One bounded, content-free slice of a JSONL log file. */
export function sanitizeLogRows(rows: readonly unknown[], context: RedactionContext = {}, limit = 500): Record<string, unknown>[] {
  const kept: Record<string, unknown>[] = []
  for (const row of rows) {
    const redacted = redactSupportValue(row, context)
    if (redacted && typeof redacted === "object" && !Array.isArray(redacted)) kept.push(redacted as Record<string, unknown>)
  }
  return kept.slice(-Math.max(1, Math.floor(limit)))
}

export type SupportManifestInput = {
  createdAt: string
  platform: string
  release: string
  arch: string
  node: string
  ensembleVersion: string
  directories: readonly string[]
  files: ReadonlyArray<{ name: string; bytes: number }>
  context: RedactionContext
}

/** A small, path-redacted manifest that names the evidence in the bundle. */
export function buildSupportManifest(input: SupportManifestInput): Record<string, unknown> {
  return {
    format: SUPPORT_BUNDLE_FORMAT,
    version: SUPPORT_BUNDLE_VERSION,
    createdAt: input.createdAt,
    runtime: {
      platform: input.platform,
      release: input.release,
      arch: input.arch,
      node: input.node,
      ensembleVersion: input.ensembleVersion,
    },
    directories: input.directories.map((directory) => redactSupportText(directory, input.context)),
    files: input.files.map((file) => ({
      name: file.name,
      bytes: file.bytes,
    })),
    redaction: {
      home: "~",
      state: "<state>",
      logs: "<logs>",
      contentKeys: [...SUPPORT_CONTENT_KEYS],
      note: "Conversation content, titles, instructions, prompts, file bytes, credentials, and home/state paths are omitted or replaced.",
    },
  }
}
