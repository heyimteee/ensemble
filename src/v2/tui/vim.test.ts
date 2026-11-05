import test from "node:test"
import assert from "node:assert/strict"
import {
  clampVimCursor,
  createVimRegisterStore,
  deletePlan,
  insertEntry,
  motionTarget,
  normalizeVimKey,
  pastePlan,
  registerFromClipboard,
  resolveVimKey,
  resolveVisualKey,
  VimBuffer,
  vimLines,
  visualPastePlan,
  visualRange,
  visualRegister,
  visualSelectionSize,
  yankLine,
  type VimClipboardPort,
  type VimEditorPort,
  type VimMessage,
  type VimVisualSelection,
} from "./vim.ts"

test("line splitting keeps the trailing empty line and newline boundaries", () => {
  assert.deepEqual(vimLines(""), [{ start: 0, end: 0, next: 0 }])
  assert.deepEqual(vimLines("abc"), [{ start: 0, end: 3, next: 3 }])
  assert.deepEqual(vimLines("a\nb\n"), [
    { start: 0, end: 1, next: 2 },
    { start: 2, end: 3, next: 4 },
    { start: 4, end: 4, next: 4 },
  ])
})

test("normal-mode cursor stays on a character, never on the newline", () => {
  assert.equal(clampVimCursor("", 0), 0)
  assert.equal(clampVimCursor("abc", 3), 2)
  assert.equal(clampVimCursor("abc\ndef", 3), 2, "offset on the newline snaps to the line end")
  assert.equal(clampVimCursor("abc\ndef", 4), 4)
  assert.equal(clampVimCursor("a\n\nb", 2), 2, "an empty line keeps its own start")
  assert.equal(clampVimCursor("a\n", 2), 2, "the trailing empty line is addressable")
})

test("horizontal, vertical, and buffer motions follow Vim boundaries", () => {
  const text = "one two\nthree"
  assert.equal(motionTarget(text, 0, "l"), 1)
  assert.equal(motionTarget(text, 1, "h"), 0)
  assert.equal(motionTarget(text, 0, "h"), 0, "h does not cross the line start")
  assert.equal(motionTarget(text, 6, "l"), 6, "l does not cross the line end")
  assert.equal(motionTarget(text, 0, "$"), 6)
  assert.equal(motionTarget(text, 6, "0"), 0)
  assert.equal(motionTarget(text, 4, "^"), 0)
  assert.equal(motionTarget(text, 0, "j"), 8)
  assert.equal(motionTarget(text, 5, "j"), 12, "vertical motion clamps to the target line")
  assert.equal(motionTarget(text, 12, "k", 5), 5, "the preferred column survives a short line")
  assert.equal(motionTarget(text, 5, "G"), 8)
  assert.equal(motionTarget(text, 12, "gg"), 0)
})

test("caret skips indentation and vertical motion clamps to the target line", () => {
  const text = "  abc\nx\nlonger line"
  assert.equal(motionTarget(text, 5, "^"), 2)
  assert.equal(motionTarget(text, 4, "j", 4), 6, "the short line clamps to its only character")
  assert.equal(motionTarget(text, 6, "j", 4), 12, "the preferred column returns on a longer line")
  assert.equal(motionTarget(text, 12, "k", 4), 6)
})

test("word motions treat punctuation and whitespace as boundaries", () => {
  const text = "foo.bar baz\nqux"
  assert.equal(motionTarget(text, 0, "w"), 3, "punctuation starts its own word")
  assert.equal(motionTarget(text, 3, "w"), 4)
  assert.equal(motionTarget(text, 0, "e"), 2)
  assert.equal(motionTarget(text, 2, "e"), 3, "a punctuation run is its own word")
  assert.equal(motionTarget(text, 3, "e"), 6)
  assert.equal(motionTarget(text, 8, "b"), 4)
  assert.equal(motionTarget(text, 12, "b"), 8, "b crosses a newline to the previous word")
  assert.equal(motionTarget(text, 0, "b"), 0)
})

