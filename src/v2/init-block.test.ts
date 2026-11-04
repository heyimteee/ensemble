import test from "node:test"
import assert from "node:assert/strict"
import { ensembleBlock, initInstruction, onboardingPrompt } from "./init-block.ts"

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
})

test("init instruction replaces an existing Ensemble block instead of duplicating", () => {
  const text = initInstruction()
  assert.match(text, /replace that block in place/)
  assert.match(text, /never add a second Ensemble block/)
  assert.match(text, /stale, duplicated, or overlapping/)
  assert.match(text, /ensemble:start/)
  assert.match(text, /ensemble:end/)
})
