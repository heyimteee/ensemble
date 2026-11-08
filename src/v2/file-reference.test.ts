import test from "node:test"
import assert from "node:assert/strict"
import { escapeFileReference, fileReferenceTokenAt, fileReferenceTokens, replaceFileReference, unescapeFileReference } from "./file-reference.ts"

test("file reference tokens start at a boundary and stop at the cursor", () => {
  const cases: Array<{
    name: string
    text: string
    cursor: number
    expected: { start: number; end: number; raw: string; path: string } | undefined
  }> = [
    { name: "bare trigger", text: "@", cursor: 1, expected: { start: 0, end: 1, raw: "@", path: "" } },
    { name: "start of text", text: "@handover.md", cursor: 12, expected: { start: 0, end: 12, raw: "@handover.md", path: "handover.md" } },
    { name: "middle of a sentence", text: "read @notes.md", cursor: 14, expected: { start: 5, end: 14, raw: "@notes.md", path: "notes.md" } },
    {
      name: "cursor at the token end before a suffix",
      text: "read @notes.md and more",
      cursor: 14,
      expected: { start: 5, end: 14, raw: "@notes.md", path: "notes.md" },
    },
    { name: "cursor after the closing space", text: "read @notes.md and more", cursor: 15, expected: undefined },
    { name: "cursor later in the sentence", text: "read @notes.md and more", cursor: 20, expected: undefined },
    { name: "cursor before the trigger", text: "read @notes.md", cursor: 5, expected: undefined },
    { name: "cursor at the start", text: "read @notes.md", cursor: 0, expected: undefined },
    { name: "cursor past the text", text: "read @notes.md", cursor: 99, expected: undefined },
    { name: "cursor inside the typed prefix", text: "read @notes.md", cursor: 9, expected: { start: 5, end: 9, raw: "@not", path: "not" } },
    {
      name: "escaped space at the end",
      text: "read @my\\ notes.md done",
      cursor: 18,
      expected: { start: 5, end: 18, raw: "@my\\ notes.md", path: "my notes.md" },
    },
    {
      name: "cursor after an escaped space",
      text: "read @my\\ notes.md",
      cursor: 10,
      expected: { start: 5, end: 10, raw: "@my\\ ", path: "my " },
    },
    { name: "escaped backslash", text: "@a\\\\b", cursor: 5, expected: { start: 0, end: 5, raw: "@a\\\\b", path: "a\\b" } },
    {
      name: "second of multiple tokens",
      text: "@one @two.md",
      cursor: 9,
      expected: { start: 5, end: 9, raw: "@two", path: "two" },
    },
    { name: "first of multiple tokens", text: "@one @two.md", cursor: 4, expected: { start: 0, end: 4, raw: "@one", path: "one" } },
    { name: "email is not a reference", text: "mail@example.com", cursor: 16, expected: undefined },
    { name: "punctuation is not a boundary", text: "see (@notes.md)", cursor: 15, expected: undefined },
    { name: "dangling escape", text: "read @notes\\", cursor: 12, expected: undefined },
    { name: "dangling escape before the cursor", text: "read @my\\ notes.md", cursor: 9, expected: undefined },
    { name: "newline closes the token", text: "read @notes.md\nmore", cursor: 19, expected: undefined },
    { name: "escaped trigger inside the path", text: "@a\\@b", cursor: 5, expected: { start: 0, end: 5, raw: "@a\\@b", path: "a@b" } },
  ]
  for (const scenario of cases) {
    assert.deepEqual(fileReferenceTokenAt(scenario.text, scenario.cursor), scenario.expected, scenario.name)
  }
})

test("file reference tokens are found across a whole message", () => {
  assert.deepEqual(
    fileReferenceTokens("@one @two.md").map((token) => ({ start: token.start, path: token.path })),
    [
      { start: 0, path: "one" },
      { start: 5, path: "two.md" },
    ],
  )
  assert.deepEqual(fileReferenceTokens("mail@example.com and @notes.md").map((token) => token.path), ["notes.md"])
  assert.deepEqual(fileReferenceTokens("see (@notes.md)").map((token) => token.path), [])
  assert.deepEqual(fileReferenceTokens("see @my\\ notes.md and @two.md").map((token) => token.path), ["my notes.md", "two.md"])
  assert.deepEqual(fileReferenceTokens("@a\\\\b").map((token) => token.path), ["a\\b"])
  assert.deepEqual(fileReferenceTokens("@bad\\").map((token) => token.path), [])
})

test("file reference paths escape and unescape as one grammar", () => {
  assert.equal(unescapeFileReference("notes.md"), "notes.md")
  assert.equal(unescapeFileReference("my\\ notes.md"), "my notes.md")
  assert.equal(unescapeFileReference("a\\\\b"), "a\\b")
  assert.equal(unescapeFileReference("my\\"), undefined)
  assert.equal(unescapeFileReference("my notes.md"), undefined)

  assert.equal(escapeFileReference("notes.md"), "notes.md")
  assert.equal(escapeFileReference("my notes.md"), "my\\ notes.md")
  assert.equal(escapeFileReference("a\\b"), "a\\\\b")
  for (const path of ["notes.md", "docs/my notes.md", "a\\b"]) {
    assert.equal(unescapeFileReference(escapeFileReference(path)), path)
  }
})

test("selecting a file replaces only the token and keeps the suffix", () => {
  assert.deepEqual(replaceFileReference("read @han and more", "handover.md", 5, 9), {
    text: "read @handover.md and more",
    cursor: 18,
  })
  assert.deepEqual(replaceFileReference("read @my rest", "my notes.md", 5, 8), {
    text: "read @my\\ notes.md rest",
    cursor: 19,
  })
  assert.deepEqual(replaceFileReference("@one and @two tail", "picked.md", 0, 4), {
    text: "@picked.md and @two tail",
    cursor: 11,
  })
  assert.deepEqual(replaceFileReference("read @han  two", "handover.md", 5, 9), {
    text: "read @handover.md  two",
    cursor: 18,
  })
  assert.deepEqual(replaceFileReference("read @han\nnext", "handover.md", 5, 9), {
    text: "read @handover.md \nnext",
    cursor: 18,
  })
})