test("normal keys normalize shifted letters and control chords", () => {
  assert.equal(normalizeVimKey({ name: "g" }), "g")
  assert.equal(normalizeVimKey({ name: "g", shift: true }), "G")
  assert.equal(normalizeVimKey({ name: "$" }), "$")
  assert.equal(normalizeVimKey({ name: "r", ctrl: true }), "ctrl+r")
  assert.equal(normalizeVimKey({ name: "escape" }), "escape")
})

test("the key resolver owns operators, prefixes, and cancellation", () => {
  assert.deepEqual(resolveVimKey("", "h"), { type: "command", command: { type: "motion", motion: "h" } })
  assert.deepEqual(resolveVimKey("", "d"), { type: "pending", pending: "d" })
  assert.deepEqual(resolveVimKey("d", "d"), { type: "command", command: { type: "delete.line" } })
  assert.deepEqual(resolveVimKey("d", "w"), {
    type: "command",
    command: { type: "delete.motion", motion: "w" },
  })
  assert.deepEqual(resolveVimKey("d", "g"), { type: "pending", pending: "dg" })
  assert.deepEqual(resolveVimKey("dg", "g"), {
    type: "command",
    command: { type: "delete.motion", motion: "gg" },
  })
  assert.deepEqual(resolveVimKey("y", "y"), { type: "command", command: { type: "yank.line" } })
  assert.deepEqual(resolveVimKey("g", "g"), { type: "command", command: { type: "motion", motion: "gg" } })
  assert.deepEqual(resolveVimKey("d", "x"), { type: "cancel" })
  assert.deepEqual(resolveVimKey("", "?"), { type: "unhandled" })
})

test("insert entries put the cursor where Vim does", () => {
  assert.deepEqual(insertEntry("abc", 1, "before"), { insertAt: 1, text: "", cursor: 1 })
  assert.deepEqual(insertEntry("abc", 1, "after"), { insertAt: 2, text: "", cursor: 2 })
  assert.deepEqual(insertEntry("abc", 2, "after"), { insertAt: 3, text: "", cursor: 3 })
  assert.deepEqual(insertEntry("  abc", 1, "lineStart"), { insertAt: 2, text: "", cursor: 2 })
  assert.deepEqual(insertEntry("  abc", 1, "lineEnd"), { insertAt: 5, text: "", cursor: 5 })
  assert.deepEqual(insertEntry("abc", 1, "lineBelow"), { insertAt: 3, text: "\n", cursor: 4 })
  assert.deepEqual(insertEntry("abc\ndef", 5, "lineAbove"), { insertAt: 4, text: "\n", cursor: 4 })
  assert.deepEqual(insertEntry("", 0, "lineBelow"), { insertAt: 0, text: "\n", cursor: 1 })
})

test("single-key and operator deletes produce exact cut ranges", () => {
  assert.deepEqual(deletePlan("abc", 1, { type: "x" }), {
    start: 1,
    end: 2,
    linewise: false,
    register: "b",
    cursor: 1,
  })
  assert.equal(deletePlan("abc", 2, { type: "x" })?.register, "c")
  assert.equal(deletePlan("", 0, { type: "x" }), null)

  assert.deepEqual(deletePlan("one two", 4, { type: "D" }), {
    start: 4,
    end: 7,
    linewise: false,
    register: "two",
    cursor: 4,
  })
  assert.equal(deletePlan("one", 2, { type: "D" })?.register, "e")

  assert.deepEqual(deletePlan("one two three", 0, { type: "delete.motion", motion: "w" }), {
    start: 0,
    end: 4,
    linewise: false,
    register: "one ",
    cursor: 0,
  })
  assert.equal(deletePlan("one two", 0, { type: "delete.motion", motion: "e" })?.register, "one")
  assert.equal(deletePlan("one two", 6, { type: "delete.motion", motion: "b" })?.register, "tw")
  assert.equal(deletePlan("one two", 4, { type: "delete.motion", motion: "0" })?.register, "one ")
  assert.equal(deletePlan("one two", 0, { type: "delete.motion", motion: "$" })?.register, "one two")
  assert.equal(deletePlan("abc", 1, { type: "delete.motion", motion: "h" })?.register, "a")
  assert.equal(deletePlan("abc", 1, { type: "delete.motion", motion: "l" })?.register, "b")
  assert.equal(deletePlan("abc", 2, { type: "delete.motion", motion: "l" })?.register, "c")
})

