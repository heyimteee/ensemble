#!/usr/bin/env node
// Evaluate one live latency result with the pure budget evaluator.
//
//   node --experimental-strip-types scripts/latency-budget.mjs result.json
//   cat result.json | node --experimental-strip-types scripts/latency-budget.mjs
//
// The result file is the JSON written by scripts/lib/latency-driver.mjs. It
// contains only fixture sample timings and counts. Exit 0 when every gate
// metric passes; exit 1 on a budget failure or malformed input.

import { readFileSync } from "node:fs"
import { evaluateLatencyBudget, formatLatencyEvaluation } from "../src/v2/latency-budget.ts"

function fail(message) {
  console.error(`latency-budget: ${message}`)
  process.exit(1)
}

const path = process.argv[2]
let text
try {
  text = path ? readFileSync(path, "utf8") : readFileSync(0, "utf8")
} catch {
  fail("could not read the latency result")
}

let result
try {
  result = JSON.parse(text)
} catch {
  fail("latency result is not valid JSON")
}

const profile = result?.profile
if (profile !== "reference" && profile !== "smoke" && profile !== "report") {
  fail("latency result profile must be reference, smoke, or report")
}
if (!result?.samples || typeof result.samples !== "object") {
  fail("latency result is missing samples")
}

const evaluation = evaluateLatencyBudget({ profile, samples: result.samples })
process.stdout.write(`${formatLatencyEvaluation(evaluation)}\n`)
process.exitCode = evaluation.ok ? 0 : 1
