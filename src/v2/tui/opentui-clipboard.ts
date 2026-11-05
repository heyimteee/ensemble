/**
 * Typed compatibility shim for OpenTUI's clipboard service.
 *
 * Verified runtime: `@opentui/core` 0.7.0 (the version in package.json and
 * the pinned host plugin). In that release `index.d.ts` re-exports
 * `lib/clipboard.js` through `lib/index.js`, and `index.node.js` exports
 * `createHostClipboard`, `createClipboard`, and `createRendererClipboardAdapter`
 * at runtime. We import those typed names directly; no local `as` cast hides
 * the API.
 *
 * The peer range is `>=0.7.0`, so an older host build may not expose the
 * exports. The capability guard below returns null in that case and the Vim
 * controller falls back to its in-memory register (writes report failure,
 * reads miss). Callers therefore treat a null service as "system clipboard
 * unavailable", not as a fatal error.
 */

import * as core from "@opentui/core"
import type { ClipboardService, RendererClipboardBoundary } from "@opentui/core"

export const VERIFIED_OPENTUI_CLIPBOARD_VERSION = "0.7.0"

export type RuntimeClipboardOptions = {
  /** Host clipboard operation timeout in milliseconds. */
  timeoutMs?: number
}

/**
 * Build the system-first clipboard service for a renderer, or null when the
 * installed runtime is missing the exports. The type surface comes from
 * OpenTUI itself, so a future signature change breaks the build instead of
 * silently changing behavior.
 */
export function createRuntimeClipboard(
  renderer: RendererClipboardBoundary,
  options: RuntimeClipboardOptions = {},
): ClipboardService | null {
  const { createHostClipboard, createClipboard, createRendererClipboardAdapter } = core
  if (
    typeof createHostClipboard !== "function" ||
    typeof createClipboard !== "function" ||
    typeof createRendererClipboardAdapter !== "function"
  ) {
    return null
  }
  try {
    const host = createHostClipboard({ timeoutMs: options.timeoutMs ?? 800 })
    const terminal = createRendererClipboardAdapter(renderer)
    return createClipboard({ host, terminal })
  } catch {
    return null
  }
}
