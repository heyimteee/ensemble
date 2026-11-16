# Production-readiness partials — full E2E verification

Status: **PASS**
Date: 2026-11-16
Spec: [#255](https://github.com/heyimteee/ensemble/issues/255)
Integration tip at matrix time: `a82da1b`
Tickets: #256–#265

## Environment

| Item | Value |
|---|---|
| OS | Linux (Debian GNU/Linux 13) |
| Terminal host | tmux 3.5a |
| Node | 26.12.1 (live); 22.23.4/24.22.1/26.12.1 unit matrix |
| npm | 12.2.1 |
| OpenCode | 2.2.7 live; 2.2.6/2.2.7 compatibility matrix |
| Provider | local OpenAI-compatible fake provider; real-model `test:live` uses the local catalog |
| Isolation | `scripts/lib/live-harness.sh`; fresh HOME/XDG roots, project, workspace, fake provider, and host per run |

## Matrix

All suites ran sequentially with `ENSEMBLE_LIVE_REQUIRE=1`. Total: **17m 57s**.

| Suite | Result | Duration | Evidence |
|---|---|---:|---|
| `npm run verify` | PASS | 52s | strict typecheck; 2,030 tests, 0 failed/skipped |
| `npm run docs:check` | PASS | 1s | contract v7; OpenCode 2.2.6/2.2.7; Node >=22.23.4 |
| `npm run test:live:preflight -- all` | PASS | 0s | Node/OpenCode/tmux/fd resolved |
| `npm run test:live:probe` | PASS | 27s | host contract on 2.2.7 |
| `npm run test:live:native-first` | PASS | 11s | main/restart matrix |
| `npm run test:live:vera` | PASS | 18s | v7 seed/run/flows/restart |
| `npm run test:live:fake:all` | PASS | 424s | fake 413s + empty 10s; 0 retries, 0 quarantined |
| `npm run test:live:sizes` | PASS | 54s | 80x24/100x30/120x40/160x50 + NO_COLOR |
| `npm run test:live:lifecycle` | PASS | 334s | heartbeat, deadline, backlog, HISTORY |
| `npm run test:live:subagent` | PASS | 18s | native child lifecycle |
| `npm run test:live:multilocation` | PASS | 69s | shared service/realm |
| `npm run test:live:latency` | PASS | 9s | smoke: rail p95 10ms/500ms; patch-card p95 36ms/5,000ms |
| `npm run test:live:tool-surface` | PASS | 5s | native 6 tools vs legacy 11 |
| `npm run test:live` | PASS | 55s | real TUI acceptance |

## Support matrices

- Node unit matrix: 22.23.4, 24.22.1, 26.12.1. `engines.node >=22.23.4`.
- OpenCode compatibility: 2.2.6 and 2.2.7 host probe + fake smoke.
- Latency: smoke rail 500ms / patch-card 5,000ms; reference rail 50ms / patch-card 250ms.
- Flake: `fake:all` 0 retries, 0 quarantined; flake budget `ok` (max 1 retry/suite, 0 unclassified).
- Work pane: 53 columns at 196/200/240, 49 content columns, one-card mode floor.

## Notes

- The first full-matrix attempt failed the real `test:live` suite at a brittle composer assertion: the sentence after `@handover.md` wrapped across lines after the Work pane narrowed. #265 made the composer assertions wrap-tolerant; the final matrix above is clean.
- The fake suite's first attempt in an earlier run hit a TUI wizard timing flake; #256 fixed the race at the source with readiness predicates and added the flake policy. The final matrix has 0 retries.

## Skips

- None. `ENSEMBLE_LIVE_REQUIRE=1` makes any skip a failure.

## Privacy

No conversation content, credentials, file bytes, or absolute private paths are committed. Live fixtures use IDs, counts, lengths, and digests only.

## Reproduce

```sh
source ~/.nvm/nvm.sh && nvm use 26.12.1
export ENSEMBLE_LIVE_REQUIRE=1
npm run verify
npm run docs:check
npm run test:live:preflight -- all
npm run test:live:probe
npm run test:live:native-first
npm run test:live:vera
npm run test:live:fake:all
npm run test:live:sizes
npm run test:live:lifecycle
npm run test:live:subagent
npm run test:live:multilocation
npm run test:live:latency
npm run test:live:tool-surface
npm run test:live
```
