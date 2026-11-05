import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

/**
 * The TUI adapter is a Solid component without a mount harness here, so these
 * static checks pin the two review-fix wirings that pure reducer tests cannot
 * observe: the overlay effect must apply reducer intents (focus restore), and
 * the statusline must keep core segments when Insert has no text target.
 */
test("the overlay effect applies reducer intents instead of dropping focus restore", () => {
  const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
  const marker = "if (interaction().overlay === overlay) return"
  const start = source.indexOf(marker)
  assert.ok(start >= 0, "the overlay effect is present")
  const body = source.slice(start, start + 300)
  assert.ok(
    body.includes('dispatchInteraction({ type: "overlay.set", overlay })'),
    "overlay transitions go through dispatchInteraction so focus-editor intents run",
  )
  assert.ok(
    !body.includes('interactionReducer(state, { type: "overlay.set", overlay }).state'),
    "the effect no longer keeps only the reducer state",
  )
})

test("Insert without a target keeps git, position, selection, and chord segments", () => {
  const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
  assert.ok(!source.includes("insertWithoutTarget(interaction()) ? undefined"), "no status segment is suppressed by Insert without a target")
  for (const line of [
    "git: gitState()",
    "position: statusPosition()",
    "selectionSize: statusSelectionSize()",
    "pendingChord: interaction().pendingChord",
    'notice: insertWithoutTarget(interaction()) ? "no text target" : undefined',
  ]) {
    assert.ok(source.includes(line), `statusSegments keeps: ${line}`)
  }
  assert.ok(source.includes('if (insertWithoutTarget(interaction())) return "Esc normal"'), "only the typing hint becomes the Esc notice")
})
