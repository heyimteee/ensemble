/**
 * Vim text editing subset (ticket #85).
 *
 * Pure motion, operator, insert, yank, and paste math over a plain string and
 * a cursor offset. The controller below the calculators uses injected editor
 * and clipboard ports, so tests never render OpenTUI; the OpenTUI adapter in
 * `vim-opentui.ts` stays thin.
 *
 * No counts, text objects, macros, marks, or extra registers: only the v5.6
 * Normal grammar from spec #78. Visual mode is ticket #86 and extends these
 * primitives.
 */

export type VimMotion = "h" | "l" | "j" | "k" | "w" | "b" | "e" | "0" | "^" | "$" | "gg" | "G"

export type VimInsertWhere = "before" | "after" | "lineStart" | "lineEnd" | "lineBelow" | "lineAbove"

export type VimCommand =
  | { type: "motion"; motion: VimMotion }
  | { type: "insert"; where: VimInsertWhere }
  | { type: "x" }
  | { type: "D" }
  | { type: "delete.motion"; motion: VimMotion }
  | { type: "delete.line" }
  | { type: "yank.line" }
  | { type: "paste"; before: boolean }
  | { type: "undo" }
  | { type: "redo" }

export type VimPending = "" | "d" | "y" | "g" | "dg"

export type VimKeyResolution =
  | { type: "pending"; pending: Exclude<VimPending, ""> }
  | { type: "command"; command: VimCommand }
  | { type: "cancel" }
  | { type: "unhandled" }

export type VimRegister = { text: string; linewise: boolean }

/** One logical line. `end` excludes the newline; `next` includes it. */
export type VimLine = { start: number; end: number; next: number }

const MOTIONS = new Set<VimMotion>(["h", "l", "j", "k", "w", "b", "e", "0", "^", "$", "gg", "G"])

export function isVimMotion(key: string): key is VimMotion {
  return MOTIONS.has(key as VimMotion)
}

/**
 * Normalize a raw key event to the token the grammar understands. OpenTUI
 * reports Shift+G as `{ name: "g", shift: true }`, so uppercase text keys must
 * be reconstructed; punctuation such as `$` arrives as its own name.
 */
export function normalizeVimKey(input: { name?: string; ctrl?: boolean; shift?: boolean }): string | null {
  const name = String(input?.name ?? "")
  if (!name) return null
  if (input?.ctrl) return `ctrl+${name.toLowerCase()}`
  if (name.length === 1 && name >= "a" && name <= "z") return input?.shift ? name.toUpperCase() : name
  return name
}

/** Resolve one Normal key against the pending operator/prefix. */
export function resolveVimKey(pending: VimPending, key: string): VimKeyResolution {
  if (pending === "d") {
    if (key === "d") return { type: "command", command: { type: "delete.line" } }
    if (key === "g") return { type: "pending", pending: "dg" }
    if (isVimMotion(key)) return { type: "command", command: { type: "delete.motion", motion: key } }
    return { type: "cancel" }
  }
  if (pending === "dg") {
    if (key === "g") return { type: "command", command: { type: "delete.motion", motion: "gg" } }
    return { type: "cancel" }
  }
  if (pending === "y") {
    if (key === "y") return { type: "command", command: { type: "yank.line" } }
    return { type: "cancel" }
  }
  if (pending === "g") {
    if (key === "g") return { type: "command", command: { type: "motion", motion: "gg" } }
    return { type: "cancel" }
  }

  switch (key) {
    case "h":
    case "l":
    case "j":
    case "k":
    case "w":
    case "b":
    case "e":
    case "0":
    case "^":
    case "$":
    case "G":
      return { type: "command", command: { type: "motion", motion: key } }
    case "i":
      return { type: "command", command: { type: "insert", where: "before" } }
    case "a":
      return { type: "command", command: { type: "insert", where: "after" } }
    case "I":
      return { type: "command", command: { type: "insert", where: "lineStart" } }
    case "A":
      return { type: "command", command: { type: "insert", where: "lineEnd" } }
    case "o":
      return { type: "command", command: { type: "insert", where: "lineBelow" } }
    case "O":
      return { type: "command", command: { type: "insert", where: "lineAbove" } }
    case "x":
      return { type: "command", command: { type: "x" } }
    case "D":
      return { type: "command", command: { type: "D" } }
    case "d":
      return { type: "pending", pending: "d" }
    case "y":
      return { type: "pending", pending: "y" }
    case "g":
      return { type: "pending", pending: "g" }
    case "p":
      return { type: "command", command: { type: "paste", before: false } }
    case "P":
      return { type: "command", command: { type: "paste", before: true } }
    case "u":
      return { type: "command", command: { type: "undo" } }
    case "ctrl+r":
      return { type: "command", command: { type: "redo" } }
    default:
      return { type: "unhandled" }
  }
}

