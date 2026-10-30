import test from "node:test"
import assert from "node:assert/strict"
import { ensembleBlock, onboardingPrompt } from "./init-block.ts"

test("agent onboarding includes the persona and the full Ensemble contract", () => {
  const prompt = onboardingPrompt({ name: "Nova", title: "Frontend Engineer", role: "You own the React frontend." })
  assert.match(prompt, /You are Nova, Frontend Engineer\./)
  assert.match(prompt, /You own the React frontend\./)
  assert.match(prompt, /You are one member of an Ensemble team/)
  assert.ok(prompt.includes(ensembleBlock()))
  assert.ok(prompt.includes("ensemble_handoff"))
})
