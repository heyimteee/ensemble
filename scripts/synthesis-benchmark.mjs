#!/usr/bin/env node
// Ticket #249 synthesis-context benchmark.
//
// Reports the synthesis context and prompt characters for a fixed five-branch
// fan-out, the last-20 transcript block that synthesis no longer carries, and a
// representative concise summary length. Token counts use the documented
// chars/4 proxy.

import { synthesisBenchmark, synthesisBenchmarkSummary } from "../src/v2/prompt-benchmark.ts"

const report = synthesisBenchmark()
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${synthesisBenchmarkSummary(report)}\n`)