/** Split text into logical lines. A trailing newline yields a final empty line. */
export function vimLines(text: string): VimLine[] {
  const lines: VimLine[] = []
  let start = 0
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "\n") continue
    lines.push({ start, end: index, next: index + 1 })
    start = index + 1
  }
  lines.push({ start, end: text.length, next: text.length })
  return lines
}

/** The line containing an offset. An offset on a newline belongs to that line. */
export function vimLineAt(text: string, offset: number): VimLine {
  const lines = vimLines(text)
  const target = Math.max(0, Math.min(text.length, Math.trunc(offset)))
  for (const line of lines) if (target <= line.end) return line
  return lines[lines.length - 1]
}

export function vimLineIndexAt(text: string, offset: number): number {
  const lines = vimLines(text)
  const target = Math.max(0, Math.min(text.length, Math.trunc(offset)))
  for (let index = 0; index < lines.length; index++) if (target <= lines[index].end) return index
  return lines.length - 1
}

function lineLength(line: VimLine): number {
  return line.end - line.start
}

function lineLastChar(line: VimLine): number {
  return lineLength(line) > 0 ? line.end - 1 : line.start
}

function firstNonBlank(text: string, line: VimLine): number {
  let offset = line.start
  while (offset < line.end && (text[offset] === " " || text[offset] === "\t")) offset++
  return offset < line.end ? offset : line.start
}

/**
 * Normal-mode cursor rule: the cursor sits on a character. An offset that
 * points at a newline snaps to the previous character; an empty line keeps its
 * own start so the trailing empty line after a final newline is addressable.
 */
export function clampVimCursor(text: string, offset: number): number {
  const target = Math.max(0, Math.min(text.length, Math.trunc(offset)))
  const line = vimLineAt(text, target)
  if (lineLength(line) === 0) return line.start
  return Math.min(target, line.end - 1)
}

function charClass(char: string): "word" | "punct" {
  return /[A-Za-z0-9_]/.test(char) ? "word" : "punct"
}

function isSpace(char: string | undefined): boolean {
  return char === undefined || char === " " || char === "\t" || char === "\n"
}

