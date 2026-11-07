# Retry-stall follow-up (#144)

Status: **verified locally on Linux/tmux; macOS/Herdr unexecuted**
Date: 2026-11-08
Issue: [#144](https://github.com/heyimteee/ensemble/issues/144)
Base: `integration/ensemble-v7` at `e5e51e8`
Branch: `fix/v7-retry-stalls`

This record covers the post-v7 retry fix:

- A retrying card now shows `retry <n>s · <attempt>/5`, or
  `retry due · r now` when the backoff has elapsed.
- One durable system event names the ETA, attempt, and failure reason.
- Maintenance claims due work after its repair pass, so a future retry
  resumes after a restart, hot reload, or lost in-memory timer without an
  unrelated schedule.
- An uncertain tool outcome parks behind an interrupted approval instead of
  auto-retrying.
- Backoff is 5 s, 15 s, 30 s, then a 60 s cap, with jitter.
- Braille runs at 8 fps and the Sub-Cell Tide at 15 fps (previously 4/10).

## Environment

| Item | Value |
|---|---|
| OS | Linux 6.12.113+deb13-amd64 |
| Terminal host | tmux 3.5a |
| Node | v26.12.1 |
| OpenCode | `opencode v2.2.6` |
| macOS/Herdr | Not available; not run |

## Commands and results

| Command | Result |
|---|---|
| `npm run verify` | **Pass** — strict type check; **953 passed, 0 failed, 0 skipped**. |
| `npm run test:live:fake:all` | **Pass** — fake **195 s**, fake-empty **9 s**; 2 passed, 0 failed. |
| `npm run test:live:sizes` | **Pass** — 80×24, 100×30, 120×40, 160×50 group/layout/focus/composer checks; `NO_COLOR` still-motion check. |
| `git diff --check` | **Pass** — no whitespace errors. |

### CPU after the faster cadence

`test:live:sizes` records one 0.9 s TUI-process sample per count at 160×50:

| State | TUI CPU |
|---|---:|
| Idle | **3.3%** |
| 1 working card | **10.0%** |
| 2 working cards | **17.8%** |
| 3 working cards | **28.9%** |

These are short, noisy samples. The faster Braille/tide cadence raises the
1–2-card cost relative to the pre-fix 4/10 fps record; the 3-card sample is
within the previous run's variance. The harness does not gate on these numbers.

## Behavioral evidence

| Behavior | Evidence | Result |
|---|---|---|
| Countdown, attempt, and due copy | `ticket144: retrying detail counts down, names the attempt, and yields to needs-you` | pass |
| Per-second card refresh without rebuilding static cards | `ticket144: a retry countdown refreshes every second and stops at the ETA` | pass |
| One durable retry event with ETA and reason | `ticket75: an empty assistant reply is retried, never a silent success` asserts exactly one `Retrying in …` message | pass |
| Future retry wakes after restart/lost timer | `ticket144: maintenance claims a future retry without an unrelated schedule` (service start with future `retryAfter`; maintenance claims after ETA) | pass |
| Uncertain tool outcome parks for review | `ticket144: an uncertain tool outcome parks for review instead of auto-retrying` asserts `interrupted`, pending approval, no `retryAfter` | pass |
| Backoff 5/15/30/60 with cap and jitter | `src/v2/retry.test.ts` | pass |
| Group lifecycle, needs-you, failure events, sizes | full suite plus fake and size matrix | pass |

## Skips and limitations

- **macOS/Herdr: NOT RUN.** The existing manual checklist remains the
  authority for macOS font coverage, color perception, and key ownership.
- Hosted CI was not run.
- The live fake scenario does not directly simulate a retry cycle; the
  wake-up and uncertain-outcome behavior are covered at the service seam and
  the card copy at the pure seam.
