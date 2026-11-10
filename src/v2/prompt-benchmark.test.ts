import test from "node:test"
import assert from "node:assert/strict"
import { benchmarkReport, benchmarkSummary, schemaText, toolSurfaceSize } from "./prompt-benchmark.ts"

test("ticket225: prompt-size regression gate records tool schema, identity, context, calls, and round-trips", () => {
  const report = benchmarkReport()
  assert.equal(report.before.toolSurface.count, 11)
  assert.equal(report.after.toolSurface.count, 5)
  assert.ok(report.after.toolSurface.estimatedTokens < report.before.toolSurface.estimatedTokens * 0.5, benchmarkSummary(report))
  assert.ok(report.after.identity.chars < 6200, `identity stayed compact: ${report.after.identity.chars}`)
  assert.ok(report.after.turnContext.chars < 1600, `turn context stayed compact: ${report.after.turnContext.chars}`)
  assert.ok(report.after.totalPrompt.estimatedTokens < report.before.totalPrompt.estimatedTokens * 0.6, benchmarkSummary(report))
  assert.ok(report.reduction.totalPromptPct >= 40, benchmarkSummary(report))
  assert.equal(report.before.toolCalls, 1)
  assert.equal(report.after.toolCalls, 0)
  assert.equal(report.before.modelRoundTrips, 2)
  assert.equal(report.after.modelRoundTrips, 1)
})

test("ticket225: north-star schema bytes are the native decision set", () => {
  const native = schemaText("native")
  assert.equal(toolSurfaceSize("native").count, 5)
  assert.doesNotMatch(native, /workspace_info|list_agents|list_workspaces|send_message/)
  assert.match(native, /task_status/)
  assert.match(native, /ask_person/)
  assert.match(native, /review/)
  assert.match(native, /remember/)
  assert.match(native, /share/)
})