test("linewise deletes keep whole lines and include the newline", () => {
  assert.deepEqual(deletePlan("a\nb", 0, { type: "delete.line" }), {
    start: 0,
    end: 2,
    linewise: true,
    register: "a\n",
    cursor: 0,
  })
  assert.deepEqual(deletePlan("a\nb", 2, { type: "delete.line" }), {
    start: 2,
    end: 3,
    linewise: true,
    register: "b\n",
    cursor: 2,
  })
  assert.equal(deletePlan("abc\ndef", 1, { type: "delete.line" })?.cursor, 0, "dd lands on the replacement line start")
  assert.equal(deletePlan("a\nb\nc", 3, { type: "delete.motion", motion: "j" })?.register, "b\nc\n")
  assert.equal(deletePlan("a\nb\nc", 3, { type: "delete.motion", motion: "k" })?.register, "a\nb\n")
  assert.equal(deletePlan("a\nb\nc", 3, { type: "delete.motion", motion: "gg" })?.register, "a\nb\n")
  assert.equal(deletePlan("a\nb\nc", 3, { type: "delete.motion", motion: "G" })?.register, "b\nc\n")
  assert.equal(deletePlan("a\nb", 0, { type: "delete.motion", motion: "k" }), null)
})

test("yy yanks the whole line, terminated for linewise paste", () => {
  assert.deepEqual(yankLine("a\nb", 0), { text: "a\n", linewise: true })
  assert.deepEqual(yankLine("a\nb", 2), { text: "b\n", linewise: true })
  assert.deepEqual(yankLine("a\n", 2), { text: "\n", linewise: true })
})

test("linewise paste goes below and above; charwise paste sits at the cursor", () => {
  const line = { text: "a\n", linewise: true }
  assert.deepEqual(pastePlan("a\nb", 0, line, false), {
    insertAt: 2,
    text: "a\n",
    linewise: true,
    cursor: 2,
    result: "a\na\nb",
  })
  assert.deepEqual(pastePlan("a\nb", 2, line, false), {
    insertAt: 3,
    text: "\na\n",
    linewise: true,
    cursor: 4,
    result: "a\nb\na\n",
  })
  assert.deepEqual(pastePlan("a\nb", 2, line, true), {
    insertAt: 2,
    text: "a\n",
    linewise: true,
    cursor: 2,
    result: "a\na\nb",
  })

  const chars = { text: "XY", linewise: false }
  assert.deepEqual(pastePlan("abc", 1, chars, false), {
    insertAt: 2,
    text: "XY",
    linewise: false,
    cursor: 3,
    result: "abXYc",
  })
  assert.deepEqual(pastePlan("abc", 1, chars, true), {
    insertAt: 1,
    text: "XY",
    linewise: false,
    cursor: 2,
    result: "aXYbc",
  })
  assert.equal(pastePlan("", 0, chars, false)?.result, "XY")
  assert.equal(pastePlan("a\n\nb", 2, chars, false)?.insertAt, 2, "an empty line pastes at its start")
  assert.equal(pastePlan("abc", 0, { text: "", linewise: false }, false), null)
})

