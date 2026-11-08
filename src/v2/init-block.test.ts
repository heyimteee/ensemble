import test from "node:test"
import assert from "node:assert/strict"
import { ensembleBlock, initInstruction, initInstructions, onboardingPrompt } from "./init-block.ts"

test("agent onboarding includes the persona and the full Ensemble contract", () => {
  const prompt = onboardingPrompt({ name: "Nova", title: "Frontend Engineer", role: "You own the React frontend." })
  assert.match(prompt, /You are Nova, Frontend Engineer\./)
  assert.match(prompt, /You own the React frontend\./)
  assert.match(prompt, /You are one member of an Ensemble team/)
  assert.ok(prompt.includes(ensembleBlock()))
  assert.ok(prompt.includes("ensemble_handoff"))
  assert.match(prompt, /\$Name/)
  assert.match(prompt, /@.*file references/)
  assert.match(prompt, /ensemble_delegate/)
  assert.match(prompt, /maxHops/)
  assert.match(prompt, /maxHops: 0/)
  assert.match(prompt, /\*\*Task\*\*/)
  assert.match(prompt, /\*\*Group\*\*/)
  assert.match(prompt, /\*\*Command\*\*/)
  assert.match(prompt, /\*\*Depth\*\*/)
  assert.match(prompt, /cannot raise a ceiling/i)
  assert.match(prompt, /ensemble:start v3/)
})

test("init instruction replaces an existing Ensemble block instead of duplicating", () => {
  const text = initInstruction()
  assert.match(text, /replace that block in place/)
  assert.match(text, /never add a second Ensemble block/)
  assert.match(text, /stale, duplicated, or overlapping/)
  assert.match(text, /ensemble:start/)
  assert.match(text, /ensemble:end/)
})

test("native init receives the full detailed workspace initialization instructions", () => {
  const text = initInstructions()
  assert.ok(text.includes(initInstruction()), "the replace policy is part of the full instructions")
  assert.match(text, /Inspect the repository/i)
  assert.match(text, /build, test, and lint/i)
  assert.match(text, /Preserve the project's own guidance/i)
  assert.match(text, /exactly one current Ensemble block/i)
  assert.match(text, /Do not edit \.ensemble\/init\.json/i)
  assert.match(text, /Report what you inspected/i)
})
