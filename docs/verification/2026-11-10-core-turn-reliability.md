# Core turn reliability verification (#192 / #201)

Status: **verified locally on Linux/tmux against an isolated real OpenCode 2.2.6
host and the deterministic fake provider; the unit/type gate passes. The user's
live host was not touched, and the real-model matrix was not run.**
Date: 2026-11-10
Issue: [#201](https://github.com/heyimteee/ensemble/issues/201)
Parent spec: [#192](https://github.com/heyimteee/ensemble/issues/192)
Child tickets: [#193](https://github.com/heyimteee/ensemble/issues/193),
[#194](https://github.com/heyimteee/ensemble/issues/194),
[#195](https://github.com/heyimteee/ensemble/issues/195),
[#196](https://github.com/heyimteee/ensemble/issues/196),
[#197](https://github.com/heyimteee/ensemble/issues/197),
[#198](https://github.com/heyimteee/ensemble/issues/198),
[#199](https://github.com/heyimteee/ensemble/issues/199),
[#200](https://github.com/heyimteee/ensemble/issues/200)
Branch: `ticket/201-verification`
Worktree: `/home/tristan/dev/ensemble-201`
Base: `integration/core-turn-reliability` at `af46d6b` (merged before the final
`npm run verify`; the merge was a no-op)

This record covers the #201 matrix:

1. `npm run verify` and the ticket-scoped unit/service/status/card/doctor tests.
2. Fake live: a completion delivery waiting for a busy recipient reads `QUEUED`
   with no retry attempt or action; a batch review forgets `ensemble_review`
   once and closes through the correction turn; the inline one-step handoff.
3. Isolated real-host native-subagent probe: a deliberately delayed post-child
   wake-up answer becomes the task result and completion-handoff content; after
   a host restart, a genuinely late native report is reconciled into the group
   exactly once with one follow-up hop, no new group, and no hop spend; a second
   restart does not duplicate it; logs carry no answer content.
4. Doctor on the verification state: zero mismatches, including no terminal
   delivery-hold or retry contradiction.

## Environment

| Item | Value |
|---|---|
| OS | Debian GNU/Linux 13 (trixie), Linux 6.12.115+deb13.1-amd64 x86_64 |
| Terminal host | tmux 3.5a |
| Node | v26.12.1 |
| npm | 12.2.1 |
| OpenCode (isolated probe host) | `opencode v2.2.6` |
| Plugin API package | `@opencode/plugin` 2.2.1 |
| Fake provider | dependency-free local OpenAI-compatible server |
| User's live host | **not restarted, reloaded, or reconfigured** |
| macOS/Herdr | Not available; not run |
| Hosted CI | Not run |

The live harness creates its own temporary project, HOME, XDG config/data/state/
cache, OpenCode server, TUI, fake provider, and tmux sessions. It loads only the
worktree plugin and never uses the user's credentials or live workspace.

## Commands and results

| Command | Result |
|---|---|
| `npm run verify` | **Pass** — strict type check; **1618 tests passed, 0 failed, 0 skipped, 0 todo**; 48.3 s. Re-ran after the no-op `integration/core-turn-reliability` merge: same pass (48.3 s). |
| `node --test --experimental-strip-types --test-name-pattern 'ticket193\|ticket197\|ticket198\|ticket199\|ticket200' src/v2/*.test.ts src/v2/tui/*.test.ts` | **Pass** — **144 passed, 0 failed**; delivery-hold/status/card, wake-up, batch correction, late reconciliation, and mention-correction tests. |
| `ENSEMBLE_LIVE_REQUIRE=1 ENSEMBLE_LIVE_ARTIFACTS=/tmp/opencode/verification-201/fake-live npm run test:live:fake` | **Pass** — full deterministic fake TUI suite, including the ticket #201 busy-recipient and batch-correction probes and the existing inline handoff. Doctor: `Mismatches: none`. About 8 minutes. |
| `ENSEMBLE_LIVE_REQUIRE=1 ENSEMBLE_LIVE_ARTIFACTS=/tmp/opencode/verification-201/subagent npm run test:live:subagent` | **Pass** — isolated real OpenCode 2.2.6 host + deterministic fake provider; real child session, delayed wake-up, restart reconciliation, second-restart idempotence, doctor, privacy, and cleanup. |
| `ENSEMBLE_LIVE_REQUIRE=1 npm run test:live:preflight` | **Pass** — node v26.12.1, `opencode v2.2.6`, tmux 3.5a. |
| `git diff --check` | **Pass** — no whitespace errors. |

The doctor was run inside both live harnesses. The fake-live text report contains
`Summary: 0 mismatches across 1 location` and no
`work_terminal_contradiction`/`terminal-with-queue-fields` code. The real probe
also parsed `doctor.json`: `mismatchCount: 0`, empty `byCode`, empty
`mismatches`, so no terminal row retained `retryAfter` or `deliveryHoldUntil`.

## Coverage matrix

| Claim | Check | Layer | Evidence |
|---|---|---|---|
| A completion delivery waiting for a busy recipient reads `QUEUED`, never `RETRYING`, with no retry action | Ticket #201 fake-live busy-recipient block | Fake live + service + TUI | Hop `task_8d1b5c2317514fe293c4` was created `pending`, `attempts: 0`, with `deliveryHoldUntil`, while `BusyLead` streamed; the Work card read `QUEUED`; `RETRYING` and `r retry` were absent; the hop was never claimed and logged no `retry.scheduled`; cancellation recorded `attempts: 0` and cleared the hold. |
| A batch review that replies without `ensemble_review` gets one correction turn and can close correctly | Ticket #201 fake-live batch-correction block | Fake live + service + TUI | Batch `task_2b36deee73104baab25b` logged one `task.batch.correction` naming 2 remaining ids; the correction called `ensemble_review`; the batch closed with `ended,ended`, `reviewCorrectionSent: true`, `attempts: 1`, no `reviewIncomplete`, and transcript `Review closed: Review 2 completions — 2 decided.`; no `task.batch.incomplete` for this batch. |
| The one-step inline handoff writes its own file and queues one durable hop | Existing ticket #195 fake-live block, rerun in this suite | Fake live + service | Generated path under `.ensemble/handoffs/*.md`, one file, handoff frontmatter, typed task/correlation, concise `Handed to $InlinePeer` ack, hop reached `replied`. |
| A delayed post-child wake-up answer becomes the task result and completion-handoff content | Ticket #201 real-host probe | Isolated real host + fake provider | Fake provider held the wake-up reply 3000 ms; service log `native.subagent.wakeup.received` measured **3427 ms** (floor 2000 ms); the task result and the single completion hop carried only `fake-subagent-wakeup-marker`, not the pre-child marker. |
| A genuinely late native report is reconciled after restart exactly once | Ticket #201 real-host probe | Isolated real host + service | After a host/TUI restart, one native follow-up turn (`fake-native-late-report-fixture`) produced `fake-native-late-report-marker`; `native.subagent.followup.reconciled` recorded one message (`msg_1c1e6ab54001Pjdh420ALD7hyP`), one row (`msg_37db582bf57843a4be9b`), one hop (`task_89836f445da44996bee6`); the task has `lateNativeFollowUps.length == 1` with a hop id. |
| No duplicate group row, follow-up hop, or new dispatch group on repeat idle/restart | Ticket #201 real-host probe | Isolated real host + service | A second host/TUI restart left one late row, two completion hops total (original + late follow-up), one parent agent row per captured answer, the original dispatch group only (`dispatch_b00b00ca719541d387ae`), and unchanged `usedHops` (0/8). Service logs contain one `followup.reconciled` row, 3 `task.created` and 3 `task.completed` rows, and 0 `retry.scheduled` rows across three service starts. |
| Logs carry IDs, states, and counts only; never answer content | Ticket #201 real-host probe | Isolated real host + service | `logs.recent` and every service JSONL were scanned for the child instruction, pre-child answer, wake-up answer, and late report marker; none were present. `diagnostic` is the explicit full-state support surface and was not treated as a log. |
| Doctor reports no terminal delivery-hold/retry contradiction | Fake live final doctor + real-probe `doctor.txt`/`doctor.json` | Service/doctor | Both reports show zero mismatches; no `work_terminal_contradiction` or `terminal-with-queue-fields` code appears. |
| Unit/status/card/service/doctor contracts stay green | `npm run verify` plus the ticket-scoped run | Unit | 1618 / 1618 and 144 / 144 pass. |

## Real-host probe timing and state

Observed sequence from the successful run:

| Event | Evidence |
|---|---|
| Real child created | `child ses_e3e19a069ffenbuKJjvbklYel9`, parent task `task_c355b280652a47de9207`, dispatch group `dispatch_b00b00ca719541d387ae` |
| Parent barrier | `native.subagent.barrier.released` duration **4726 ms**; parent stayed `WORKING` with a live lease while the child streamed |
| Delayed wake-up | `native.subagent.wakeup.received` duration **3427 ms** after the fake provider held the answer |
| Result replacement | Task result and completion hop carried `fake-subagent-wakeup-marker`; pre-child marker absent from both |
| First restart | Child record and parent task retained `replied`; original completion hop retained exactly once |
| Late report after restart | One native follow-up turn produced `fake-native-late-report-marker`; one group row and one follow-up hop created in the original dispatch group; no hop spend and no new group |
| Second restart | Late row, hop, and parent task unchanged; one `followup.reconciled` total |
| Doctor | `mismatchCount: 0`, `byCode: {}`, `mismatches: []` |
| Cleanup | Workspace/agent delete removed all native records; no queue row or hop remained |

## Artifacts

Local artifacts (not committed; review before sharing):

- `/tmp/opencode/verification-201/verify-console.txt` — full `npm run verify`.
- `/tmp/opencode/verification-201/verify-final-console.txt` — the required
  post-merge `npm run verify` rerun (same 1618/0 result).
- `/tmp/opencode/verification-201/fake-live-console.txt` — full fake-live output.
- `/tmp/opencode/verification-201/fake-live/` — `doctor.txt`,
  `log-summary.json`, `fake.log`, `server.log`, `tui.log`, `service-logs/*.jsonl`.
  The ticket #201 lines include
  `ticket #201 busy-recipient completion stayed QUEUED with no retry attempt or action`
  and `ticket #201 batch correction spent one turn and closed 2 items`.
- `/tmp/opencode/verification-201/subagent-console.txt` — full real-host probe
  output.
- `/tmp/opencode/verification-201/subagent/` — `doctor.txt`, `doctor.json`,
  `fake.log`, `server.log`, `tui.log`, `service-logs/*.jsonl`, including
  `native.subagent.barrier.released`, `native.subagent.wakeup.received`, and
  `native.subagent.followup.reconciled`.
- Preflight output was printed to the console (node v26.12.1, OpenCode v2.2.6,
  tmux 3.5a); it produced no separate file.

## Skips and residual limits

- **User's live host: NOT TOUCHED.** It was not restarted, reloaded, or
  reconfigured. The real-model card observation on that host remains a
  post-merge step; this record proves the isolated host path instead.
- **Real model/provider: NOT RUN.** Both live checks use the deterministic fake
  provider. They prove the plugin, service, host event, queue, card, and
  transcript seams, not a real model's decision to call a subagent or use a
  tool.
- **macOS/Herdr: NOT RUN.** The existing manual checklist remains the
  authority.
- **Hosted CI: NOT RUN.**
- The delayed wake-up is a provider-side 3000 ms hold after the host starts the
  wake-up turn. The event-race variant (an idle that arrives before the wake-up
  turn starts) is covered at the service seam in
  `ticket197: a delayed post-child wake-up answer becomes the task result`, not
  by this wall-clock probe.
- The late report is produced by a real native follow-up turn **after** the
  host restart, then a second restart proves the durable marker is idempotent.
  The probe does not write the report immediately before a restart; that
  ordering is covered by the service-level restart tests.
- The probe waits for the original completion hop to become terminal before
  restarting, so the late-reconciliation claim is not mixed with an interrupted
  completion run.
- One earlier fake-live attempt failed in the pre-existing `tab-focus hold
  cleaned up` wait and passed unchanged on the verification run. No assertion
  was weakened; this is a residual timing flake in an unrelated scenario.
- The doctor reads one selected service sequentially, not atomically; it is
  diagnostic evidence, not cross-process proof.
- The fake live suite's final `log-summary` intentionally contains the existing
  native-failure fixture (one failed task). The #201 busy hold is a cancelled
  delivery, not a failure and not a stall. The pre-existing ticket #71 batch
  now also receives the #198 correction and stays open as `NEEDS YOU` until the
  later scenario cleanup cancels it; that is the intended correction/fallback
  behavior, not the #201 fixture (which closes through its correction turn).

## References

- Parent spec: [#192](https://github.com/heyimteee/ensemble/issues/192)
- Verification ticket: [#201](https://github.com/heyimteee/ensemble/issues/201)
- Child tickets: [#193](https://github.com/heyimteee/ensemble/issues/193),
  [#194](https://github.com/heyimteee/ensemble/issues/194),
  [#195](https://github.com/heyimteee/ensemble/issues/195),
  [#196](https://github.com/heyimteee/ensemble/issues/196),
  [#197](https://github.com/heyimteee/ensemble/issues/197),
  [#198](https://github.com/heyimteee/ensemble/issues/198),
  [#199](https://github.com/heyimteee/ensemble/issues/199),
  [#200](https://github.com/heyimteee/ensemble/issues/200)
- Prior evidence: [native subagent live verification](2026-11-09-subagent-live.md)