test("visual ranges are inclusive for chars and cover whole lines for V-LINE", () => {
  assert.deepEqual(visualRange("one two", 0, 3, "char"), {
    start: 0,
    end: 4,
    linewise: false,
    text: "one ",
  })
  assert.deepEqual(visualRange("one two", 3, 0, "char"), visualRange("one two", 0, 3, "char"))
  assert.deepEqual(visualRange("a\nb\nc", 2, 0, "line"), {
    start: 0,
    end: 4,
    linewise: true,
    text: "a\nb\n",
  })
  assert.deepEqual(visualRange("a\nb", 0, 2, "line"), {
    start: 0,
    end: 3,
    linewise: true,
    text: "a\nb",
  })
  assert.deepEqual(visualRange("", 0, 0, "char"), { start: 0, end: 0, linewise: false, text: "" })
  assert.deepEqual(visualRange("abc", 99, 99, "char"), { start: 2, end: 3, linewise: false, text: "c" })
})

test("visual registers keep charwise text and terminate linewise yanks", () => {
  const chars: VimVisualSelection = { kind: "char", anchor: 0, cursor: 3 }
  assert.deepEqual(visualRegister("one two", chars), { text: "one ", linewise: false })
  assert.deepEqual(visualRegister("a\nb", { kind: "line", anchor: 0, cursor: 2 }), {
    text: "a\nb\n",
    linewise: true,
  })
  assert.deepEqual(visualRegister("a\n", { kind: "line", anchor: 2, cursor: 2 }), {
    text: "\n",
    linewise: true,
  })
  assert.deepEqual(visualRegister("", { kind: "line", anchor: 0, cursor: 0 }), {
    text: "\n",
    linewise: true,
  })
})

test("visual size labels characters and lines for the statusline", () => {
  assert.equal(visualSelectionSize("one two", { kind: "char", anchor: 0, cursor: 3 }), "4 chars")
  assert.equal(visualSelectionSize("one two", { kind: "char", anchor: 1, cursor: 1 }), "1 char")
  assert.equal(visualSelectionSize("a\nb\nc", { kind: "line", anchor: 0, cursor: 3 }), "2 lines")
  assert.equal(visualSelectionSize("a\nb", { kind: "line", anchor: 0, cursor: 0 }), "1 line")
})

test("visual paste replaces the selection and preserves line structure", () => {
  assert.deepEqual(
    visualPastePlan("one two", { kind: "char", anchor: 0, cursor: 3 }, { text: "X", linewise: false }),
    { insertAt: 0, text: "X", linewise: false, cursor: 0, result: "Xtwo" },
  )
  assert.deepEqual(
    visualPastePlan("a\nb\nc", { kind: "line", anchor: 2, cursor: 0 }, { text: "X\n", linewise: true }),
    { insertAt: 0, text: "X\n", linewise: true, cursor: 0, result: "X\nc" },
  )
  assert.deepEqual(
    visualPastePlan("a\nb\nc", { kind: "line", anchor: 0, cursor: 2 }, { text: "X", linewise: false }),
    { insertAt: 0, text: "X\n", linewise: true, cursor: 0, result: "X\nc" },
  )
  assert.equal(
    visualPastePlan("one two", { kind: "char", anchor: 0, cursor: 3 }, { text: "", linewise: false }),
    null,
  )
})

