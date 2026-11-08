import test from "node:test"
import assert from "node:assert/strict"
import { assistantResult, FALLBACK_REPLIES, isFallbackReply } from "./execution.ts"

test("internal fallback replies live in one fallback set", () => {
  assert.deepEqual(
    [...FALLBACK_REPLIES].sort(),
    ["Reply completed.", "Reply interrupted.", "Reply interrupted before completion."].sort(),
  )
  for (const fallback of FALLBACK_REPLIES) {
    assert.equal(isFallbackReply(fallback), true)
    assert.equal(isFallbackReply(`  ${fallback}\n`), true, "surrounding whitespace never makes a fallback substantive")
  }
  assert.equal(isFallbackReply("Reply completed. Extra detail"), false)
  assert.equal(isFallbackReply("OK"), false)
  assert.equal(isFallbackReply(undefined), false)
})

test("assistantResult ignores native text from before the attempt started", () => {
  // The recovered request-23 shape: the native session still holds the old
  // assistant answer, but the new attempt produced no assistant text.
  const result = assistantResult(
    [{ type: "assistant", time: { created: 1 }, content: [{ type: "text", text: "Previous answer" }] }],
    100,
  )
  assert.equal(result.text, "")
})
