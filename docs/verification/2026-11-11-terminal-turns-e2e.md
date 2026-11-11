# Terminal turns and root-only synthesis — full E2E verification

Status: **PASS**
Date: 2026-11-11
Spec: [#245](https://github.com/heyimteee/ensemble/issues/245)
Integration tip: `96f7393`
Ticket record: [2026-11-11-ticket-251.md](2026-11-11-ticket-251.md)
Design record: [ADR 0012 — Terminal turns and root-only synthesis](../adr/0012-terminal-turns-and-root-synthesis.md)

## Environment

| Item | Value |
|---|---|
| OS | Linux (Debian GNU/Linux 13) |
| Terminal host | tmux 3.5a |
| Node | 26.12.1 |
| npm | 12.2.1 |
| OpenCode | 2.2.7 |
| Provider | local OpenAI-compatible fake provider (`ensemble-fake`); the real-model `test:live` uses the local catalog |
| Isolation | `scripts/lib/live-harness.sh`; fresh HOME/XDG roots, project, workspace, fake provider, and host per run |

## Matrix

All suites ran sequentially with `ENSEMBLE_LIVE_REQUIRE=1`, so a skip would fail the run. Total: **18m 54s**.

| Suite | Result | Duration | Evidence |
|---|---|---:|---|
| `npm run verify` | PASS | 54s | strict typecheck; 1,915 tests, 0 failed/skipped |
| `npm run test:live:preflight -- all` | PASS | 0s | Node/OpenCode/tmux/fd resolved |
| `npm run test:live:probe` | PASS | 27s | host contract on 2.2.7 |
| `npm run test:live:native-first` | PASS | 11s | main 66/66, restart 18/18, 0 gaps |
| `npm run test:live:vera` | PASS | 19s | seed 2/2, run 54/54, flows 45/45, restart 39/39 |
| `npm run test:live:fake:all` | PASS | 466s | fake + empty; 2/2 |
| `npm run test:live:sizes` | PASS | 58s | 80x24/100x30/120x40/160x50 + NO_COLOR |
| `npm run test:live:lifecycle` | PASS | 333s | heartbeat, deadline, backlog, HISTORY |
| `npm run test:live:subagent` | PASS | 19s | native child lifecycle; probe pinned to the legacy path |
| `npm run test:live:multilocation` | PASS | 71s | shared service/realm; 22/22 budget hops |
| `npm run test:live:latency` | PASS | 16s | keypress-to-repaint samples |
| `npm run test:live:tool-surface` | PASS | 5s | native 6 tools vs legacy 11 |
| `npm run test:live` | PASS | 55s | real TUI acceptance |

## Coverage notes

- Root-only synthesis: the five-hop relay and five-way fan-out each produce one leader synthesis; intermediate hops relay without a leader turn.
- Ancestor completion guard: a leader-owned command root skips the final completion hop; non-leader work still reaches the leader.
- Terminal turns: synthesis, completion review, and batch review mentions are references; the visible notice appears only when no dispatch root was started.
- Multi-ticket continuation: ticket 1's terminal turn starts ticket 2 with `ensemble_dispatch`; ticket 2 is a parentless command root with a fresh budget and one synthesis.
- Refusal: a batch above the new command's ceiling creates no work and posts visible copy; a mid-batch failure cancels the rows created by that attempt.
- Worker routing: a worker handoff to a sibling/new agent still creates a peer turn.
- Measured: leader turns relay 5→1 and fan-out 4→1; leader characters 8,333→236 and 5,761→254; live tool schemas 6 vs 11 = 783 vs 1,371 tokens.

## Configuration notes

- The subagent probe pins `nativeFirst: "off"` because its one-task/barrier assertions predate native-first default-on. Native-first intentionally mints a synthetic native turn for a subagent completion; the ticket217 service test and the native-first suite cover that path.
- The dispatch-budget probe in the multi-location suite pins the legacy tool surface for the same reason.

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