test("the visual key resolver maps motions, operators, and exits", () => {
  assert.deepEqual(resolveVisualKey("", "l"), { type: "command", command: { type: "extend", motion: "l" } })
  assert.deepEqual(resolveVisualKey("", "G"), { type: "command", command: { type: "extend", motion: "G" } })
  assert.deepEqual(resolveVisualKey("", "g"), { type: "pending", pending: "g" })
  assert.deepEqual(resolveVisualKey("g", "g"), { type: "command", command: { type: "extend", motion: "gg" } })
  assert.deepEqual(resolveVisualKey("g", "x"), { type: "cancel" })
  assert.deepEqual(resolveVisualKey("", "o"), { type: "command", command: { type: "swap" } })
  assert.deepEqual(resolveVisualKey("", "y"), { type: "command", command: { type: "yank" } })
  assert.deepEqual(resolveVisualKey("", "d"), { type: "command", command: { type: "delete" } })
  assert.deepEqual(resolveVisualKey("", "x"), { type: "command", command: { type: "delete" } })
  assert.deepEqual(resolveVisualKey("", "c"), { type: "command", command: { type: "change" } })
  assert.deepEqual(resolveVisualKey("", "p"), { type: "command", command: { type: "paste", before: false } })
  assert.deepEqual(resolveVisualKey("", "P"), { type: "command", command: { type: "paste", before: true } })
  assert.deepEqual(resolveVisualKey("", "escape"), { type: "command", command: { type: "exit" } })
  assert.deepEqual(resolveVisualKey("", "v"), { type: "command", command: { type: "exit" } })
  assert.deepEqual(resolveVisualKey("", "V"), { type: "command", command: { type: "line" } })
  assert.deepEqual(resolveVisualKey("", "z"), { type: "unhandled" })
})

test("system clipboard text infers linewise behavior", () => {
  assert.deepEqual(registerFromClipboard("one\ntwo\n", { text: "", linewise: false }), {
    text: "one\ntwo\n",
    linewise: true,
  })
  assert.deepEqual(registerFromClipboard("one", { text: "", linewise: false }), {
    text: "one",
    linewise: false,
  })
  assert.deepEqual(registerFromClipboard("line\n", { text: "line\n", linewise: true }), {
    text: "line\n",
    linewise: true,
  })
})

class FakeEditor implements VimEditorPort {
  value: string
  offset: number
  undoStack: Array<{ text: string; cursor: number }> = []
  redoStack: Array<{ text: string; cursor: number }> = []

  constructor(text: string, cursor = 0) {
    this.value = text
    this.offset = cursor
  }

  text(): string {
    return this.value
  }

  cursor(): number {
    return this.offset
  }

  setCursor(offset: number): void {
    this.offset = Math.max(0, Math.min(this.value.length, offset))
  }

  replace(start: number, end: number, text: string): void {
    this.undoStack.push({ text: this.value, cursor: this.offset })
    this.redoStack = []
    this.value = `${this.value.slice(0, start)}${text}${this.value.slice(end)}`
    this.offset = Math.min(this.value.length, start + text.length)
  }

  undo(): void {
    const previous = this.undoStack.pop()
    if (!previous) return
    this.redoStack.push({ text: this.value, cursor: this.offset })
    this.value = previous.text
    this.offset = previous.cursor
  }

  redo(): void {
    const next = this.redoStack.pop()
    if (!next) return
    this.undoStack.push({ text: this.value, cursor: this.offset })
    this.value = next.text
    this.offset = next.cursor
  }
}

class FakeClipboard implements VimClipboardPort {
  written: string[] = []
  fail = false
  readValue: string | null = null
  readImpl: (() => Promise<string | null>) | null = null

  async write(text: string): Promise<boolean> {
    this.written.push(text)
    return !this.fail
  }

  read(): Promise<string | null> {
    return this.readImpl ? this.readImpl() : Promise.resolve(this.readValue)
  }
}

function controller(text: string, cursor = 0) {
  const editor = new FakeEditor(text, cursor)
  const clipboard = new FakeClipboard()
  const messages: VimMessage[] = []
  const buffer = new VimBuffer(editor, clipboard, createVimRegisterStore(), (message) => messages.push(message))
  return { editor, clipboard, messages, buffer }
}

test("motions move the cursor through the editor port", async () => {
  const { editor, buffer } = controller("one two\nthree")
  await buffer.press("l")
  assert.equal(editor.cursor(), 1)
  await buffer.press("w")
  assert.equal(editor.cursor(), 4)
  await buffer.press("j")
  assert.equal(editor.cursor(), 12)
  await buffer.press("$")
  assert.equal(editor.cursor(), 12)
  await buffer.press("g")
  await buffer.press("g")
  assert.equal(editor.cursor(), 0)
  await buffer.press("G")
  assert.equal(editor.cursor(), 8)
})