/** Raw motion boundary; may be `text.length` or the start of a later line. */
function rawMotionTarget(text: string, cursor: number, motion: VimMotion, preferredColumn?: number): number {
  const at = clampVimCursor(text, cursor)
  const line = vimLineAt(text, at)
  switch (motion) {
    case "h":
      return at > line.start ? at - 1 : at
    case "l":
      return at < lineLastChar(line) ? at + 1 : at
    case "0":
      return line.start
    case "^":
      return firstNonBlank(text, line)
    case "$":
      return lineLastChar(line)
    case "j":
    case "k": {
      const lines = vimLines(text)
      const row = vimLineIndexAt(text, at)
      const targetRow = motion === "j" ? row + 1 : row - 1
      if (targetRow < 0 || targetRow >= lines.length) return at
      const targetLine = lines[targetRow]
      const column = preferredColumn ?? at - line.start
      return Math.min(targetLine.start + column, lineLastChar(targetLine))
    }
    case "gg":
      return 0
    case "G": {
      const lines = vimLines(text)
      return lines[lines.length - 1].start
    }
    case "w": {
      let offset = at
      if (offset < text.length && !isSpace(text[offset])) {
        const kind = charClass(text[offset])
        while (offset < text.length && !isSpace(text[offset]) && charClass(text[offset]) === kind) offset++
      }
      while (offset < text.length && isSpace(text[offset])) offset++
      return offset
    }
    case "b": {
      let offset = at
      if (offset > 0) offset--
      while (offset > 0 && isSpace(text[offset])) offset--
      if (offset < text.length && !isSpace(text[offset])) {
        const kind = charClass(text[offset])
        while (offset > 0 && !isSpace(text[offset - 1]) && charClass(text[offset - 1]) === kind) offset--
      }
      return offset
    }
    case "e": {
      let offset = at
      if (offset < text.length && !isSpace(text[offset])) {
        const kind = charClass(text[offset])
        let next = offset + 1
        if (next < text.length && !isSpace(text[next]) && charClass(text[next]) === kind) {
          while (next < text.length && !isSpace(text[next]) && charClass(text[next]) === kind) next++
          return next - 1
        }
        while (next < text.length && isSpace(text[next])) next++
        if (next >= text.length) return offset
        const nextKind = charClass(text[next])
        while (next < text.length && !isSpace(text[next]) && charClass(text[next]) === nextKind) next++
        return next - 1
      }
      while (offset < text.length && isSpace(text[offset])) offset++
      if (offset >= text.length) return at
      const kind = charClass(text[offset])
      while (offset < text.length && !isSpace(text[offset]) && charClass(text[offset]) === kind) offset++
      return offset - 1
    }
  }
}

/** Cursor position after a navigation motion. */
export function motionTarget(
  text: string,
  cursor: number,
  motion: VimMotion,
  preferredColumn?: number,
): number {
  return clampVimCursor(text, rawMotionTarget(text, cursor, motion, preferredColumn))
}

export type VimInsertPlan = { insertAt: number; text: string; cursor: number }

export function insertEntry(text: string, cursor: number, where: VimInsertWhere): VimInsertPlan {
  const at = clampVimCursor(text, cursor)
  const line = vimLineAt(text, at)
  switch (where) {
    case "before":
      return { insertAt: at, text: "", cursor: at }
    case "after": {
      const insertAt = lineLength(line) === 0 ? line.start : Math.min(at + 1, line.end)
      return { insertAt, text: "", cursor: insertAt }
    }
    case "lineStart": {
      const insertAt = firstNonBlank(text, line)
      return { insertAt, text: "", cursor: insertAt }
    }
    case "lineEnd":
      return { insertAt: line.end, text: "", cursor: line.end }
    case "lineBelow":
      return { insertAt: line.end, text: "\n", cursor: line.end + 1 }
    case "lineAbove":
      return { insertAt: line.start, text: "\n", cursor: line.start }
  }
}

export type VimCutPlan = {
  start: number
  end: number
  linewise: boolean
  register: string
  cursor: number
}

function linewisePlan(text: string, startLine: number, endLine: number, cursor: number): VimCutPlan | null {
  const lines = vimLines(text)
  if (startLine < 0 || endLine >= lines.length || startLine > endLine) return null
  const start = lines[startLine].start
  const end = lines[endLine].next
  if (end <= start) return null
  const raw = text.slice(start, end)
  return {
    start,
    end,
    linewise: true,
    register: raw.endsWith("\n") ? raw : `${raw}\n`,
    cursor,
  }
}

/**
 * The delete/cut range for `x`, `D`, `dd`, or `d` plus a motion. Deletes are
 * cuts: the returned register text is what goes to the clipboard.
 */
