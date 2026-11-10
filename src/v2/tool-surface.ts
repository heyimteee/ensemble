import { nativeFirstMode } from "./native-first.ts"
import type { Settings } from "./types.ts"

/**
 * Ticket #225: the tool surface is a migration setting, not a second routing
 * engine. The native surface keeps only decisions the server cannot infer
 * safely; the legacy surface is the one-release rollback.
 */
export const TOOL_SURFACES = ["native", "legacy"] as const

export type ToolSurface = (typeof TOOL_SURFACES)[number]

export function isToolSurface(value: unknown): value is ToolSurface {
  return typeof value === "string" && (TOOL_SURFACES as readonly string[]).includes(value)
}

/**
 * The native surface is the native-first cutover. `off` and `shadow` keep the
 * explicit path and therefore the full legacy toolset. An explicit
 * `toolSurface` wins so a rollback can keep native ingestion while restoring
 * the old tools, and a test can select either surface without changing modes.
 * The mention-routing kill switch takes precedence over both: it restores the
 * explicit path it turns off.
 */
export function effectiveToolSurface(settings: Pick<Settings, "nativeFirst" | "toolSurface" | "nativeMentionRouting"> | undefined): ToolSurface {
  // Ticket #221: the mention-routing kill switch must restore the explicit
  // path, not just refuse `$Name`. The legacy surface carries `send_message`,
  // `handoff`, and `delegate`; the native surface deliberately does not.
  if (nativeFirstMode(settings) === "on" && settings?.nativeMentionRouting === false) return "legacy"
  if (settings?.toolSurface && isToolSurface(settings.toolSurface)) return settings.toolSurface
  return nativeFirstMode(settings) === "on" ? "native" : "legacy"
}

/** Exact registered names per surface, in stable registration order. */
export const TOOL_SURFACE_TOOL_NAMES: Record<ToolSurface, readonly string[]> = {
  native: ["task_status", "review", "ask_person", "remember", "share"],
  legacy: [
    "workspace_info",
    "list_workspaces",
    "list_agents",
    "send_message",
    "handoff",
    "delegate",
    "task_status",
    "review",
    "ask_person",
    "remember",
    "share",
  ],
}
