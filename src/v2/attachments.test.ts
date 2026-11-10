import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  ATTACHMENT_MAX_FILES_PER_MESSAGE,
  ATTACHMENT_MAX_FILE_BYTES,
  attachmentsForDraft,
  clearComposerAttachments,
  classifyComposerPaste,
  cleanupConversationAttachments,
  cleanupWorkspaceAttachments,
  composerAttachmentLabel,
  conversationAttachmentBytes,
  existingPastedFile,
  nativePromptAttachments,
  pastedAttachmentPath,
  promptFilesForAttachments,
  removeComposerAttachment,
  resolveAttachments,
  storeAttachment,
  validateAttachmentSelection,
  withComposerAttachment,
} from "./attachments.ts"
import type { MessageAttachment } from "./types.ts"

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "ensemble-attachments-"))
}

function writeTempFile(directory: string, name: string, data: string | Buffer): string {
  const path = join(directory, name)
  writeFileSync(path, data)
  return path
}

test("a pasted path attaches only when it names an existing file", () => {
  const directory = tempWorkspace()
  const file = writeTempFile(directory, "notes.md", "hello")
  const spaced = writeTempFile(directory, "my notes.md", "hello")
  mkdirSync(join(directory, "folder"))

  assert.equal(pastedAttachmentPath(file), file)
  assert.equal(existingPastedFile(file, [directory]), file)
  assert.equal(existingPastedFile("notes.md", [directory]), file)
  assert.equal(existingPastedFile(`"${file}"`, [directory]), file)
  assert.equal(classifyComposerPaste({ text: spaced }).kind, "path", "a raw path with spaces is an attachment candidate")
  assert.equal(existingPastedFile(spaced, [directory]), spaced, "a raw path with spaces resolves when it exists")
  assert.equal(pastedAttachmentPath("hello there"), undefined)
  assert.equal(pastedAttachmentPath("https://example.com/notes.md"), undefined)
  assert.equal(existingPastedFile("missing.md", [directory]), undefined)
  assert.equal(existingPastedFile(join(directory, "folder"), [directory]), undefined)
})

test("a clipboard image is classified from bytes or a data uri", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
  const fromBytes = classifyComposerPaste({ bytes: png, kind: "binary", mimeType: "image/png" })
  assert.equal(fromBytes.kind, "image")
  if (fromBytes.kind === "image") {
    assert.equal(fromBytes.mime, "image/png")
    assert.deepEqual([...fromBytes.bytes], [...png])
  }

  const fromText = classifyComposerPaste({ text: `data:image/png;base64,${png.toString("base64")}` })
  assert.equal(fromText.kind, "image")
  if (fromText.kind === "image") assert.equal(fromText.bytes.length, png.length)

  assert.deepEqual(classifyComposerPaste({ text: "plain words" }), { kind: "text" })
})

test("stored attachments keep name, mime, and size and never the source path", () => {
  const directory = tempWorkspace()
  const source = writeTempFile(directory, "report.txt", "attachment body")
  const stored = storeAttachment({
    directory,
    conversationKey: "group:w",
    sourcePath: source,
    id: "att_one",
  })
  assert.equal(stored.attachment.id, "att_one")
  assert.equal(stored.attachment.name, "report.txt")
  assert.equal(stored.attachment.mime, "text/plain")
  assert.equal(stored.attachment.size, "attachment body".length)
  assert.equal(stored.attachment.kind, "file")
  assert.ok(stored.path.startsWith(join(directory, ".ensemble", "attachments")))
  assert.equal(readFileSync(stored.path, "utf8"), "attachment body")
  assert.equal("sourcePath" in stored.attachment, false)
  assert.equal(JSON.stringify(stored.attachment).includes(directory), false)
})

test("per-file and per-message caps reject with actionable errors", () => {
  const limits = {
    maxFileBytes: 8,
    maxFilesPerMessage: 2,
    maxMessageBytes: 12,
    maxConversationBytes: 1024,
  }
  const oversized = validateAttachmentSelection(
    [{ id: "a", name: "big.bin", mime: "application/octet-stream", size: 9, kind: "file" }],
    limits,
  )
  assert.match(oversized?.message ?? "", /big\.bin/)
  assert.match(oversized?.message ?? "", /limit is 8 B per file/)

  const tooMany = validateAttachmentSelection(
    [
      { id: "a", name: "a.txt", mime: "text/plain", size: 1, kind: "file" },
      { id: "b", name: "b.txt", mime: "text/plain", size: 1, kind: "file" },
      { id: "c", name: "c.txt", mime: "text/plain", size: 1, kind: "file" },
    ],
    limits,
  )
  assert.equal(tooMany?.code, "too_many")
  assert.match(tooMany?.message ?? "", /Up to 2 files per message/)

  const tooHeavy = validateAttachmentSelection(
    [
      { id: "a", name: "a.txt", mime: "text/plain", size: 8, kind: "file" },
      { id: "b", name: "b.txt", mime: "text/plain", size: 8, kind: "file" },
    ],
    limits,
  )
  assert.equal(tooHeavy?.code, "message_too_large")

  assert.equal(validateAttachmentSelection([], limits), undefined)
  assert.equal(
    validateAttachmentSelection([{ id: "a", name: "a.txt", mime: "text/plain", size: 1, kind: "file" }], undefined),
    undefined,
  )
})