export function deletePlan(
  text: string,
  cursor: number,
  command: { type: "x" } | { type: "D" } | { type: "delete.line" } | { type: "delete.motion"; motion: VimMotion },
): VimCutPlan | null {
  const at = clampVimCursor(text, cursor)
  const line = vimLineAt(text, at)
  if (command.type === "x") {
    if (at >= line.end) return null
    return { start: at, end: at + 1, linewise: false, register: text.slice(at, at + 1), cursor: at }
  }
  if (command.type === "D") {
    if (at >= line.end) return null
    return { start: at, end: line.end, linewise: false, register: text.slice(at, line.end), cursor: at }
  }
  if (command.type === "delete.line") {
    return linewisePlan(text, vimLineIndexAt(text, at), vimLineIndexAt(text, at), line.start)
  }

  const motion = command.motion
  if (motion === "j" || motion === "k") {
    const row = vimLineIndexAt(text, at)
    const targetRow = motion === "j" ? row + 1 : row - 1
    const startRow = Math.min(row, targetRow)
    const endRow = Math.max(row, targetRow)
    if (targetRow < 0 || targetRow >= vimLines(text).length) return null
    return linewisePlan(text, startRow, endRow, vimLines(text)[startRow].start)
  }
  if (motion === "gg") {
    return linewisePlan(text, 0, vimLineIndexAt(text, at), 0)
  }
  if (motion === "G") {
    const row = vimLineIndexAt(text, at)
    return linewisePlan(text, row, vimLines(text).length - 1, vimLines(text)[row].start)
  }

  const target = rawMotionTarget(text, at, motion)
  let start = at
  let end = target
  if (motion === "h") {
    start = at - 1
    end = at
    if (at <= line.start) return null
  } else if (motion === "l") {
    start = at
    end = at + 1
    if (at >= line.end) return null
  } else if (motion === "e") {
    start = at
    end = target + 1
    if (target < at) return null
  } else if (motion === "b" || motion === "0" || motion === "^") {
    start = target
    end = at
    if (target >= at) return null
  } else if (motion === "$") {
    start = at
    end = line.end
    if (at >= line.end) return null
  } else {
    if (target <= at) return null
  }
  if (end <= start) return null
  return { start, end, linewise: false, register: text.slice(start, end), cursor: start }
}

/** `yy`: one whole line, always newline-terminated for linewise paste. */
export function yankLine(text: string, cursor: number): VimRegister {
  const line = vimLineAt(text, clampVimCursor(text, cursor))
  const raw = text.slice(line.start, line.next)
  return { text: raw.endsWith("\n") ? raw : `${raw}\n`, linewise: true }
}

export type VimPastePlan = {
  insertAt: number
  text: string
  linewise: boolean
  cursor: number
  result: string
}

/**
 * `p`/`P`: linewise registers paste below/above the current line; charwise
 * registers paste after/before the cursor.
 */
export function pastePlan(
  text: string,
  cursor: number,
  register: VimRegister,
  before: boolean,
): VimPastePlan | null {
  if (register.text === "") return null
  const at = clampVimCursor(text, cursor)
  const line = vimLineAt(text, at)
  if (register.linewise) {
    const content = register.text.endsWith("\n") ? register.text : `${register.text}\n`
    if (before) {
      const insertAt = line.start
      const result = `${text.slice(0, insertAt)}${content}${text.slice(insertAt)}`
      return { insertAt, text: content, linewise: true, cursor: insertAt, result }
    }
    if (line.next > line.end) {
      const insertAt = line.next
      const result = `${text.slice(0, insertAt)}${content}${text.slice(insertAt)}`
      return { insertAt, text: content, linewise: true, cursor: insertAt, result }
    }
    const insertAt = line.end
    const inserted = `\n${content}`
    const result = `${text.slice(0, insertAt)}${inserted}${text.slice(insertAt)}`
    return { insertAt, text: inserted, linewise: true, cursor: insertAt + 1, result }
  }
  const insertAt = before || lineLength(line) === 0 ? at : at + 1
  const result = `${text.slice(0, insertAt)}${register.text}${text.slice(insertAt)}`
  const cursorAfter = clampVimCursor(result, insertAt + register.text.length - 1)
  return { insertAt, text: register.text, linewise: false, cursor: cursorAfter, result }
}

