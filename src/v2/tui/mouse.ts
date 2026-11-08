/**
 * v5.6 T9: mouse selection normalization and copy-on-release (ticket #87).
 *
 * OpenTUI owns the mouse gesture and emits a renderer selection on release.
 * This module normalizes that payload into a small value: the selected text,
 * the pane where the drag started, and the click behavior (drag/word/line).
 * The copy handler takes clipboard, clear, and notify ports so the behavior
 * is unit-tested with fakes and the renderer adapter stays thin. Mouse input
 * never touches interaction mode or keyboard focus.
 */

/** Explicit pane markers let a normalized selection be bounded to its start pane. */
export const MOUSE_PANE_IDS = {
  rail: "ensemble-pane-rail",
  chat: "ensemble-pane-chat",
  work: "ensemble-pane-work",
  header: "ensemble-pane-header",
  statusline: "ensemble-pane-statusline",
  dialog: "ensemble-pane-dialog",
} as const

/**
 * Mouse gestures are catalogued next to keyboard bindings so help cannot
 * invent or omit one. OpenTUI owns the actual gesture; this table is the
 * single description the help and tests share.
 */
export type MouseGestureSpec = {
  id: string
  gesture: string
  title: string
}

export const MOUSE_GESTURES: readonly MouseGestureSpec[] = [
  { id: "mouse.wheel", gesture: "Wheel", title: "Scroll the scrollable pane under the pointer" },
  { id: "mouse.drag", gesture: "Drag", title: "Select text in the pane where the drag starts" },
  { id: "mouse.release", gesture: "Release", title: "Copy the selection to the system clipboard and show a toast" },
  { id: "mouse.double", gesture: "Double-click", title: "Select a word" },
  { id: "mouse.triple", gesture: "Triple-click", title: "Select a line" },
  { id: "mouse.work-card", gesture: "Click card", title: "Focus that Work card" },
  { id: "mouse.work-page", gesture: "Click ‹ ›", title: "Page the Work pane" },
  { id: "mouse.work-approval", gesture: "Click approval", title: "Focus an inline approval; click the focused row again to resolve it" },
]

const PANE_ID_PREFIX = "ensemble-pane-"

export type MousePane = string | null

export type MouseSelectionKind = "drag" | "word" | "line"

/** Minimal renderable shape needed to walk to the nearest pane marker. */
export type MousePaneRenderable = {
  id?: string
  parent?: MousePaneRenderable | null
  x?: number
  y?: number
  getSelectedText?: () => string
}

/** Minimal renderer Selection shape; OpenTUI's class satisfies it. */
export type MouseRendererSelection = {
  anchor: { x: number; y: number }
  focus: { x: number; y: number }
  behavior?: string
  bounds?: { x: number; y: number; width: number; height: number }
  selectedRenderables?: MousePaneRenderable[]
  getSelectedText?: () => string
}

export type NormalizedMouseSelection = {
  text: string
  kind: MouseSelectionKind
  pane: MousePane
  anchor: { x: number; y: number }
  bounds: { x: number; y: number; width: number; height: number }
}

/** The nearest explicit `ensemble-pane-*` ancestor, or null outside a pane. */
export function paneName(renderable: MousePaneRenderable | null | undefined): MousePane {
  for (let node = renderable ?? null; node; node = node.parent ?? null) {
    const id = typeof node.id === "string" ? node.id : ""
    if (id.startsWith(PANE_ID_PREFIX)) return id.slice(PANE_ID_PREFIX.length)
  }
  return null
}

function selectionKind(behavior: string | undefined): MouseSelectionKind {
  if (behavior === "word") return "word"
  if (behavior === "line") return "line"
  return "drag"
}

/**
 * Join the per-renderable selected text exactly as OpenTUI does: rows sorted
 * by y, segments on a row sorted by x, and no synthetic gaps.
 */
