# Native-first code-review fixes — verification

- **Date:** 2026-11-11
- **Branch:** `ticket/review-fixes`
- **Base:** `integration/native-first` at `2228366`
- **Issues:** parent #209, review findings from the standards/spec review, follow-up #231
- **Unit gate:** `npm run verify` (strict typecheck + full test suite)
- **Live gate:** `npm run test:live:native-first`

## Fixed findings

- Per-agent durable native mirror (`Agent.nativeMirror`, default on), a General
  settings toggle row, and ingestion/reconciliation gates that skip private
  native prompts without stopping managed composer work.
- Recovered native prompts map host prompt files to transcript attachment chips.
- Reconciliation captures a binding target key and repeats against a changed
  target, so an adoption during a start/reconnect read recovers into the new
  conversation only.
- `nativeMentionRouting: false` selects the legacy tool surface, restoring the
  explicit `send_message` path alongside the visible routing refusal.
- Shadow comparison reports the planned/visible routing delta as data; the #227
  driver uses a `$Name` shadow prompt and asserts no unexplained text, phase, or
  routing mismatch.
- Native ingress no longer awaits one session's processing in
  `handleHostEvent`; different sessions ingest in parallel.
- Delegated prompts keep the bounded last-20 group transcript with the compact
  roster and budget.
- Standards: source-text wiring guards narrowed, tool-list self-assertion
  removed, native-direct UI derives from `chatContext()?.conversation`, and the
  glossary keeps only the domain definition.

## Deferred

- The ~12 parallel native service-state maps were not merged in this branch.
  Follow-up #231 carries the exact maps/functions and the refactor rationale.

## Verification

| Command | Result |
|---|---|
| `npm run verify` | **Pass** — strict typecheck; 1809 tests passed, 0 failed, 0 skipped |
| `npm run test:live:native-first` | **Pass** — main and restart phases, 0 gaps, shadow comparison row logged |
| `npm run test:live` | **Fail** — real TUI check times out waiting for the workspace wizard after agent creation; follow-up #232 |