/**
 * System clipboard text does not carry Vim's linewise bit. A trailing newline
 * means linewise; otherwise a matching internal register keeps its bit.
 */
export function registerFromClipboard(text: string, internal: VimRegister): VimRegister {
  return { text, linewise: text.endsWith("\n") || (internal.text === text && internal.linewise) }
}

export type VimEditorPort = {
  text(): string
  cursor(): number
  setCursor(offset: number): void
  replace(start: number, end: number, text: string): void
  undo(): void
  redo(): void
}

export type VimClipboardPort = {
  /** Resolves true when the system clipboard accepted the text. */
  write(text: string): Promise<boolean>
  /** Resolves null when the system clipboard is empty or unavailable. */
  read(): Promise<string | null>
}

export type VimMessage = { text: string; tone: "info" | "success" | "error" }

export type VimOutcome = {
  handled: boolean
  mode?: "insert"
  pendingChord?: string | null
  message?: VimMessage
}

export type VimRegisterStore = { current: VimRegister }

export function createVimRegisterStore(): VimRegisterStore {
  return { current: { text: "", linewise: false } }
}

/**
 * Normal-mode editing controller over injected ports. All buffer edits go
 * through `replace`/`setCursor`; the OpenTUI adapter maps those to native edit
 * APIs so undo history is preserved.
 */
export class VimBuffer {
  private pending: VimPending = ""
  private epoch = 0
  private preferredColumn: number | null = null
  private writes: Promise<void> = Promise.resolve()
  private lastWrite: { text: string; ok: boolean } | null = null
  private readonly editor: VimEditorPort
  private readonly clipboard: VimClipboardPort
  private readonly register: VimRegisterStore
  private readonly onMessage: (message: VimMessage) => void

  constructor(
    editor: VimEditorPort,
    clipboard: VimClipboardPort,
    register: VimRegisterStore = createVimRegisterStore(),
    onMessage: (message: VimMessage) => void = () => {},
  ) {
    this.editor = editor
    this.clipboard = clipboard
    this.register = register
    this.onMessage = onMessage
  }

  get pendingChord(): string | null {
    return this.pending === "" ? null : this.pending
  }

  get registerState(): VimRegister {
    return this.register.current
  }

  /** Called on focus or mode changes so an in-flight paste is discarded. */
  invalidate(): void {
    this.epoch++
    this.pending = ""
    this.preferredColumn = null
  }

  /** Put the cursor on a character; Insert mode may have left it on a newline. */
  normalizeCursor(): void {
    this.editor.setCursor(clampVimCursor(this.editor.text(), this.editor.cursor()))
  }

  /** Wait for clipboard writes scheduled by cuts and yanks (tests and teardown). */
  async settle(): Promise<void> {
    await this.writes
  }

  async press(key: string): Promise<VimOutcome> {
    const epoch = ++this.epoch
    const resolution = resolveVimKey(this.pending, key)
    if (resolution.type === "pending") {
      this.pending = resolution.pending
      return { handled: true, pendingChord: this.pending }
    }
    if (resolution.type === "cancel") {
      this.pending = ""
      return { handled: true, pendingChord: null }
    }
    if (resolution.type === "unhandled") {
      const wasPending = this.pending !== ""
      this.pending = ""
      return { handled: wasPending, pendingChord: null }
    }

    this.pending = ""
    return this.run(resolution.command, epoch)
  }

