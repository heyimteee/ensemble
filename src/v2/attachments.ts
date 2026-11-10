import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Id, MessageAttachment } from "./types.ts"

/**
 * Composer attachments (ticket #223).
 *
 * Files are copied into a bounded per-conversation directory under the
 * workspace `.ensemble` area. Durable rows, patches, snapshots, and logs carry
 * a small metadata descriptor only. Bytes and absolute store paths stay in
 * this module and in the prompt payload the host receives.
 *
 * Terminal support for binary clipboard images is host-dependent: bracketed
 * paste carries bytes plus an optional `mimeType`/`kind` metadata hint. The
 * composer handles it when present and documents the fallback.
 */

export const ATTACHMENT_DIRECTORY = ".ensemble/attachments"
export const ATTACHMENT_INDEX_FILE = "index.json"

export const ATTACHMENT_MAX_FILE_BYTES = 10 * 1024 * 1024
export const ATTACHMENT_MAX_FILES_PER_MESSAGE = 8
export const ATTACHMENT_MAX_MESSAGE_BYTES = 25 * 1024 * 1024
export const ATTACHMENT_MAX_CONVERSATION_BYTES = 250 * 1024 * 1024

export type AttachmentLimits = {
  maxFileBytes: number
  maxFilesPerMessage: number
  maxMessageBytes: number
  maxConversationBytes: number
}

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  maxFileBytes: ATTACHMENT_MAX_FILE_BYTES,
  maxFilesPerMessage: ATTACHMENT_MAX_FILES_PER_MESSAGE,
  maxMessageBytes: ATTACHMENT_MAX_MESSAGE_BYTES,
  maxConversationBytes: ATTACHMENT_MAX_CONVERSATION_BYTES,
}

export type AttachmentFailureCode =
  | "too_many"
  | "too_large"
  | "message_too_large"
  | "storage_full"
  | "not_found"
  | "not_file"
  | "missing"
  | "invalid"

export type AttachmentFailure = { code: AttachmentFailureCode; message: string }

export function attachmentError(code: AttachmentFailureCode, message: string): Error & { code: AttachmentFailureCode } {
  return Object.assign(new Error(message), { code })
}

export function formatAttachmentSize(bytes: number): string {
  const value = Math.max(0, Number(bytes) || 0)
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  avif: "image/avif",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  log: "text/plain",
  json: "application/json",
  jsonl: "application/json",
  csv: "text/csv",
  ts: "text/plain",
  tsx: "text/plain",
  js: "text/plain",
  jsx: "text/plain",
  css: "text/plain",
  html: "text/html",
  yml: "text/yaml",
  yaml: "text/yaml",
  toml: "text/plain",
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
}

/** A small, deliberately conservative magic-byte sniff for pasted images. */
export function sniffImageMime(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes || bytes.length < 4) return undefined
  const b = bytes
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png"
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif"
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp"
  if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp"
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf"
  return undefined
}

export function mimeForAttachment(name: string, bytes?: Uint8Array, declared?: string): string {
  const sniffed = sniffImageMime(bytes)
  if (sniffed) return sniffed
  const extension = extname(name).replace(/^\./, "").toLowerCase()
  return MIME_BY_EXTENSION[extension] ?? (declared && declared.includes("/") ? declared : "application/octet-stream")
}

export function attachmentKind(mime: string): "file" | "image" {
  return mime.startsWith("image/") ? "image" : "file"
}

export function composerAttachmentLabel(attachment: Pick<MessageAttachment, "name" | "mime" | "size">): string {
  return `${attachment.name} · ${attachment.mime} · ${formatAttachmentSize(attachment.size)}`
}

/** A host prompt file as observed in `session.inbox.enqueued` (ADR 0010). */
export type NativePromptFile = {
  name?: string
  mime?: string
  dataLength?: number
  bytes?: number
  size?: number
  description?: string
  uri?: string
  data?: string
}

/**
 * Mirror host prompt files as transcript metadata. This is the contract
 * ingestion tickets (#215/#216) use: name, MIME, and size only; never the
 * host uri, inline data, or the original path.
 */
