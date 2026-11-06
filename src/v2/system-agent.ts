/**
 * System Agent transcript identity and init job copy (ticket #100).
 *
 * The System Agent is not a roster member: it has no model, Skillbox, or
 * mention route. It authors normal left-side transcript bubbles through
 * `Message.displayAuthor` and reports the internal native init job.
 */

import type { InitPhase } from "./types.ts"

export const SYSTEM_AGENT_NAME = "System Agent"
export const ENSEMBLE_INIT_SKILL = "ensemble-init"
export const INIT_COMMAND = "/init"
export const INIT_START_TEXT = "Initializing workspace…"
export const INIT_PROGRESS_TEXT = "Inspecting AGENTS.md and .ensemble/init.json with native /init…"
export const INIT_WRITING_TEXT = "Writing AGENTS.md and .ensemble/init.json…"
export const INIT_REPORTING_TEXT = "Preparing the init report…"

/** Ordered stages for the System Agent init row (ticket #118). */
export const INIT_PHASES: readonly InitPhase[] = ["starting", "running", "writing", "reporting"]

/** Short stage word for the row. The native run is explicitly indeterminate. */
export function initPhaseLabel(phase: InitPhase): string {
  return phase === "running" ? "running · indeterminate" : phase
}

/** One honest detail line per stage; never a percentage or within-stage claim. */
export function initPhaseDetail(phase: InitPhase): string {
  switch (phase) {
    case "starting":
      return "preparing a temporary native session"
    case "running":
      return "native /init is opaque; progress is indeterminate"
    case "writing":
      return "writing AGENTS.md and .ensemble/init.json"
    case "reporting":
      return "settling the report"
  }
}

/** Streaming row text for a stage. */
export function initPhaseText(phase: InitPhase): string {
  switch (phase) {
    case "starting":
      return INIT_START_TEXT
    case "running":
      return INIT_PROGRESS_TEXT
    case "writing":
      return INIT_WRITING_TEXT
    case "reporting":
      return INIT_REPORTING_TEXT
  }
}

/** Composer/planner aliases for the built-in init job. */
export const INIT_ALIASES = new Set(["init", ENSEMBLE_INIT_SKILL])

export function isInitAlias(value: string | undefined): boolean {
  return value !== undefined && INIT_ALIASES.has(value)
}

const INIT_SOLO_MESSAGE =
  "Init is solo-only. Send /init by itself; remove agent mentions, skills, and extra text."

function mentionEnds(text: string): number[] {
  const ends: number[] = []
  for (const match of text.matchAll(/(^|[\s([{])(?:[$!][A-Za-z][\w.-]*)/g)) {
    ends.push((match.index ?? 0) + match[0].length)
  }
  return ends
}

function slashTokensAt(text: string): Array<{ start: number; id: string }> {
  const tokens: Array<{ start: number; id: string }> = []
  for (const match of text.matchAll(/(^|[\s([{])\/([A-Za-z][\w.-]*)?(?=[\s,.;:!?)\]}'\"]|$)/g)) {
    const start = (match.index ?? 0) + match[1].length
    tokens.push({ start, id: match[2] ?? "" })
  }
  return tokens
}

/**
 * The composer must never fall through to native `/init`. A message-start
 * `:init`/`/init` is the solo Ensemble command. An init alias attached to an
 * agent anchor is a mixed request and is rejected before a message or task is
 * created. A prose `/init` (no anchor or message-start position) is ordinary
 * text and never reaches the native prompt through this path.
 */
export function initComposerIssue(value: string): string | undefined {
  const text = value.trim()
  if (!text) return undefined
  if (text.startsWith(":")) {
    const body = text.slice(1).trim()
    const command = body.split(/[\s:]+/, 1)[0]
    if (!isInitAlias(command)) return undefined
    return body === command ? undefined : INIT_SOLO_MESSAGE
  }
  const leading = text.length - text.trimStart().length
  const tokens = slashTokensAt(text)
  const anchors = mentionEnds(text)
  for (const token of tokens) {
    if (!isInitAlias(token.id)) continue
    if (token.start === leading) {
      return text === `/${token.id}` ? undefined : INIT_SOLO_MESSAGE
    }
    if (anchors.some((end) => end <= token.start)) return INIT_SOLO_MESSAGE
  }
  return undefined
}

function rollbackLine(previousExisted: boolean): string {
  return previousExisted
    ? "AGENTS.md was restored to its previous content."
    : "AGENTS.md was removed because it did not exist before init."
}

export function initSuccessReport(directory: string, nativeReport: string): string {
  const detail = nativeReport.trim()
  return [
    "Ensemble init complete.",
    detail ? `Native init report:\n${detail}` : "Native init returned no report text.",
    "",
    `- Inspected ${directory}`,
    "- Wrote AGENTS.md: canonical Ensemble block installed at the top.",
    "- Wrote .ensemble/init.json: Ensemble init metadata recorded.",
  ].join("\n")
}

export function initFailureReport(message: string, previousExisted: boolean): string {
  return [
    `Ensemble init failed: ${message}`,
    rollbackLine(previousExisted),
    "Rerun /init after fixing the failure.",
  ].join("\n")
}

export function initCancelReport(reason: string, previousExisted = true): string {
  return [
    `Ensemble init cancelled: ${reason}`,
    rollbackLine(previousExisted),
    "Rerun /init when the workspace is ready.",
  ].join("\n")
}

/** Restart recovery report: a running job cannot keep its native session. */
export function initInterruptedReport(previousExisted: boolean): string {
  return [
    "Ensemble init was interrupted by a service restart.",
    rollbackLine(previousExisted),
    "Rerun /init to try again.",
  ].join("\n")
}
