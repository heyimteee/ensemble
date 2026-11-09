import type { NativeSubagentState, NativeSubagentRun } from "../types.ts"
import type { DerivedWorkStatus } from "../queue.ts"

/**
 * Ticket #187: native subagent Work cards.
 *
 * A native subagent is durable Ensemble work but is not a Subtask. Cards share
 * the task card grammar and join the parent dispatch group, while focus uses a
 * namespaced id so a child session can never collide with a task id. The
 * instruction is display-only: it is already bounded by the tracker, and every
 * renderer truncates it again to its actual card width.
 */

export const NATIVE_SUBAGENT_FOCUS_PREFIX = "native:"

export function nativeSubagentFocusID(childSessionID: string): string {
  return `${NATIVE_SUBAGENT_FOCUS_PREFIX}${childSessionID}`
}

export function nativeSubagentFocusChild(focusID: string | undefined): string | undefined {
  if (focusID === undefined || !focusID.startsWith(NATIVE_SUBAGENT_FOCUS_PREFIX)) return undefined
  const childSessionID = focusID.slice(NATIVE_SUBAGENT_FOCUS_PREFIX.length)
  return childSessionID.length > 0 ? childSessionID : undefined
}

/** The shared Work status a child session's bounded lifecycle maps onto. */
export function nativeSubagentWorkStatus(state: NativeSubagentState): DerivedWorkStatus {
  switch (state) {
    case "working":
      return "working"
    case "replied":
      return "replied"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
  }
}

/** The instruction head shown after the `Subagents:` prefix, truncated to a width when one is known. */
export function nativeSubagentTitle(
  run: Pick<NativeSubagentRun, "instruction">,
  width?: number,
): string {
  const instruction = run.instruction
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "subagent"
  const title = `Subagents: ${instruction}`
  if (width === undefined) return title
  const cells = Math.max(1, Math.floor(width))
  const characters = [...title]
  if (characters.length <= cells) return title
  return `${characters.slice(0, Math.max(1, cells - 1)).join("").trimEnd()}…`
}