test("a bounded conversation store rejects when it is full", () => {
  const directory = tempWorkspace()
  const limits = { maxFileBytes: 1024, maxFilesPerMessage: 8, maxMessageBytes: 1024, maxConversationBytes: 10 }
  storeAttachment({ directory, conversationKey: "group:w", bytes: Buffer.alloc(8), name: "a.bin", id: "att_a", limits })
  assert.throws(
    () => storeAttachment({ directory, conversationKey: "group:w", bytes: Buffer.alloc(8), name: "b.bin", id: "att_b", limits }),
    /storage is full/i,
  )
  assert.equal(conversationAttachmentBytes(directory, "group:w"), 8)
})

test("prompt files use file uris with name and description", () => {
  const directory = tempWorkspace()
  const stored = storeAttachment({
    directory,
    conversationKey: "group:w",
    bytes: Buffer.from("hello"),
    name: "notes.txt",
    id: "att_prompt",
  })
  const files = promptFilesForAttachments(directory, "group:w", [stored.attachment])
  assert.equal(files.length, 1)
  assert.equal(files[0].name, "notes.txt")
  assert.match(files[0].uri, /^file:\/\//)
  assert.equal(decodeURIComponent(new URL(files[0].uri).pathname), stored.path)
  assert.match(files[0].description ?? "", /text\/plain/)
  assert.match(files[0].description ?? "", /5 B/)
})

test("native prompt files mirror as metadata chips without uri or data", () => {
  const chips = nativePromptAttachments([
    { name: "probe.txt", mime: "text/plain", dataLength: 40, uri: "file:///private/tmp/probe.txt", data: "c2VjcmV0" },
  ])
  assert.deepEqual(chips.map(({ name, mime, size, kind }) => ({ name, mime, size, kind })), [
    { name: "probe.txt", mime: "text/plain", size: 40, kind: "file" },
  ])
  assert.equal(JSON.stringify(chips).includes("private"), false)
  assert.equal(JSON.stringify(chips).includes("c2VjcmV0"), false)
})

test("transcript labels show name, mime, and a readable size", () => {
  const attachment: MessageAttachment = { id: "att_a", name: "shot.png", mime: "image/png", size: 2048, kind: "image" }
  assert.match(composerAttachmentLabel(attachment), /shot\.png/)
  assert.match(composerAttachmentLabel(attachment), /image\/png/)
  assert.match(composerAttachmentLabel(attachment), /2\.0 KB/)
})

test("cleanup removes one conversation and leaves the others", () => {
  const directory = tempWorkspace()
  storeAttachment({ directory, conversationKey: "group:w", bytes: Buffer.from("one"), name: "a.txt", id: "att_a" })
  storeAttachment({ directory, conversationKey: "direct:a:w", bytes: Buffer.from("two"), name: "b.txt", id: "att_b" })
  assert.equal(conversationAttachmentBytes(directory, "group:w"), 3)
  assert.equal(conversationAttachmentBytes(directory, "direct:a:w"), 3)

  cleanupConversationAttachments(directory, "group:w")
  assert.equal(conversationAttachmentBytes(directory, "group:w"), 0)
  assert.equal(conversationAttachmentBytes(directory, "direct:a:w"), 3)
  assert.equal(existsSync(join(directory, ".ensemble", "attachments")), true)

  cleanupWorkspaceAttachments(directory)
  assert.equal(existsSync(join(directory, ".ensemble", "attachments")), false)
})

test("resolving attachment ids re-reads durable metadata and rejects unknown ids", () => {
  const directory = tempWorkspace()
  const stored = storeAttachment({ directory, conversationKey: "group:w", bytes: Buffer.from("x"), name: "a.txt", id: "att_a" })
  assert.deepEqual(resolveAttachments(directory, "group:w", ["att_a"]), [stored.attachment])
  assert.deepEqual(resolveAttachments(directory, "group:w", ["att_a", "att_a"]), [stored.attachment])
  assert.throws(() => resolveAttachments(directory, "group:w", ["att_missing"]), /no longer available/i)
})

test("composer attachment drafts stay with their conversation", () => {
  const first: MessageAttachment = { id: "att_a", name: "a.txt", mime: "text/plain", size: 1, kind: "file" }
  const second: MessageAttachment = { id: "att_b", name: "b.txt", mime: "text/plain", size: 2, kind: "file" }
  let drafts = withComposerAttachment({}, "workspace:w", first)
  drafts = withComposerAttachment(drafts, "agent:a", second)
  assert.deepEqual(attachmentsForDraft(drafts, "workspace:w"), [first])
  assert.deepEqual(attachmentsForDraft(drafts, "agent:a"), [second])
  drafts = removeComposerAttachment(drafts, "workspace:w", "att_a")
  assert.deepEqual(attachmentsForDraft(drafts, "workspace:w"), [])
  drafts = clearComposerAttachments(drafts, "agent:a")
  assert.deepEqual(attachmentsForDraft(drafts, "agent:a"), [])
})

test("the default caps are bounded", () => {
  assert.ok(ATTACHMENT_MAX_FILE_BYTES > 0)
  assert.ok(ATTACHMENT_MAX_FILES_PER_MESSAGE > 0)
})