export function nativePromptAttachments(files: readonly NativePromptFile[] | undefined): MessageAttachment[] {
  if (!Array.isArray(files)) return []
  const chips: MessageAttachment[] = []
  for (const [index, file] of files.entries()) {
    const name = safeDisplayName(file?.name) || `attachment-${index + 1}`
    const size = Math.max(0, Number(file?.dataLength ?? file?.bytes ?? file?.size ?? 0) || 0)
    const mime = String(file?.mime ?? "").includes("/") ? String(file.mime) : mimeForAttachment(name)
    chips.push({ id: `att_prompt_${index}`, name, mime, size, kind: attachmentKind(mime) })
  }
  return chips
}

function safeDisplayName(name: string | undefined): string {
  const value = String(name ?? "").replace(/\\/g, "/").split("/").pop()?.trim() ?? ""
  return value && value !== "." && value !== ".." ? value.slice(0, 200) : ""
}

function safeFileName(name: string): string {
  const base = safeDisplayName(name) || "attachment"
  return base.replace(/[\u0000-\u001f/\\:*?"<>|]/g, "_").slice(0, 180) || "attachment"
}

function safeConversationSegment(key: string): string {
  return String(key).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "conversation"
}

export function attachmentConversationKey(input: { workspaceID?: Id; agentID?: Id; bindingKey?: Id }): string {
  if (input.agentID) {
    if (input.workspaceID && input.bindingKey === input.workspaceID) return `direct:${input.agentID}:${input.workspaceID}`
    return `direct:${input.agentID}`
  }
  if (input.workspaceID) return `group:${input.workspaceID}`
  return "group:unknown"
}

export function attachmentDirectory(directory: string, conversationKey: string): string {
  return join(directory, ATTACHMENT_DIRECTORY, safeConversationSegment(conversationKey))
}

function attachmentIndexPath(directory: string, conversationKey: string): string {
  return join(attachmentDirectory(directory, conversationKey), ATTACHMENT_INDEX_FILE)
}

export type StoredAttachment = {
  attachment: MessageAttachment
  /** Absolute store path: service-only, never persisted in a message or log. */
  path: string
}

export type StoreAttachmentInput = {
  directory: string
  conversationKey: string
  sourcePath?: string
  bytes?: Uint8Array
  name?: string
  mime?: string
  id?: Id
  limits?: Partial<AttachmentLimits>
}

function effectiveLimits(limits?: Partial<AttachmentLimits>): AttachmentLimits {
  return { ...DEFAULT_ATTACHMENT_LIMITS, ...(limits ?? {}) }
}

export function conversationAttachmentBytes(directory: string, conversationKey: string): number {
  const root = attachmentDirectory(directory, conversationKey)
  if (!existsSync(root)) return 0
  let total = 0
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === ATTACHMENT_INDEX_FILE) continue
    try {
      total += statSync(join(root, entry.name)).size
    } catch {}
  }
  return total
}

function readIndex(directory: string, conversationKey: string): MessageAttachment[] {
  const path = attachmentIndexPath(directory, conversationKey)
  if (!existsSync(path)) return []
  try {
    const value = JSON.parse(readFileSync(path, "utf8"))
    if (!Array.isArray(value)) return []
    return value.filter((item): item is MessageAttachment =>
      Boolean(item)
      && typeof item.id === "string"
      && typeof item.name === "string"
      && typeof item.mime === "string"
      && typeof item.size === "number"
      && (item.kind === "file" || item.kind === "image"),
    )
  } catch {
    return []
  }
}

function writeIndex(directory: string, conversationKey: string, attachments: MessageAttachment[]): void {
  const root = attachmentDirectory(directory, conversationKey)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, ATTACHMENT_INDEX_FILE), `${JSON.stringify(attachments)}\n`, { mode: 0o600 })
}

export function listStoredAttachments(directory: string, conversationKey: string): MessageAttachment[] {
  return readIndex(directory, conversationKey)
}

