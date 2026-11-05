/**
 * System Agent transcript identity and init job copy (ticket #100).
 *
 * The System Agent is not a roster member: it has no model, Skillbox, or
 * mention route. It authors normal left-side transcript bubbles through
 * `Message.displayAuthor` and reports the internal native init job.
 */

export const SYSTEM_AGENT_NAME = "System Agent"
export const INIT_COMMAND = "/init"
export const INIT_START_TEXT = "Initializing workspace…"
export const INIT_PROGRESS_TEXT = "Inspecting AGENTS.md and .ensemble/init.json with native /init…"

const INIT_TOKEN = /(^|\s)\/init(?=\s|$)/

/**
 * The composer must never fall through to native `/init`. `/init` is a solo
 * Ensemble command: any other token (an agent anchor, a skill, or extra text)
 * is rejected before a message or task is created.
 */
export function initComposerIssue(value: string): string | undefined {
  const text = value.trim()
  if (!INIT_TOKEN.test(text) || text === INIT_COMMAND) return undefined
  return "Init is solo-only. Send /init by itself; remove agent mentions, skills, and extra text."
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
