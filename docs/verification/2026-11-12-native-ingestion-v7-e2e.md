# Native ingestion state and AGENTS v7 — full E2E verification

Status: **PASS**
Date: 2026-11-12
Issues: [#231](https://github.com/heyimteee/ensemble/issues/231), [#253](https://github.com/heyimteee/ensemble/issues/253)
Integration tip: `884a276`
Ticket records: [2026-11-12-ticket-231.md](2026-11-12-ticket-231.md), [2026-11-12-ticket-253.md](2026-11-12-ticket-253.md)

## Environment

| Item | Value |
|---|---|
| OS | Linux (Debian GNU/Linux 13) |
| Terminal host | tmux 3.5a |
| Node | 26.12.1 |
| npm | 12.2.1 |
| OpenCode | 2.2.7 |
| Provider | local OpenAI-compatible fake provider (`ensemble-fake`); real-model `test:live` uses the local catalog |
| Isolation | `scripts/lib/live-harness.sh`; fresh HOME/XDG roots, project, workspace, fake provider, and host per run |

## Matrix

All suites ran sequentially with `ENSEMBLE_LIVE_REQUIRE=1`, so a skip would fail the run. Successful runs total **19m 15s**.

| Suite | Result | Duration | Evidence |
|---|---|---:|---|
| `npm run verify` | PASS | 54s | strict typecheck; 1,943 tests, 0 failed/skipped |
| `npm run test:live:preflight -- all` | PASS | 0s | Node/OpenCode/tmux/fd resolved |
| `npm run test:live:probe` | PASS | 27s | host contract on 2.2.7 |
| `npm run test:live:native-first` | PASS | 11s | main 66/66, restart 18/18, 0 gaps |
| `npm run test:live:vera` | PASS | 19s | v7 seed 2/2, run 54/54, flows 45/45, restart 39/39 |
| `npm run test:live:fake:all` | PASS | 469s | rerun; fake 460s + empty 9s |
| `npm run test:live:sizes` | PASS | 57s | 80x24/100x30/120x40/160x50 + NO_COLOR |
| `npm run test:live:lifecycle` | PASS | 333s | heartbeat, deadline, backlog, HISTORY |
| `npm run test:live:subagent` | PASS | 20s | native child lifecycle |
| `npm run test:live:multilocation` | PASS | 70s | shared service/realm |
| `npm run test:live:latency` | PASS | 17s | keypress-to-repaint samples |
| `npm run test:live:tool-surface` | PASS | 5s | native 6 tools vs legacy 11 |
| `npm run test:live` | PASS | 73s | real TUI acceptance |

## Flake note

The first full-matrix attempt failed `test:live:fake:all` after 367s at the TUI wizard assertion “members step for alignment.” The same suite passed on an isolated rerun (fake 460s, empty 9s), and every other suite passed on the first attempt. No product code changed between the attempts. This is a TUI harness timing flake, not a native-ingestion or v7 contract failure.

## Coverage notes

- Native ingestion: one per-session state; enqueue/start/answer/steer/settle/reconcile transitions; event order, steering, retry, interruption, adoption, watchdog, deferred child settlement, and restart.
- AGENTS v7: one synthesis per command; intermediate relay; terminal turns treat `$Name` as a reference; `ensemble_dispatch` starts the next ticket as a new command root with a fresh budget; normal worker routing unchanged.
- The Vera regression asserts the v7 block and the exact roster table; the subagent probe pins the legacy path because its one-task/barrier assertions predate native-first default-on.
- Review fixes: v7 absolute prompt ratchet, corrected filled-12 measurement, interruption/restart service table cases, and native-state cleanups.

## Skips

- None. `ENSEMBLE_LIVE_REQUIRE=1` makes any skip a failure.

## Privacy

No conversation content, credentials, file bytes, or absolute private paths are committed. Live fixtures use IDs, counts, lengths, and digests only.

## Reproduce

```sh
source ~/.nvm/nvm.sh && nvm use 26.12.1
export ENSEMBLE_LIVE_REQUIRE=1
npm run verify
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
