# Production-readiness partials: review fixes (tickets #255–#264)

Ticket #255 review follow-up. This record covers the two-axis review fixes on
`ticket/255-review-fixes`; product behavior is unchanged beyond the harness,
test, and policy corrections listed here.

## Findings and fixes

1. **Runtime test seam.** `scripts/live-matrix.sh` no longer reads
   `ENSEMBLE_LIVE_SCENARIO_ROOT`. Scenario selection is exercised through the
   public `fake`/`all` CLI, and the retry/quarantine policy moved to the pure
   `src/v2/live-matrix.ts` module tested directly. The stub-scenario tests were
   removed.
2. **Constant self-assertions.** `WORK_PANE_MAX_WIDTH === 53` and
   `WCAG_AA_TEXT === 4.5` / `WCAG_AA_UI === 3` were removed. The behavioral
   checks stay: 49/48 card-mode boundaries, the exact right edge, and the
   rendered contrast pairs.
3. **Retry literal.** The shell no longer restates `attempt < 2`; the retry
   ceiling comes from `FLAKE_BUDGET.maxRetriesPerSuite` through
   `decideFailedAttempt`.
4. **Wizard sleeps.** The memory add/edit/advance block uses
   `live_require_ready_text`, `live_require_ready_absence`, and
   `live_require_quiescent` instead of fixed sleeps. The alignment block was
   already sleep-free.
5. **Compatibility artifacts.** `.github/workflows/compatibility.yml` sets
   `ENSEMBLE_LIVE_ARTIFACTS` for the fake smoke and uploads the harness
   panes/logs with `if: failure()`. `checkCompatibilityWorkflow` guards both
   the directory and the failure upload.
6. **Header scope.** The group header assertion now reads only the contiguous
   surface-title block at the top of the chat pane. A positive wrapped-title
   fixture and two negative fixtures prove a transcript mention cannot satisfy
   a missing leader or leader agent.
7. **Quarantine ordering.** Classification comes first: only `timing` may
   retry or quarantine. Product, unknown, and infrastructure failures always
   fail, and a quarantine is reported as its own outcome, never a pass.
8. **Latency geometry.** The patch-card fixture renders at the real card
   content width derived from `workspacePaneWidths` and
   `workCardContentWidth`, not a 49-cell card the TUI never draws.

## Judgement calls

- Kept one ASCII glyph map (`src/v2/tui/ascii.ts`) consumed by motion, Work
  rows, chrome, and init rows.
- Kept one `workflowValue` reader (`src/v2/ci-workflows.ts`) shared with
  `scripts/docs-check.mjs`.
- Kept one Work-header summary/page grammar for the full and compact forms.
- Removed `TESTED_NODE_LINES`; `docs:check` now derives the tested Node claim
  from `node-matrix.yml`.
- Removed the identity `METRIC_LABEL` map.
- Replaced the `accumulateCompletions(..., undefined, process.env)` call with
  an options object.
- Removed `retryDecision`'s unused `quarantined` option.
- Kept the `ci-workflows.ts` job-graph checks and the docs-check
  package/matrix checks: #261 owns the CI cost split and failure-artifact
  contract, and #262 owns the docs/version contract. The rationale is recorded
  in the module comments and in the ticket comments for #261/#262.

## Verification

| Command | Result |
| --- | --- |
| `npm run verify` | **Pass** — 2030 tests, 0 failures; `tsc --noEmit` clean |
| `npm run docs:check` | **Pass** — contract v7; OpenCode 2.2.6, 2.2.7; Node >=22.23.4; live Node 26.12.1 |
| `npm run test:live:latency` | **Pass** — rail p95 11 ms / 500 ms; patch-card p95 36 ms / 5000 ms; first-token report-only |
| `ENSEMBLE_LIVE_REQUIRE=1 npm run test:live:fake:all` | **Pass** — fake 412 s, fake-empty 10 s; 0 retries, flake budget ok |
| `git merge integration/prod-partials` | **Clean** (see status after the merge) |

The latency and fake suites ran on the reference host with the isolated
OpenCode 2.2.7 host. No conversation content, credentials, file bytes, or
private paths are recorded here.
