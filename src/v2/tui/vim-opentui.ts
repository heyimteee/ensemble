/**
 * Thin OpenTUI adapters for the Vim Normal editor (ticket #85).
 *
 * The controller in `vim.ts` knows only the editor and clipboard ports. This
 * file maps them to `EditBufferRenderable` native edit APIs and the runtime
 * clipboard exports. `setText` is never called after mount because it clears
 * undo history; edits use cursor seeks, insertText, and selection deletion.
 */

import { createRuntimeClipboard } from "./opentui-clipboard.ts"
import {
  createVimRegisterStore,
  VimBuffer,
  type VimClipboardPort,
  type VimEditorPort,
  type VimMessage,
  type VimRegisterStore,
} from "./vim.ts"

type RenderableEditor = {
  plainText?: string
  cursorOffset?: number
  insertText?: (text: string) => void
  setSelection?: (start: number, end: number) => void
  deleteSelection?: () => boolean
  clearSelection?: () => boolean
  undo?: () => boolean
  redo?: () => boolean
}

/** Map offset ranges onto the renderable's native, undoable edit operations. */
export function createEditorPort(renderable: RenderableEditor): VimEditorPort {
  return {
    text: () => String(renderable.plainText ?? ""),
    cursor: () => {
      const text = String(renderable.plainText ?? "")
      return Math.max(0, Math.min(text.length, Number(renderable.cursorOffset ?? 0)))
    },
    setCursor: (offset) => {
      renderable.cursorOffset = Math.max(0, offset)
    },
    replace: (start, end, text) => {
      if (start === end) {
        if (!text) return
        renderable.cursorOffset = start
        renderable.insertText?.(text)
        return
      }
      renderable.setSelection?.(start, end)
      if (!renderable.deleteSelection?.()) {
        renderable.clearSelection?.()
        return
      }
      if (text) {
        renderable.cursorOffset = start
        renderable.insertText?.(text)
      }
    },
    undo: () => {
      renderable.undo?.()
    },
    redo: () => {
      renderable.redo?.()
    },
    select: (start, end) => {
      renderable.setSelection?.(start, end)
    },
    clearSelection: () => {
      renderable.clearSelection?.()
    },
  }
}

const CLIPBOARD_TIMEOUT_MS = 800
const decoder = new TextDecoder()

function clipboardSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(CLIPBOARD_TIMEOUT_MS * 2)
    : undefined
}

/**
 * System clipboard first with the internal register as fallback. The typed
 * shim owns the runtime-version guard; this adapter only maps its results to
 * the Vim clipboard port.
 */
export function createClipboardPort(renderer: Parameters<typeof createRuntimeClipboard>[0]): VimClipboardPort & { dispose(): void } {
  let service: ReturnType<typeof createRuntimeClipboard> = null

  const ensure = (): ReturnType<typeof createRuntimeClipboard> => {
    if (service) return service
    service = createRuntimeClipboard(renderer, { timeoutMs: CLIPBOARD_TIMEOUT_MS })
    return service
  }

  return {
    async write(text: string): Promise<boolean> {
      const clipboard = ensure()
      if (!clipboard) return false
      try {
        const result = await clipboard.writeText(text, {
          destination: "best-available",
          signal: clipboardSignal(),
        })
        return result?.host?.status === "written" || result?.terminal?.status === "attempted"
      } catch {
        return false
      }
    },
    async read(): Promise<string | null> {
      const clipboard = ensure()
      if (!clipboard) return null
      try {
        const result = await clipboard.read({
          preferredTypes: ["text/plain"],
          signal: clipboardSignal(),
        })
        if (result?.status !== "read") return null
        const bytes = result.representation?.bytes
        if (!(bytes instanceof Uint8Array) || bytes.length === 0) return null
        const value = decoder.decode(bytes)
        return value.length > 0 ? value : null
      } catch {
        return null
      }
    },
    dispose(): void {
      const current = service
      service = null
      const pending = current?.dispose?.()
      if (pending && typeof pending.catch === "function") void pending.catch(() => {})
    },
  }
}

export function createVimBuffer(input: {
  editor: VimEditorPort
  clipboard: VimClipboardPort
  register?: VimRegisterStore
  onMessage?: (message: VimMessage) => void
}): VimBuffer {
  return new VimBuffer(
    input.editor,
    input.clipboard,
    input.register ?? createVimRegisterStore(),
    input.onMessage,
  )
}
