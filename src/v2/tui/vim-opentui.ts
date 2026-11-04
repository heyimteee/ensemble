/**
 * Thin OpenTUI adapters for the Vim Normal editor (ticket #85).
 *
 * The controller in `vim.ts` knows only the editor and clipboard ports. This
 * file maps them to `EditBufferRenderable` native edit APIs and the runtime
 * clipboard exports. `setText` is never called after mount because it clears
 * undo history; edits use cursor seeks, insertText, and selection deletion.
 */

import * as core from "@opentui/core"
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

type ClipboardCore = {
  createHostClipboard?: (options?: { timeoutMs?: number; maxReadBytes?: number; maxWriteBytes?: number }) => any
  createClipboard?: (options: { host: any; terminal: any }) => any
  createRendererClipboardAdapter?: (renderer: any) => any
}

type ClipboardService = {
  read(options: { preferredTypes: string[]; signal?: AbortSignal }): Promise<any>
  writeText(text: string, options: { destination: string; signal?: AbortSignal }): Promise<any>
  dispose?(): Promise<void>
}

const CLIPBOARD_TIMEOUT_MS = 800
const decoder = new TextDecoder()

function clipboardSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(CLIPBOARD_TIMEOUT_MS * 2)
    : undefined
}

/**
 * System clipboard first with the internal register as fallback. OpenTUI's
 * clipboard exports are present at runtime but missing from the package type
 * entry, so the adapter keeps a narrow local view of them.
 */
export function createClipboardPort(renderer: unknown): VimClipboardPort & { dispose(): void } {
  const runtime = core as unknown as ClipboardCore
  let service: ClipboardService | null = null

  const ensure = (): ClipboardService | null => {
    if (service) return service
    try {
      if (!runtime.createHostClipboard || !runtime.createClipboard || !runtime.createRendererClipboardAdapter) return null
      const host = runtime.createHostClipboard({ timeoutMs: CLIPBOARD_TIMEOUT_MS })
      const terminal = runtime.createRendererClipboardAdapter(renderer)
      service = runtime.createClipboard({ host, terminal })
      return service
    } catch {
      return null
    }
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