export function storeAttachment(input: StoreAttachmentInput): StoredAttachment {
  const limits = effectiveLimits(input.limits)
  const directory = input.directory
  const conversationKey = input.conversationKey
  let data: Buffer
  let name: string
  let declaredMime: string | undefined
  if (input.bytes) {
    data = Buffer.from(input.bytes)
    name = safeDisplayName(input.name) || "attachment"
    declaredMime = input.mime
  } else if (input.sourcePath) {
    const source = resolveAttachmentPath(input.sourcePath, [input.directory, process.cwd()])
    if (!source) throw attachmentError("not_found", "That path does not name an existing file.")
    let stats
    try {
      stats = statSync(source)
    } catch {
      throw attachmentError("not_found", "That path does not name an existing file.")
    }
    if (!stats.isFile()) throw attachmentError("not_file", "Attachments must be files, not directories.")
    name = safeDisplayName(input.name) || basename(source)
    declaredMime = input.mime
    data = readFileSync(source)
  } else {
    throw attachmentError("invalid", "Paste a file path or a clipboard image to attach it.")
  }

  if (data.length === 0) throw attachmentError("invalid", `"${name}" is empty; attach a file with content.`)
  if (data.length > limits.maxFileBytes) {
    throw attachmentError(
      "too_large",
      `"${name}" is ${formatAttachmentSize(data.length)}. The limit is ${formatAttachmentSize(limits.maxFileBytes)} per file.`,
    )
  }
  const existingBytes = conversationAttachmentBytes(directory, conversationKey)
  if (existingBytes + data.length > limits.maxConversationBytes) {
    throw attachmentError(
      "storage_full",
      `This conversation's attachment storage is full (${formatAttachmentSize(limits.maxConversationBytes)}). Remove attachments from the draft or start a new conversation.`,
    )
  }

  const mime = mimeForAttachment(name, data, declaredMime)
  const attachment: MessageAttachment = {
    id: input.id ?? `att_${randomUUID()}`,
    name: safeDisplayName(name) || "attachment",
    mime,
    size: data.length,
    kind: attachmentKind(mime),
  }
  const root = attachmentDirectory(directory, conversationKey)
  mkdirSync(root, { recursive: true })
  const path = join(root, `${attachment.id}-${safeFileName(attachment.name)}`)
  writeFileSync(path, data, { mode: 0o600 })
  writeIndex(directory, conversationKey, [...readIndex(directory, conversationKey).filter((item) => item.id !== attachment.id), attachment])
  return { attachment, path }
}

export function removeStoredAttachment(directory: string, conversationKey: string, attachmentID: string): boolean {
  const root = attachmentDirectory(directory, conversationKey)
  const existing = readIndex(directory, conversationKey)
  const found = existing.find((item) => item.id === attachmentID)
  if (!found) return false
  writeIndex(directory, conversationKey, existing.filter((item) => item.id !== attachmentID))
  if (existsSync(root)) {
    for (const entry of readdirSync(root)) {
      if (entry.startsWith(`${attachmentID}-`)) {
        try { unlinkSync(join(root, entry)) } catch {}
      }
    }
  }
  return true
}

export function resolveAttachments(
  directory: string,
  conversationKey: string,
  ids: readonly string[],
  limits?: Partial<AttachmentLimits>,
): MessageAttachment[] {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return []
  const stored = new Map(readIndex(directory, conversationKey).map((attachment) => [attachment.id, attachment]))
  const resolved: MessageAttachment[] = []
  for (const id of unique) {
    const attachment = stored.get(id)
    if (!attachment) {
      throw attachmentError("missing", `An attachment is no longer available (${id}). Remove it and paste it again.`)
    }
    resolved.push(attachment)
  }
  const failure = validateAttachmentSelection(resolved, limits)
  if (failure) throw attachmentError(failure.code, failure.message)
  return resolved
}

export function attachmentPathFor(directory: string, conversationKey: string, attachment: MessageAttachment): string {
  const direct = join(attachmentDirectory(directory, conversationKey), `${attachment.id}-${safeFileName(attachment.name)}`)
  if (existsSync(direct)) return direct
  const root = attachmentDirectory(directory, conversationKey)
  if (existsSync(root)) {
    for (const entry of readdirSync(root)) {
      if (entry.startsWith(`${attachment.id}-`)) return join(root, entry)
    }
  }
  throw attachmentError(
    "missing",
    `"${attachment.name}" is no longer available. Remove it from the draft and paste it again.`,
  )
}

export type PromptFile = { uri: string; name: string; description?: string }

