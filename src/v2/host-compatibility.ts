/**
 * Ticket #257: OpenCode host compatibility.
 *
 * The OpenCode **CLI** release and the `@opencode/plugin` **host API** package
 * are separate contracts. The peer range below declares the API packages this
 * build accepts; the runtime preflight reads the CLI release from
 * `ctx.app.version`. The two currently ship matching patch versions, but a
 * future CLI release may ship an unchanged API (or vice versa), so the
 * mapping stays explicit.
 *
 * Only releases exercised by the compatibility matrix belong here. A new host
 * needs a fresh probe and an explicit set change; do not widen this to a
 * floating range without recording the evidence.
 */

/** OpenCode CLI releases exercised by the compatibility matrix. */
export const SUPPORTED_OPENCODE_VERSIONS = ["2.2.6", "2.2.7"] as const

/** `@opencode/plugin` API packages shipped by the tested hosts. */
export const OPENCODE_PLUGIN_PEER_RANGE = "2.2.6 || 2.2.7"

/** OpenCode CLI release -> the `@opencode/plugin` API package it ships. */
export const OPENCODE_PLUGIN_VERSION_BY_HOST: Readonly<Record<string, string>> = {
  "2.2.6": "2.2.6",
  "2.2.7": "2.2.7",
}

/** Normalize `2.2.7`, `v2.2.7`, and `opencode v2.2.7` to `2.2.7`. */
export function normalizeHostVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.trim().replace(/^opencode\s+/i, "").replace(/^v/i, "")
  return normalized.length > 0 ? normalized : undefined
}

export function hostVersionSupported(value: unknown): boolean {
  const version = normalizeHostVersion(value)
  return version !== undefined && (SUPPORTED_OPENCODE_VERSIONS as readonly string[]).includes(version)
}

/**
 * A warning for an untested host, or `undefined` when the version is supported
 * or cannot be determined. Unknown versions stay quiet: a missing `ctx.app` is
 * a host-contract failure surfaced by the required API calls, not something to
 * guess about here.
 */
export function hostCompatibilityWarning(value: unknown): string | undefined {
  const version = normalizeHostVersion(value)
  if (!version || hostVersionSupported(version)) return undefined
  return `OpenCode ${version} is not supported by this Ensemble build; `
    + `supported hosts are ${SUPPORTED_OPENCODE_VERSIONS.join(" and ")} `
    + `(@opencode/plugin ${OPENCODE_PLUGIN_PEER_RANGE}). `
    + "Ensemble will continue, but behavior on this version is untested."
}

/**
 * Runtime preflight: warn once per service realm when the host is outside the
 * tested set. This never replaces the required-API failures in setup/attach.
 */
export function warnUnsupportedHost(
  ctx: { app?: { version?: unknown } } | undefined,
  warn: (message: string) => void = (message) => console.warn(`[ensemble] ${message}`),
): string | undefined {
  const warning = hostCompatibilityWarning(ctx?.app?.version)
  if (warning) warn(warning)
  return warning
}