  private async run(command: VimCommand, epoch: number): Promise<VimOutcome> {
    const text = this.editor.text()
    const cursor = this.editor.cursor()
    switch (command.type) {
      case "motion": {
        if (command.motion === "j" || command.motion === "k") {
          const at = clampVimCursor(text, cursor)
          const column = at - vimLineAt(text, at).start
          const preferred = this.preferredColumn ?? column
          this.editor.setCursor(motionTarget(text, cursor, command.motion, preferred))
          this.preferredColumn = preferred
        } else {
          this.preferredColumn = null
          this.editor.setCursor(motionTarget(text, cursor, command.motion))
        }
        return { handled: true, pendingChord: null }
      }
      case "insert": {
        this.preferredColumn = null
        const plan = insertEntry(text, cursor, command.where)
        if (plan.text) this.editor.replace(plan.insertAt, plan.insertAt, plan.text)
        this.editor.setCursor(plan.cursor)
        return { handled: true, mode: "insert", pendingChord: null }
      }
      case "x":
      case "D":
      case "delete.line":
      case "delete.motion": {
        const plan = deletePlan(text, cursor, command)
        if (!plan) return { handled: true, pendingChord: null }
        this.preferredColumn = null
        this.editor.replace(plan.start, plan.end, "")
        this.editor.setCursor(clampVimCursor(this.editor.text(), plan.cursor))
        this.remember({ text: plan.register, linewise: plan.linewise })
        return {
          handled: true,
          pendingChord: null,
          message: await this.writeClipboard(plan.register, "Cut"),
        }
      }
      case "yank.line": {
        const register = yankLine(text, cursor)
        this.remember(register)
        return { handled: true, pendingChord: null, message: await this.writeClipboard(register.text, "Yanked") }
      }
      case "paste": {
        return this.paste(command.before, epoch)
      }
      case "undo":
        this.preferredColumn = null
        this.editor.undo()
        return { handled: true, pendingChord: null }
      case "redo":
        this.preferredColumn = null
        this.editor.redo()
        return { handled: true, pendingChord: null }
    }
  }

  private remember(register: VimRegister): void {
    this.register.current = register
  }

  /**
   * Write to the system clipboard and keep the internal register either way.
   * The promise is chained so overlapping cuts cannot report out of order.
   */
  private writeClipboard(text: string, verb: "Cut" | "Yanked"): Promise<VimMessage> {
    const message = this.clipboard
      .write(text)
      .then<boolean, boolean>((ok) => ok, () => false)
      .then((ok) => {
        this.lastWrite = { text, ok }
        return ok
          ? { text: `${verb} to clipboard`, tone: "success" as const }
          : { text: `${verb} internally — clipboard unavailable`, tone: "error" as const }
      })
    this.writes = this.writes.then(() => message.then(() => undefined, () => undefined))
    return message.then((value) => {
      this.onMessage(value)
      return value
    })
  }

  /**
   * Read the system clipboard first, fall back to the internal register, and
   * discard the paste if any later key, focus change, or buffer edit happened
   * while the read was in flight.
   */
  private async paste(before: boolean, epoch: number): Promise<VimOutcome> {
    const snapshot = this.editor.text()
    // A cut or yank from a moment ago may still be reaching the system
    // clipboard. Let that write settle so `p` immediately after `dd` cannot
    // read the previous clipboard contents.
    try {
      await this.writes
    } catch {}
    if (epoch !== this.epoch || this.editor.text() !== snapshot) return { handled: true, pendingChord: null }
    let system: string | null = null
    try {
      system = await this.clipboard.read()
    } catch {
      system = null
    }
    if (epoch !== this.epoch || this.editor.text() !== snapshot) return { handled: true, pendingChord: null }
    const internal = this.register.current
    let chosen = internal
    if (system && system.length > 0) {
      const failedWrite = this.lastWrite !== null && !this.lastWrite.ok
      if (!failedWrite || system === internal.text) chosen = registerFromClipboard(system, internal)
    }
    const plan = pastePlan(this.editor.text(), this.editor.cursor(), chosen, before)
    if (!plan) return { handled: true, pendingChord: null }
    this.preferredColumn = null
    this.editor.replace(plan.insertAt, plan.insertAt, plan.text)
    this.editor.setCursor(plan.cursor)
    return { handled: true, pendingChord: null }
  }
}