test("insert entries switch to Insert and place the cursor", async () => {
  const { editor, buffer } = controller("one two", 1)
  assert.equal((await buffer.press("i")).mode, "insert")
  assert.equal(editor.cursor(), 1)

  const after = controller("one two", 1)
  assert.equal((await after.buffer.press("a")).mode, "insert")
  assert.equal(after.editor.cursor(), 2)

  const below = controller("one two", 1)
  assert.equal((await below.buffer.press("o")).mode, "insert")
  assert.equal(below.editor.text(), "one two\n")
  assert.equal(below.editor.cursor(), 8)

  const above = controller("abc\ndef", 5)
  assert.equal((await above.buffer.press("O")).mode, "insert")
  assert.equal(above.editor.text(), "abc\n\ndef")
  assert.equal(above.editor.cursor(), 4)
})

test("x and dd cut through the clipboard and keep the internal register", async () => {
  const { editor, clipboard, messages, buffer } = controller("abc\ndef", 1)
  await buffer.press("x")
  assert.equal(editor.text(), "ac\ndef")
  assert.equal(editor.cursor(), 1)
  assert.deepEqual(clipboard.written, ["b"])
  assert.deepEqual(buffer.registerState, { text: "b", linewise: false })

  await buffer.press("d")
  await buffer.press("d")
  assert.equal(editor.text(), "def")
  assert.deepEqual(clipboard.written, ["b", "ac\n"])
  assert.deepEqual(buffer.registerState, { text: "ac\n", linewise: true })
  assert.equal(messages.at(-1)?.tone, "success")
})

test("yy yanks a line and p/P paste linewise and charwise", async () => {
  const { editor, clipboard, buffer } = controller("a\nb", 0)
  await buffer.press("y")
  await buffer.press("y")
  assert.deepEqual(clipboard.written, ["a\n"])
  assert.deepEqual(buffer.registerState, { text: "a\n", linewise: true })

  await buffer.press("p")
  assert.equal(editor.text(), "a\na\nb")
  assert.equal(editor.cursor(), 2)

  const chars = controller("abc", 1)
  await chars.buffer.press("p")
  assert.equal(chars.editor.text(), "abc", "pasting an empty register is a no-op")

  const paste = controller("abc", 1)
  paste.clipboard.readValue = "XY"
  await paste.buffer.press("p")
  assert.equal(paste.editor.text(), "abXYc")
  assert.equal(paste.editor.cursor(), 3)
  await paste.buffer.press("P")
  assert.equal(paste.editor.text(), "abXXYYc")
  assert.equal(paste.editor.cursor(), 4)
})

test("paste reads the system clipboard first and falls back to the internal register", async () => {
  const system = controller("a\nb", 0)
  await system.buffer.press("y")
  await system.buffer.press("y")
  system.clipboard.readValue = "SYSTEM"
  await system.buffer.press("p")
  assert.equal(system.editor.text(), "aSYSTEM\nb")

  const fallback = controller("a\nb", 0)
  await fallback.buffer.press("y")
  await fallback.buffer.press("y")
  fallback.clipboard.readValue = null
  await fallback.buffer.press("P")
  assert.equal(fallback.editor.text(), "a\na\nb")
})

test("clipboard failure keeps the cut internal and reports an error", async () => {
  const { editor, clipboard, messages, buffer } = controller("abc", 0)
  clipboard.fail = true
  await buffer.press("d")
  await buffer.press("d")
  await buffer.settle()
  assert.equal(editor.text(), "")
  assert.deepEqual(buffer.registerState, { text: "abc\n", linewise: true })
  assert.ok(messages.some((message) => message.tone === "error" && /clipboard unavailable/.test(message.text)))

  clipboard.fail = false
  clipboard.readValue = null
  editor.replace(0, 0, "xyz")
  editor.setCursor(0)
  await buffer.press("p")
  assert.equal(editor.text(), "xyz\nabc\n", "the internal register still pastes")
})

