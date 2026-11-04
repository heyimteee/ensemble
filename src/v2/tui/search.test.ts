import test from "node:test"
import assert from "node:assert/strict"
import { matchExcerpt, matchIndexAfter, transcriptMatches } from "./search.ts"

const lines = [
  { id: "a", text: "alpha fixture beta" },
  { id: "b", text: "nothing here" },
  { id: "c", text: "FIXTURE and fixture again" },
]

test("transcript search is case-insensitive and reports every occurrence in the window", () => {
  const matches = transcriptMatches(lines, "fixture")
  assert.deepEqual(
    matches.map((match) => [match.lineID, match.occurrence, match.start, match.end, match.text]),
    [
      ["a", 0, 6, 13, "fixture"],
      ["c", 0, 0, 7, "FIXTURE"],
      ["c", 1, 12, 19, "fixture"],
    ],
  )
})

test("an empty query has no matches and search never mutates the loaded window", () => {
  const before = JSON.stringify(lines)
  assert.deepEqual(transcriptMatches(lines, ""), [])
  assert.deepEqual(transcriptMatches(lines, "   "), [])
  assert.equal(JSON.stringify(lines), before)
})

test("search treats punctuation literally rather than as a regular expression", () => {
  assert.deepEqual(transcriptMatches([{ id: "a", text: "a.b" }], ".").map((match) => match.start), [1])
  assert.deepEqual(transcriptMatches([{ id: "a", text: "a.b" }], "a.*b"), [])
})

test("n/N navigation cycles through matches in both directions", () => {
  assert.equal(matchIndexAfter(3, null, 1), 0)
  assert.equal(matchIndexAfter(3, 0, 1), 1)
  assert.equal(matchIndexAfter(3, 2, 1), 0, "n wraps to the first match")
  assert.equal(matchIndexAfter(3, 0, -1), 2, "N wraps to the last match")
  assert.equal(matchIndexAfter(1, 0, 1), 0)
  assert.equal(matchIndexAfter(0, null, 1), 0)
})

test("the excerpt names the matched text without losing the surrounding phrase", () => {
  assert.equal(matchExcerpt("alpha fixture beta", 6, 13), "alpha fixture beta")
  const long = `${"x".repeat(40)} fixture ${"y".repeat(40)}`
  const excerpt = matchExcerpt(long, 41, 48)
  assert.ok(excerpt.includes("fixture"))
  assert.ok(excerpt.startsWith("…"))
  assert.ok(excerpt.endsWith("…"))
  assert.ok(excerpt.length <= 51)
})
