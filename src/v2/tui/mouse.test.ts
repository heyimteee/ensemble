import test from "node:test"
import assert from "node:assert/strict"
import { MOUSE_PANE_IDS, copyMouseSelection, handleMouseSelection, normalizeRendererSelection, paneName } from "./mouse.ts"

type FakeRenderable = {
  id?: string
  parent?: FakeRenderable | null
  x?: number
  y?: number
  text?: string
}

const renderable = (input: FakeRenderable) => ({
  ...input,
  getSelectedText: () => input.text ?? "",
})

/** A fake renderer Selection shaped like OpenTUI's after a drag release. */
const selection = (input: {
  anchor: { x: number; y: number }
  focus: { x: number; y: number }
  behavior?: "cell" | "word" | "line"
  renderables: ReturnType<typeof renderable>[]
}) => ({
  anchor: input.anchor,
  focus: input.focus,
  behavior: input.behavior ?? "cell",
  bounds: {
    x: Math.min(input.anchor.x, input.focus.x),
    y: Math.min(input.anchor.y, input.focus.y),
    width: Math.abs(input.focus.x - input.anchor.x) + 1,
    height: Math.abs(input.focus.y - input.anchor.y) + 1,
  },
  selectedRenderables: input.renderables,
  getSelectedText: () => input.renderables.map((entry) => entry.getSelectedText()).join(""),
})

const chatPane = (): FakeRenderable => ({ id: MOUSE_PANE_IDS.chat })
const railPane = (): FakeRenderable => ({ id: MOUSE_PANE_IDS.rail })

test("paneName returns the nearest explicit pane marker, or null outside a pane", () => {
  const rail = railPane()
  const chat = chatPane()
  const insideChat = { parent: { parent: chat } }
  assert.equal(paneName(insideChat), "chat")
  assert.equal(paneName({ parent: rail }), "rail")
  assert.equal(paneName({ parent: { parent: null } }), null)
  assert.equal(paneName(null), null)
  assert.equal(paneName({ id: "some-other-id" }), null, "only pane markers count")
})

test("a drag keeps only the text from the pane where it started", () => {
  const chat = chatPane()
  const rail = railPane()
  const selected = selection({
    anchor: { x: 10, y: 10 },
    focus: { x: 30, y: 12 },
    renderables: [
      renderable({ parent: rail, x: 0, y: 10, text: "Roster text" }),
      renderable({ parent: chat, x: 10, y: 10, text: "Group chat line" }),
      renderable({ parent: chat, x: 10, y: 11, text: "second line" }),
    ],
  })

  const normalized = normalizeRendererSelection(selected, "chat")
  assert.equal(normalized?.text, "Group chat line\nsecond line")
  assert.equal(normalized?.pane, "chat")
  assert.equal(normalized?.kind, "drag")
  assert.deepEqual(normalized?.bounds, { x: 10, y: 10, width: 21, height: 3 })
})

test("a drag without a known start pane never copies cross-pane text", () => {
  const selected = selection({
    anchor: { x: 1, y: 2 },
    focus: { x: 30, y: 2 },
    renderables: [
      renderable({ parent: railPane(), x: 1, y: 2, text: "roster" }),
      renderable({ parent: chatPane(), x: 12, y: 2, text: "chat" }),
    ],
  })
  assert.equal(normalizeRendererSelection(selected, null), null)

  const unpainted = selection({
    anchor: { x: 1, y: 2 },
    focus: { x: 3, y: 2 },
    renderables: [renderable({ x: 1, y: 2, text: "status" })],
  })
  assert.equal(normalizeRendererSelection(unpainted, null), null, "an unmarked renderable is not a pane")
})

test("a renderer payload without per-renderable text still copies its selected text", () => {
  const normalized = normalizeRendererSelection(
    {
      anchor: { x: 1, y: 2 },
      focus: { x: 5, y: 2 },
      behavior: "cell",
      getSelectedText: () => "selected text",
    },
    "chat",
  )
  assert.equal(normalized?.text, "selected text")
  assert.equal(normalized?.kind, "drag")
})

test("a drag with no renderables from its start pane is ignored", () => {
  const selected = selection({
    anchor: { x: 0, y: 10 },
    focus: { x: 8, y: 10 },
    renderables: [renderable({ parent: railPane(), x: 0, y: 10, text: "rail only" })],
  })
  assert.equal(normalizeRendererSelection(selected, "chat"), null)
})

