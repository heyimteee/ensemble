# Native subagent live verification and barrier decision (#188)

Status: **verified on an isolated real OpenCode 2.2.6 host with the deterministic fake provider; parent barrier added; full `npm run verify` passes. The user's live host remains on `main` `13ef61b` and was not restarted or reconfigured, so its real-model card observation is a post-merge step.**
Date: 2026-11-09
Issue: [#188](https://github.com/heyimteee/ensemble/issues/188)
Spec: [#179](https://github.com/heyimteee/ensemble/issues/179)
Prerequisites: [#182](https://github.com/heyimteee/ensemble/issues/182), [#187](https://github.com/heyimteee/ensemble/issues/187)
Branch: `verify/subagent-live`
Worktree: `/home/tristan/dev/ensemble-188`
Base: `integration/workspace-interaction` at `067a8e0` (includes #182/#185/#187; merged into this branch before the final run)

This record covers:

1. a repeatable real native-subagent probe that creates a genuine child
   session through OpenCode's built-in `subagent` tool;
2. the live evidence that the host finalizes the parent before a background
   child finishes, and the bounded parent barrier added because of it;
3. `experimental.idle` background delivery/shape on OpenCode 2.2.6 and its
   fallback limits;
4. a TUI patch-feed defect the probe exposed on the card path;
5. the exact post-merge command for the user's untouched live host.

## Environment

| Item | Value |
|---|---|
| OS | Debian GNU/Linux 13 (trixie), Linux 6.12.113+deb13-amd64 |
| Terminal host | tmux 3.5a |
| Node | v26.12.1 |
| npm | 12.2.1 |
| OpenCode (probe) | `opencode v2.2.6` |
| Plugin API | `@opencode/plugin` 2.2.1 |
| User's live host | `main` at `13ef61b` (pre-#182/#187); **not restarted or reconfigured** |
| Worktree plugin | `/home/tristan/dev/ensemble-188` at the verification commit |
| macOS/Herdr | Not available; not run |
| Hosted CI | Not run |

## Commands and results

| Command | Result |
|---|---|
| `npm run verify` | **Pass** — strict type check; **1514 tests passed, 0 failed, 0 skipped, 0 todo**, 44.7 s (post-merge tree including #185). |
| `node --test --experimental-strip-types --test-name-pattern 'ticket188' src/v2/service.test.ts src/v2/tui/change-feed.test.ts` | **Pass** — 4 ticket #188 tests: barrier hold/release, timeout + privacy, `experimental.idle` shape, dispatch-group patch validation. |
| `ENSEMBLE_LIVE_REQUIRE=1 ENSEMBLE_LIVE_ARTIFACTS=/tmp/opencode/verification-188/barrier npm run test:live:subagent` | **Pass** — isolated real OpenCode 2.2.6 host + fake provider; real child session, card, barrier, HISTORY, cleanup, restart retention, privacy, `experimental.idle` shape. |
| Pre-barrier baseline (`integration/workspace-interaction` archive at `ae039ce` + this probe/fixture only): `ENSEMBLE_SUBAGENT_EXPECT=early bash scripts/live-subagent-probe.sh` | **Pass as a baseline** — the parent task replied while the child record was not successful (`cancelled` by `task-terminal` cleanup at 388 ms), proving early finalization on the unbarriered tree. |
| `git diff --check` | **Pass** — no whitespace errors. |
| Real host-catalog matrix (`npm run test:live:all`) | **POST-MERGE** — the user's live host runs `main` at `13ef61b`; the merged tree must be loaded first. The host was not restarted. |

## The repeatable probe

`scripts/live-subagent-probe.sh` (wired as `npm run test:live:subagent`) starts
its own isolated OpenCode server, TUI, home, config, state, and tmux sessions.
It loads `$LIVE_ROOT` as the only plugin and never touches the user's live host
or credentials.

The fake provider fixture (`fake-subagent-parent-fixture`) makes the parent
turn call the host's real built-in `subagent` tool with:

```json
{
  "agent": "explore",
  "description": "Watch the CI pipeline",
  "prompt": "Check the CI pipeline from start to finish. fake-subagent-child-hold-fixture",
  "background": true
}
```

OpenCode creates a genuine child native session. The child prompt streams a
bounded hold (`fake-subagent-child-hold-fixture`), so the parent's first turn
finishes while the child is still working. The probe asserts:

| Assertion | Live evidence |
|---|---|
| `session.created.parentID` delivery | Durable record `childSessionID=ses_e41628c7fffeytMCSaH9iAiJFn`, `parentSessionID`, `parentTaskID=task_43bbf5f86ae84b1dae06`, source `session-created`. |
| Parent agent / task / group / workspace mapping | `parentAgent=Kakiko`, same `dispatchGroupID` and `workspaceID` as the parent task; one task row only; `usedHops` unchanged. |
| Card name | Work card header shows `KAKIKO`. |
| Card title | Card title shows the bounded `Subagents: Watch the…` prefix (full instruction truncated to the rendered card width). |
| Working → terminal | Child record `working` while the parent holds, then `replied` with `finishedAt`; parent task then `replied`/`succeeded`. |
| Parent barrier | Parent task stays `working` with `activeRunID`, `claimedBy`, and a future `leaseUntil` while the child is active; it finalizes only after the child. |
| HISTORY | After completion, `f` on the entered Work list shows `WORK HISTORY │` with the `Subagents: Watch the…` card. |
| Restart retention | The isolated server and TUI are killed and restarted on the same state root; the record is still `replied` and HISTORY shows the card. |
| Cleanup | Deleting the probe workspace/agent leaves zero native records; no queue row, no hop spend. |
| No instruction content | `diagnostic`, `logs.recent`, and every isolated service JSONL entry contain no `Watch the CI pipeline`; the durable record still carries it for display. (`fake.log` is fake-provider test infrastructure and records request tails; it is not an Ensemble log and is excluded from this assertion.) |
| `experimental.idle` shape | Debug entry `native.subagent.idle-hook` at `04:42:32.608Z`: `count:1`, `background:[{kind:"subagent", sessionID, childSessionID}]`; no `description`, shell `command`, or image `path`. |

The probe needs no API key and no external model. It is Linux/tmux only, like
the rest of the live harness. It defaults `ENSEMBLE_LOG_LEVEL=debug` for the
isolated service logs; the log evidence contains IDs, kinds, states, and counts
only.

### Early-finalization baseline (pre-barrier tree)

The baseline was run from a `git archive` of `integration/workspace-interaction`
at `ae039ce` with only this probe and fake-provider fixture copied in. It did
not contain the barrier. The service log records:

```text
04:34:08.009  native.subagent.created  state=working source=session-created child=ses_e416a3e02ffe...
04:34:08.390  native.subagent.finished state=cancelled fromState=working reason=task-terminal durationMs=388
04:34:08.390  native.subagent.cleanup  reason=task-terminal count=1
```

The child stream was still in flight when the baseline stopped (it started at
`04:34:08.02` and the fixture's 40 chunks at ~120 ms take about five seconds).
`ENSEMBLE_SUBAGENT_EXPECT=early` therefore observed `parent task replied` while
the child record was `cancelled` (never `replied`). That is exactly the host
behavior the spec warns about: the parent's first turn is idle while its
background child is still running, and #182's task-terminal cleanup closes the
live record.

The probe's `early` mode stops after recording this baseline; it is a diagnostic
mode, not a pass substitute for the default `barrier` mode.

## Barrier decision

**The barrier is required.** The baseline above proves the parent task finalizes
before the child succeeds. The host schema independently documents the shape:
`@opencode/plugin`'s `SessionIdle.background` includes
`{ kind: "subagent", sessionID, childSessionID, agent, description }`, and the
hook is described as running when a Session finishes model work with background
work still running.

Implementation:

- `NATIVE_SUBAGENT_BARRIER_MS = 5 * 60_000` in `src/v2/native-subagents.ts`;
  `EnsembleV2Service` accepts a test-only `nativeSubagentBarrierMs` override.
- After a successful native turn, `runTask` holds the task (and its existing
  20 s heartbeat / 60 s lease) until every `working` child mapped to
  `parentSessionID` + `parentTaskID` reaches a terminal state.
- The wait is event-driven: terminal transitions and record removals wake the
  parent-session waiter. A timeout logs `native.subagent.barrier.timeout` with
  child IDs/count/duration only, finalizes the parent, and the existing
  task-terminal cleanup closes the live child record. Service stop releases all
  waiters, so shutdown cannot hang.
- When the barrier releases after a real child, the run waits once more for a
  host wake-up turn and re-reads the assistant result, so a notification turn's
  later answer is not lost. A run with no active child pays no extra wait.
- Logs: `native.subagent.barrier.released` and `.timeout` carry parent task,
  parent session, child IDs, count, and duration; never the instruction.

Live evidence after the barrier: record created at `04:42:32.206`, child
`replied` at `04:42:37.314`, `barrier.released` at `04:42:37.315`
(`durationMs: 4703`), with the parent remaining `working` and heartbeating for
the whole child window.

The timeout test proves the bound releases a missing child, the task replies,
the child record is cancelled by terminal cleanup, and the timeout log contains
no instruction content.

## `experimental.idle` on OpenCode 2.2.6

**Available and verified.** The isolated host delivered the hook while the
parent was idle and the child still streamed. The service's debug entry at
`04:42:32.608Z` is:

```json
{"sessionID":"ses_e41628dc0ffeIR5UCfYpyAg13J","count":1,
 "background":[{"kind":"subagent","sessionID":"ses_e41628dc0ffeIR5UCfYpyAg13J",
 "childSessionID":"ses_e41628c7fffeytMCSaH9iAiJFn"}],
 "event":"native.subagent.idle-hook"}
```

The live probe also saw parent and child idle notifications with `count:0` /
`background:[]` after their turns, confirming the hook fires on normal idles
too.

Fallback and limits:

- The primary tracker remains `session.created.parentID`; `session.idle`
  background reconciliation (source `idle-background`) covers a missed child
  creation, as pinned by `ticket182: session.idle background reconciles a missed
  session.created`.
- If a future host stops exposing `experimental.idle`, the adapter's
  `installIdleHook` is the only path that would need a compatibility guard; the
  tracker still works from `session.created` + execution events. The probe then
  records the explicit fallback line instead of claiming hook delivery.
- Host notices admitted with `resume: false` (for example recovered after a
  restart) wait for the next wake. A child that never emits any terminal event
  is bounded by the barrier timeout and then closed by task-terminal cleanup;
  it does not hold the task forever.

## Patch-feed defect found by the probe

The first probe runs showed the child record in the server snapshot but no live
card. The TUI log showed `feed.gap` with `malformed` and repeated full-snapshot
fallbacks. Root cause: `src/v2/tui/refresh-coordinator.ts` `validChange` had no
`dispatchGroup` case even though `EntityChange` carries the dispatch ledger, so
any batch containing a ledger upsert was rejected as malformed. A short child
could finish before the snapshot fallback rendered it.

Fix: validate `dispatchGroup` upserts/removes, with
`ticket188: dispatch-group entities validate through the patch feed` in
`src/v2/tui/change-feed.test.ts`. After the fix, the live TUI applied the
native card patch while the child was working and the probe observed the card
and HISTORY as expected.

## Post-merge steps (user's live host)

The user's host still runs `main` at `13ef61b` (pre-#182/#187) and was not
restarted or reconfigured. The isolated real-host probe above proves the branch
against OpenCode 2.2.6 without touching it. After the integration branch lands
on `main` and the host is restarted once, run from the merged checkout:

```sh
cd /home/tristan/dev/ensemble
source /home/tristan/.nvm/nvm.sh && nvm use 26.12.1
npm run verify
ENSEMBLE_LIVE_REQUIRE=1 npm run test:live:subagent
```

For the real host-catalog matrix (models and providers from the isolated host
catalog rather than the fake provider):

```sh
ENSEMBLE_LIVE_REQUIRE=1 npm run test:live:all
```

A real-model card observation on the user's actual TUI remains manual: ask an
Ensemble agent to dispatch a native subagent, then inspect the Work pane. It is
intentionally not marked passed here because the live host was not restarted and
this record does not fake that evidence.

## Artifacts

Local artifacts (not committed; review before sharing):

- `/tmp/opencode/verification-188/barrier-console.txt` — full probe output.
- `/tmp/opencode/verification-188/barrier/` — `fake.log`, `server.log`,
  `tui.log`, and `service-logs/*.jsonl`; includes
  `native.subagent.created`, `native.subagent.barrier.released`,
  `native.subagent.idle-hook`, and the TUI patch/HISTORY behavior.
- `/tmp/opencode/verification-188/baseline-console.txt` — pre-barrier baseline output.
- `/tmp/opencode/verification-188/baseline/` — baseline service logs with the
  `task-terminal` cancel at 388 ms.
- `/tmp/opencode/verification-188/verify-console.txt` — `npm run verify` output.

## Remaining limits

- The probe uses a deterministic fake model/provider; it proves the plugin,
  service, tracker, patch feed, and TUI seams, not a real model's decision to
  call a subagent. The child session itself is real host state.
- The user's live host and macOS/Herdr paths were not exercised; both are
  post-merge follow-ups.
- The barrier bound is five minutes. A child that runs longer or loses all
  terminal events releases the parent at the bound and the existing
  task-terminal cleanup records the child as cancelled; the card is history,
  not a live forever-row.
- `experimental.idle` is an experimental host hook. Its absence degrades to the
  `session.created`/execution/idle-background tracker, but a host that neither
  sends `session.created` nor background idle entries cannot map the child.