test("an in-flight paste is discarded when another key or focus change intervenes", async () => {
  const { editor, clipboard, buffer } = controller("abc", 0)
  await buffer.press("y")
  await buffer.press("y")

  let resolveRead: ((value: string | null) => void) | undefined
  clipboard.readImpl = () => new Promise((resolve) => { resolveRead = resolve })

  const pending = buffer.press("p")
  await buffer.press("l")
  resolveRead?.("SHOULD NOT PASTE")
  await pending
  assert.equal(editor.text(), "abc")

  let resolveReadAgain: ((value: string | null) => void) | undefined
  clipboard.readImpl = () => new Promise((resolve) => { resolveReadAgain = resolve })
  const discarded = buffer.press("P")
  buffer.invalidate()
  resolveReadAgain?.("SHOULD NOT PASTE")
  await discarded
  assert.equal(editor.text(), "abc")
})

test("pending operator chords surface for the statusline", async () => {
  const { editor, buffer } = controller("a\nb\nc", 3)
  assert.equal((await buffer.press("d")).pendingChord, "d")
  assert.equal((await buffer.press("g")).pendingChord, "dg")
  assert.equal((await buffer.press("g")).pendingChord, null)
  assert.equal(editor.text(), "c")
  assert.deepEqual(buffer.registerState, { text: "a\nb\n", linewise: true })
})

test("paste after a failed cut uses the internal register when the system clipboard is stale", async () => {
  const { editor, clipboard, buffer } = controller("abc", 0)
  clipboard.fail = true
  clipboard.readValue = "STALE"
  await buffer.press("d")
  await buffer.press("d")
  await buffer.settle()
  assert.equal(editor.text(), "")
  await buffer.press("P")
  assert.equal(editor.text(), "abc\n", "the cut stays the paste source when the system write failed")
})

test("undo and redo use the editor history", async () => {
  const { editor, buffer } = controller("abc", 1)
  await buffer.press("x")
  assert.equal(editor.text(), "ac")
  await buffer.press("u")
  assert.equal(editor.text(), "abc")
  await buffer.press("ctrl+r")
  assert.equal(editor.text(), "ac")
})

test("v enters Visual, motions extend it, and o swaps the selection ends", async () => {
  const { editor, buffer } = controller("one two\nthree", 0)
  const entered = await buffer.press("v")
  assert.equal(entered.mode, "visual")
  assert.deepEqual(entered.selection, { kind: "char", anchor: 0, cursor: 0 })

  const extended = await buffer.press("l")
  assert.equal(extended.mode, "visual")
  assert.deepEqual(extended.selection, { kind: "char", anchor: 0, cursor: 1 })
  await buffer.press("w")
  assert.deepEqual(buffer.visualSelection, { kind: "char", anchor: 0, cursor: 4 })

  const swapped = await buffer.press("o")
  assert.equal(swapped.mode, "visual")
  assert.deepEqual(swapped.selection, { kind: "char", anchor: 4, cursor: 0 })
  assert.equal(editor.cursor(), 0)

  const cancelled = await buffer.press("escape")
  assert.equal(cancelled.mode, "normal")
  assert.equal(buffer.visualSelection, null)
})

test("V selects whole lines and gg/G extend the line selection", async () => {
  const { buffer } = controller("a\nb\nc", 3)
  const entered = await buffer.press("V")
  assert.deepEqual(entered.selection, { kind: "line", anchor: 2, cursor: 2 }, "Normal cursor snaps off the newline")

  const first = await buffer.press("g")
  assert.equal(first.pendingChord, "g")
  const top = await buffer.press("g")
  assert.equal(top.mode, "visual")
  assert.deepEqual(top.selection, { kind: "line", anchor: 2, cursor: 0 })

  await buffer.press("G")
  assert.deepEqual(buffer.visualSelection, { kind: "line", anchor: 2, cursor: 4 })
})