/** Host-facing prompt files: a file URI plus display metadata, no inline data. */
export function promptFilesForAttachments(
  directory: string,
  conversationKey: string,
  attachments: readonly MessageAttachment[] | undefined,
): PromptFile[] {
  if (!attachments || attachments.length === 0) return []
  return attachments.map((attachment) => {
    const path = attachmentPathFor(directory, conversationKey, attachment)
    return {
      uri: pathToFileURL(path).href,
      name: attachment.name,
      description: `${attachment.mime}, ${formatAttachmentSize(attachment.size)}`,
    }
  })
}

export function validateAttachmentSelection(
  attachments: readonly MessageAttachment[],
  limits?: Partial<AttachmentLimits>,
): AttachmentFailure | undefined {
  const effective = effectiveLimits(limits)
  if (attachments.length > effective.maxFilesPerMessage) {
    return {
      code: "too_many",
      message: `Up to ${effective.maxFilesPerMessage} files per message. Remove one before adding another.`,
    }
  }
  let total = 0
  for (const attachment of attachments) {
    if (attachment.size > effective.maxFileBytes) {
      return {
        code: "too_large",
        message: `"${attachment.name}" is ${formatAttachmentSize(attachment.size)}. The limit is ${formatAttachmentSize(effective.maxFileBytes)} per file.`,
      }
    }
    total += attachment.size
  }
  if (total > effective.maxMessageBytes) {
    return {
      code: "message_too_large",
      message: `Attachments total ${formatAttachmentSize(total)}. The limit is ${formatAttachmentSize(effective.maxMessageBytes)} per message.`,
    }
  }
  return undefined
}

/** One clipped, quoted, or unquoted paste value; undefined for prose and URLs. */
export function pastedAttachmentPath(text: string | undefined): string | undefined {
  const raw = String(text ?? "").trim()
  if (!raw || raw.length > 4096) return undefined
  if (raw.includes("\n") || raw.includes("\r")) return undefined
  let value = raw
  let quoted = false
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    quoted = true
    value = value.slice(1, -1)
  } else if (value.startsWith("`") && value.endsWith("`")) {
    quoted = true
    value = value.slice(1, -1)
  }
  value = value.replace(/\\ /g, " ").trim()
  if (!quoted && /\s/.test(value)) return undefined
  if (/^(https?|mailto|data|ssh|git):/i.test(value)) return undefined
  if (value.startsWith("file://")) {
    try {
      return fileURLToPath(value)
    } catch {
      return undefined
    }
  }
  if (!isPathLike(value)) return undefined
  return value
}

function isPathLike(value: string): boolean {
  if (!value || value === "." || value === "..") return false
  if (value.startsWith("/") || value.startsWith("~") || value.startsWith("./") || value.startsWith("../")) return true
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  if (value.includes("/") || value.includes(sep)) return true
  return /\.[A-Za-z0-9]{1,8}$/.test(value)
}

export function resolveAttachmentPath(value: string, directories: readonly string[]): string | undefined {
  const expanded = value.startsWith("~") ? join(homedir(), value.slice(1)) : value
  const candidates = isAbsolute(expanded) ? [expanded] : directories.filter(Boolean).map((directory) => resolve(directory, expanded))
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return undefined
}

/** Display metadata for a local file before the service copies it. */
export function describeLocalAttachment(path: string): MessageAttachment {
  const stats = statSync(path)
  const name = safeDisplayName(basename(path)) || "attachment"
  const mime = mimeForAttachment(name)
  return { id: "pending", name, mime, size: stats.size, kind: attachmentKind(mime) }
}

/** Resolve a pasted path against the conversation directory first. */
export function existingPastedFile(text: string | undefined, directories: readonly string[]): string | undefined {
  const candidate = pastedAttachmentPath(text)
  if (candidate) return resolveAttachmentPath(candidate, directories)
  // File managers copy a raw absolute path even when it contains spaces, so a
  // single unquoted path-shaped line gets one existence check before the
  // composer falls back to inserting text.
  const raw = String(text ?? "").trim()
  if (!raw || raw.length > 4096 || raw.includes("\n") || raw.includes("\r")) return undefined
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^(https?|mailto|data|ssh|git):/i.test(raw)) return undefined
  if (!raw.includes("/") && !raw.includes("\\")) return undefined
  return resolveAttachmentPath(raw, directories)
}

