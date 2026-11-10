#!/usr/bin/env node
// Ticket #225 prompt/tool-surface benchmark.
//
// Reports exact tool-schema JSON bytes, the injected identity and per-turn
// context, estimated prompt tokens (chars/4, documented proxy), tool calls,
// and model round-trips for the same coordination operation before and after
// the native-first tool retirement. Wall-clock measurements come from
// scripts/live-tool-surface-benchmark.sh on the isolated fake host.

import { benchmarkReport, benchmarkSummary } from "../src/v2/prompt-benchmark.ts"

const report = benchmarkReport()
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${benchmarkSummary(report)}\n`)