test("a plain cell click never copies, so the jump control stays a button", () => {
  const clicking = selection({
    anchor: { x: 4, y: 8 },
    focus: { x: 4, y: 8 },
    renderables: [renderable({ parent: chatPane(), x: 4, y: 8, text: "↓" })],
  })
  assert.equal(normalizeRendererSelection(clicking, "chat"), null)

  const blank = selection({
    anchor: { x: 4, y: 8 },
    focus: { x: 9, y: 9 },
    renderables: [renderable({ parent: chatPane(), x: 4, y: 8, text: "   " })],
  })
  assert.equal(normalizeRendererSelection(blank, "chat"), null, "whitespace-only drags are ignored")
})

test("double-click carries word behavior and triple-click carries line behavior", () => {
  const word = normalizeRendererSelection(
    selection({
      anchor: { x: 4, y: 8 },
      focus: { x: 4, y: 8 },
      behavior: "word",
      renderables: [renderable({ parent: chatPane(), x: 4, y: 8, text: "hello" })],
    }),
    "chat",
  )
  assert.equal(word?.kind, "word")
  assert.equal(word?.text, "hello")

  const line = normalizeRendererSelection(
    selection({
      anchor: { x: 2, y: 4 },
      focus: { x: 9, y: 4 },
      behavior: "line",
      renderables: [renderable({ parent: chatPane(), x: 2, y: 4, text: "whole line" })],
    }),
    "chat",
  )
  assert.equal(line?.kind, "line")
  assert.equal(line?.text, "whole line")
})

const normalized = (text: string) => ({
  text,
  kind: "drag" as const,
  pane: "chat",
  anchor: { x: 1, y: 2 },
  bounds: { x: 1, y: 2, width: 4, height: 1 },
})

test("a successful release copy clears the renderer selection and reports success", async () => {
  const writes: string[] = []
  const cleared = { count: 0 }
  const notices: Array<[string, string]> = []
  const outcome = await copyMouseSelection(normalized("hello"), {
    writeClipboard: async (text) => {
      writes.push(text)
      return true
    },
    clearSelection: () => {
      cleared.count += 1
    },
    notify: (message, tone) => notices.push([message, tone]),
  })

  assert.equal(outcome, "copied")
  assert.deepEqual(writes, ["hello"])
  assert.equal(cleared.count, 1, "success clears the selection")
  assert.deepEqual(notices, [["Copied to clipboard", "success"]])
})

test("a failed copy keeps the selection and reports the error non-destructively", async () => {
  const cleared = { count: 0 }
  const notices: Array<[string, string]> = []
  const ports = {
    writeClipboard: async () => false,
    clearSelection: () => {
      cleared.count += 1
    },
    notify: (message: string, tone: "success" | "error") => notices.push([message, tone]),
  }

  assert.equal(await copyMouseSelection(normalized("hello"), ports), "copy-failed")
  assert.equal(cleared.count, 0, "failure keeps the selection for retry")
  assert.deepEqual(notices, [["Copy failed — selection kept", "error"]])

  const rejecting = {
    ...ports,
    writeClipboard: async () => {
      throw new Error("clipboard exploded")
    },
  }
  notices.length = 0
  assert.equal(await copyMouseSelection(normalized("hello"), rejecting), "copy-failed")
  assert.equal(cleared.count, 0)
  assert.deepEqual(notices, [["Copy failed — selection kept", "error"]])
})

test("no normalized selection means no clipboard, clear, or toast", async () => {
  let calls = 0
  const outcome = await copyMouseSelection(null, {
    writeClipboard: async () => {
      calls += 1
      return true
    },
    clearSelection: () => {
      calls += 1
    },
    notify: () => {
      calls += 1
    },
  })
  assert.equal(outcome, "ignored")
  assert.equal(calls, 0)
})

test("a renderer click dismisses its one-cell highlight without copying or toasting", async () => {
  const calls = { write: 0, clear: 0, notify: 0 }
  const ports = {
    writeClipboard: async () => {
      calls.write += 1
      return true
    },
    clearSelection: () => {
      calls.clear += 1
    },
    notify: () => {
      calls.notify += 1
    },
  }
  const click = selection({
    anchor: { x: 4, y: 8 },
    focus: { x: 4, y: 8 },
    renderables: [renderable({ parent: chatPane(), x: 4, y: 8, text: "↓" })],
  })

  assert.equal(await handleMouseSelection(click, "chat", ports), "ignored")
  assert.deepEqual(calls, { write: 0, clear: 1, notify: 0 })

  assert.equal(await handleMouseSelection(null, "chat", ports), "ignored")
  assert.deepEqual(calls, { write: 0, clear: 1, notify: 0 }, "no event leaves the selection alone")
})