export type ComposerPaste =
  | { kind: "image"; bytes: Uint8Array; mime: string; name?: string }
  | { kind: "path"; path: string }
  | { kind: "text" }

export type ComposerPasteInput = {
  text?: string
  bytes?: Uint8Array
  mimeType?: string
  kind?: "text" | "binary" | "unknown"
}

function imageExtension(mime: string): string {
  switch (mime) {
    case "image/png": return "png"
    case "image/jpeg": return "jpg"
    case "image/gif": return "gif"
    case "image/webp": return "webp"
    case "image/bmp": return "bmp"
    case "image/svg+xml": return "svg"
    default: return "png"
  }
}

/** Decode a base64 image data URI without persisting the payload. */
export function imageFromDataUri(text: string | undefined): { bytes: Uint8Array; mime: string } | undefined {
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(text ?? "").trim())
  if (!match) return undefined
  try {
    const bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64")
    if (bytes.length === 0) return undefined
    return { bytes: new Uint8Array(bytes), mime: match[1] }
  } catch {
    return undefined
  }
}

export function clipboardImageName(mime: string, at = Date.now()): string {
  return `pasted-image-${new Date(at).toISOString().replace(/[:.]/g, "-")}.${imageExtension(mime)}`
}

export function classifyComposerPaste(input: ComposerPasteInput): ComposerPaste {
  const bytes = input.bytes && input.bytes.length > 0 ? input.bytes : undefined
  if (bytes) {
    const sniffed = sniffImageMime(bytes)
    const declared = String(input.mimeType ?? "")
    if (sniffed || (input.kind === "binary" && declared.startsWith("image/"))) {
      return { kind: "image", bytes, mime: sniffed ?? declared, name: clipboardImageName(sniffed ?? declared) }
    }
    return { kind: "text" }
  }
  const dataUri = imageFromDataUri(input.text)
  if (dataUri) return { kind: "image", bytes: dataUri.bytes, mime: dataUri.mime, name: clipboardImageName(dataUri.mime) }
  const path = pastedAttachmentPath(input.text)
  if (path) return { kind: "path", path }
  // A raw path with spaces is a candidate; the composer resolves existence
  // against the active conversation before deciding to insert text.
  const raw = String(input.text ?? "").trim()
  if (raw && raw.length <= 4096 && !raw.includes("\n") && !raw.includes("\r") && (/[\\/]/.test(raw) || raw.startsWith("~"))) {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^(https?|mailto|data|ssh|git):/i.test(raw)) return { kind: "path", path: raw }
  }
  return { kind: "text" }
}

/** Per-conversation composer drafts; attachments never leak across surfaces. */
export type ComposerAttachmentStore = Record<string, MessageAttachment[]>

export function withComposerAttachment(
  store: ComposerAttachmentStore,
  key: string,
  attachment: MessageAttachment,
): ComposerAttachmentStore {
  const existing = store[key] ?? []
  if (existing.some((item) => item.id === attachment.id)) return store
  return { ...store, [key]: [...existing, attachment] }
}

export function removeComposerAttachment(
  store: ComposerAttachmentStore,
  key: string,
  attachmentID: string,
): ComposerAttachmentStore {
  const existing = store[key]
  if (!existing) return store
  const next = existing.filter((item) => item.id !== attachmentID)
  if (next.length === 0) {
    const { [key]: _removed, ...rest } = store
    return rest
  }
  return { ...store, [key]: next }
}

export function clearComposerAttachments(store: ComposerAttachmentStore, key: string): ComposerAttachmentStore {
  if (!store[key]) return store
  const { [key]: _removed, ...rest } = store
  return rest
}

export function attachmentsForDraft(store: ComposerAttachmentStore, key: string): MessageAttachment[] {
  return store[key] ?? []
}

export function cleanupConversationAttachments(directory: string, conversationKey: string): void {
  try {
    rmSync(attachmentDirectory(directory, conversationKey), { recursive: true, force: true })
  } catch {}
}

/** Conversation cleanup at workspace deletion/reset. */
export function cleanupWorkspaceAttachments(directory: string): void {
  try {
    rmSync(join(directory, ATTACHMENT_DIRECTORY), { recursive: true, force: true })
  } catch {}
}