function joinSelectedText(renderables: MousePaneRenderable[]): string {
  const byRow = new Map<number, Array<{ x: number; text: string }>>()
  for (const renderable of renderables) {
    const text = typeof renderable.getSelectedText === "function" ? renderable.getSelectedText() : ""
    if (!text) continue
    const lines = text.split("\n")
    for (let index = 0; index < lines.length; index += 1) {
      const row = Number(renderable.y ?? 0) + index
      const segments = byRow.get(row) ?? []
      segments.push({ x: Number(renderable.x ?? 0), text: lines[index] ?? "" })
      byRow.set(row, segments)
    }
  }
  return [...byRow.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, segments]) => segments.sort((left, right) => left.x - right.x).map((segment) => segment.text).join(""))
    .join("\n")
}

/**
 * Normalize one renderer selection. Returns null for a plain click (OpenTUI
 * still selects one cell) and for blank text, so click-to-scroll controls and
 * empty drags never copy or toast. A drag that leaves its start pane keeps
 * only that pane's renderables.
 */
export function normalizeRendererSelection(
  selection: MouseRendererSelection | null | undefined,
  startPane: MousePane,
): NormalizedMouseSelection | null {
  if (!selection) return null
  const kind = selectionKind(selection.behavior)
  const anchor = { x: Number(selection.anchor.x), y: Number(selection.anchor.y) }
  const focus = { x: Number(selection.focus.x), y: Number(selection.focus.y) }
  // A behavior-"cell" gesture whose ends are the same cell is a click, not a
  // drag. Word and line clicks are real selections even when ends coincide.
  if (kind === "drag" && anchor.x === focus.x && anchor.y === focus.y) return null

  // Without a known start pane there is no honest boundary: a renderer
  // selection may span the rail, chat, and statusline, and copying it would
  // violate the pane-bounded rule. Refuse rather than guess.
  if (startPane === null) return null

  const selected = selection.selectedRenderables ?? []
  let text = ""
  if (selected.length > 0) {
    const bounded = selected.filter((renderable) => paneName(renderable) === startPane)
    if (bounded.length === 0) return null
    text = joinSelectedText(bounded)
  } else {
    text = selection.getSelectedText?.() ?? ""
  }
  if (text.trim().length === 0) return null

  return {
    text,
    kind,
    pane: startPane,
    anchor: { x: Number(selection.anchor.x), y: Number(selection.anchor.y) },
    bounds: selection.bounds
      ? {
          x: selection.bounds.x,
          y: selection.bounds.y,
          width: selection.bounds.width,
          height: selection.bounds.height,
        }
      : {
          x: Math.min(anchor.x, focus.x),
          y: Math.min(anchor.y, focus.y),
          width: Math.abs(focus.x - anchor.x) + 1,
          height: Math.abs(focus.y - anchor.y) + 1,
        },
  }
}

export type MouseSelectionOutcome = "copied" | "copy-failed" | "ignored"

export type MouseSelectionPorts = {
  writeClipboard: (text: string) => Promise<boolean>
  clearSelection: () => void
  notify: (message: string, tone: "success" | "error") => void
}

/**
 * Copy-on-release policy. Success clears the renderer selection and reports a
 * success toast; failure leaves the selection intact and reports an error so
 * the user can retry. The handler has no mode/focus port by construction:
 * mouse gestures cannot change either.
 */
export async function copyMouseSelection(
  selection: NormalizedMouseSelection | null,
  ports: MouseSelectionPorts,
): Promise<MouseSelectionOutcome> {
  if (!selection) return "ignored"
  let copied = false
  try {
    copied = await ports.writeClipboard(selection.text)
  } catch {
    copied = false
  }
  if (!copied) {
    ports.notify("Copy failed — selection kept", "error")
    return "copy-failed"
  }
  ports.clearSelection()
  ports.notify("Copied to clipboard", "success")
  return "copied"
}

/**
 * The renderer-event seam: normalize one selection using the pane where the
 * drag started, then apply the copy policy. A click that produced only
 * OpenTUI's one-cell highlight is dismissed without copying; a failed copy
 * never reaches clearSelection. The app adapter only maps OpenTUI callbacks
 * to these ports.
 */
export async function handleMouseSelection(
  selection: MouseRendererSelection | null | undefined,
  startPane: MousePane,
  ports: MouseSelectionPorts,
): Promise<MouseSelectionOutcome> {
  const normalized = normalizeRendererSelection(selection, startPane)
  if (!normalized) {
    if (selection) ports.clearSelection()
    return "ignored"
  }
  return copyMouseSelection(normalized, ports)
}