test("visual y copies the selection and Visual Line keeps whole lines", async () => {
  const chars = controller("one two", 0)
  await chars.buffer.press("v")
  await chars.buffer.press("e")
  const yanked = await chars.buffer.press("y")
  assert.equal(yanked.mode, "normal")
  assert.deepEqual(chars.clipboard.written, ["one"])
  assert.deepEqual(chars.buffer.registerState, { text: "one", linewise: false })
  assert.deepEqual(chars.messages.at(-1), { text: "Yanked to clipboard", tone: "success" })

  const lines = controller("a\nb", 0)
  await lines.buffer.press("V")
  await lines.buffer.press("y")
  assert.deepEqual(lines.clipboard.written, ["a\n"])
  assert.deepEqual(lines.buffer.registerState, { text: "a\n", linewise: true })

  await lines.buffer.press("p")
  assert.equal(lines.editor.text(), "a\na\nb", "a V-LINE yank pastes as whole lines")
})

test("visual d and x cut the selection, and c cuts then enters Insert", async () => {
  const cut = controller("one two", 0)
  await cut.buffer.press("v")
  await cut.buffer.press("e")
  const deleted = await cut.buffer.press("d")
  assert.equal(deleted.mode, "normal")
  assert.equal(cut.editor.text(), " two")
  assert.deepEqual(cut.clipboard.written, ["one"])
  assert.deepEqual(cut.buffer.registerState, { text: "one", linewise: false })

  const cutX = controller("one two", 0)
  await cutX.buffer.press("v")
  await cutX.buffer.press("e")
  await cutX.buffer.press("x")
  assert.equal(cutX.editor.text(), " two")

  const changed = controller("one two", 0)
  await changed.buffer.press("v")
  await changed.buffer.press("e")
  const insert = await changed.buffer.press("c")
  assert.equal(insert.mode, "insert")
  assert.equal(changed.editor.text(), " two")
  assert.equal(changed.editor.cursor(), 0)
  assert.deepEqual(changed.clipboard.written, ["one"])

  const lines = controller("a\nb\nc", 0)
  await lines.buffer.press("V")
  await lines.buffer.press("j")
  const lineCut = await lines.buffer.press("d")
  assert.equal(lineCut.mode, "normal")
  assert.equal(lines.editor.text(), "c")
  assert.deepEqual(lines.buffer.registerState, { text: "a\nb\n", linewise: true })
})

test("visual p/P replace the selection with the clipboard text", async () => {
  const chars = controller("one two", 0)
  chars.clipboard.readValue = "XX"
  await chars.buffer.press("v")
  await chars.buffer.press("e")
  const pasted = await chars.buffer.press("p")
  assert.equal(pasted.mode, "normal")
  assert.equal(chars.editor.text(), "XX two")
  assert.equal(chars.buffer.visualSelection, null)

  const lines = controller("a\nb\nc", 0)
  lines.clipboard.readValue = "X\n"
  await lines.buffer.press("V")
  await lines.buffer.press("j")
  const linePaste = await lines.buffer.press("P")
  assert.equal(linePaste.mode, "normal")
  assert.equal(lines.editor.text(), "X\nc", "linewise paste replaces whole lines")
})

test("a visual paste is discarded when another key intervenes", async () => {
  const { editor, clipboard, buffer } = controller("one two", 0)
  await buffer.press("v")
  await buffer.press("e")
  let resolveRead: ((value: string | null) => void) | undefined
  clipboard.readImpl = () => new Promise((resolve) => { resolveRead = resolve })
  const pending = buffer.press("p")
  await buffer.press("l")
  resolveRead?.("SHOULD NOT PASTE")
  await pending
  assert.equal(editor.text(), "one two")
  assert.deepEqual(buffer.visualSelection, { kind: "char", anchor: 0, cursor: 3 })
})
