---
title: Scale, soak, and local diagnostics
description: Tested operating envelope, soak harness, and redacted local diagnostics.
version: 0.1.x
---

# Scale, soak, and local diagnostics

Ticket #276. This page states the production operating envelope, how to run the
soak/leak harness, how to collect support evidence, and the telemetry stance.
Measurements are evidence, not a promise that a larger workspace stays fast;
the gate and its exact run duration are recorded with each result.

## Operating envelope

The numbers below are the tested envelope at the ticket baseline. "Hard" means
the product enforces it; "guidance" is the measured/safe range before the
scoped-read path or a manual delete should be used.

| Resource | Hard mechanism | Tested evidence | Guidance |
| --- | --- | --- | --- |
| Workspaces | One active workspace per directory (`workspace_exists`); no per-service workspace count cap. Each workspace owns config and instruction files. | Soak: 2 workspaces on one service, all agents shared as members. | Keep at most 10 active workspaces per service; use one service per project group and `doctor` across locations. |
| Agents | No roster cap. A user message fan-out is capped by `settings.maxDelegations` (default 10); the generated AGENTS.md roster table grows with the roster. | Soak full-mode: 4 agents in 2 workspaces; smoke: 2 agents, 102 message sends, 0 failed sends. | Keep at most 20 active agents per workspace; archive former members and re-run init/roster reconciliation after large changes. |
| Tasks | Finished rows purge after 24 h (`FINISHED_RETENTION_MS`). Tier 3 scoped reads engage at 500 retained task rows. Dispatch caps are group 8 hops, command 24 hops, depth 8, 2 continuations by default. | `scoped-read-service.test.ts`: 10,000 messages + 602 task rows produced a <128 KiB scoped bootstrap. Soak smoke: 135 retained tasks in 3 minutes; the aggressive 7-minute observation reached 915. | Up to 2,000 retained tasks per workspace is a comfortable working set; above that, use WORK HISTORY paging and delete/archive stale workspaces. |
| Messages | Durable transcript is retained until the workspace is deleted (`pruneWorkspace`). Tier 3 engages at 1,000 messages; below that threshold the client still receives the full snapshot. The client keeps 240 patched rows per workspace; transcript windows are 40 rows (200 max). | `scoped-read-service.test.ts`: 10,000-message workspace returned one 40-row window. `client-store.test.ts`: 5,000 streaming patches stayed bounded at 240 rows. Soak: TUI RSS rose while the full-snapshot path carried 966 rows, then fell from 245 MiB to 220 MiB once the 1,000-row gate engaged. | 10,000 messages per workspace is tested and supported through the scoped path. There is no automatic transcript retention yet; archive or delete workspaces to reclaim history (the retention/export/delete policy is [data and retention](../privacy/data-and-retention.md)). |
| Concurrent runs | `settings.maxActiveRuns` defaults to 3 scheduler slots and is editable. One run per agent session at a time. `maxDelegations` defaults to 10 recipients per command. | Soak full-mode: 4 agents, 2 workspaces. Smoke: 2 agents, 1 workspace, queue peak 2, 1 active run. The aggressive observation peaked at 4 queued items and 2 active runs. Lifecycle checks cover a queued backlog. | 3–8 concurrent runs per service; raise `maxActiveRuns` deliberately and watch queue depth in the soak record. |
| Native session state | `NATIVE_INBOX_ORDER_LIMIT = 64` per session; `NATIVE_SESSION_STATE_LIMIT = 512` settled session values, oldest idle evicted first. | New unit coverage: 537 settled sessions stay bounded at 512; a live execution is never evicted. | The cap bounds a long-running host that has created sessions for deleted agents/workspaces. |
| Logs | In-memory ring 2,000 entries; 10 MiB per file, 5 files per role, 7-day retention; content off by default. | `logging.ts` defaults and rotation/prune tests. | Logs are diagnostics, not durable product state; do not rely on them as an audit trail. |

The diagnostic payload is the scale canary. It grows linearly with durable
messages and tasks because `diagnostic` is an explicit full-state support read.
The soak smoke reached about 302 KiB at 380 messages + 140 tasks; that is why
bootstrap/revision use the Tier 3 scoped path instead of the full diagnostic in
the TUI.

### Accepted durable growth (not leaks)

- **Transcript messages.** User conversation is durable data and is not
  discarded on a timer. A workspace delete removes its message channels.
  Retention/export/delete is the separate data-retention ticket (#272); this
  ticket records the growth and the tested read path, not a new retention
  feature.
- **Dispatch-group ledger.** One compact row per command/continuation is kept
  until the workspace is deleted (or the store row is removed). It is small per
  command and is read by `doctor` for budget invariants.
- **Bindings.** Session bindings are lazy and retained for former members; the
  doctor already reports that as expected.

## Soak/leak harness

`scripts/soak-fake.sh` starts an isolated OpenCode host and the deterministic
fake provider, creates agents/workspaces, sends real `message.send` work through
the queue, and samples one JSONL row per interval. It records only counts,
state names, process RSS, store bytes, diagnostic payload bytes/latency, and
log-sink counters. No conversation text, task titles, instructions, file bytes,
credentials, or private paths enter the record.

```sh
npm run soak:smoke        # 180 s, observe-only; local/CI smoke
npm run soak              # 4 hours, enforced gate (nightly/opt-in)
npm run soak -- --duration 900 --no-enforce   # sustained observation
```

Run the multi-hour gate under `tmux`/`nohup` or on a dedicated host; it is not
a foreground release-review step.

Environment knobs:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ENSEMBLE_SOAK_DURATION_SECONDS` | `14400` | Run duration. `--smoke` forces 180. |
| `ENSEMBLE_SOAK_SAMPLE_SECONDS` | `60` | Sampling interval. `--smoke` forces 15. |
| `ENSEMBLE_SOAK_BURST` | `2` | Messages sent per cycle. |
| `ENSEMBLE_SOAK_AGENTS` | `4` | Fixture agents. `--smoke` forces 2. |
| `ENSEMBLE_SOAK_WORKSPACES` | `2` | Fixture workspaces, one directory each. `--smoke` forces 1. |
| `ENSEMBLE_SOAK_CYCLE_PAUSE_SECONDS` | `5` | Pause after a settled cycle. |
| `ENSEMBLE_SOAK_MAX_RSS_MB_PER_HOUR` | `256` | Enforced absolute RSS slope gate. |
| `ENSEMBLE_SOAK_MAX_RSS_MB_PER_1000_MESSAGES` | `64` | Enforced normalized slope gate; a workload that retains history should not cost more than this per 1,000 messages. |
| `ENSEMBLE_SOAK_ENFORCE` | `1` | `--smoke` and `--no-enforce` record findings without failing. |
| `ENSEMBLE_SOAK_TUI` | `1` | `0` skips the TUI so service-only memory can be isolated. |
| `ENSEMBLE_SOAK_OUT` | a timestamped directory | Where `soak.jsonl` and `soak-summary.json` are written. |

Every fourth cycle also queues a short backlog on the first agent, so queue
depth is exercised instead of only the idle steady state. The run waits for
`pending + working` to reach zero after each cycle and at the tail; an
unsettled queue or native watchdog/subagent state is a finding.

Each JSONL row carries `at`, `elapsedSeconds`, `rss` (service/TUI/total bytes
from the process tree), `messages`, `tasks` and `tasksByState`, `queue`
(pending, working, retrying, stalled, pending approvals, DM queue, active
runs), `native` (subagents, active subagents, native message rows, watchdog
turns, shadow turns/sessions), `dispatchGroups`, `storageBytes`,
`diagnosticBytes`, `diagnosticMs`, and `log` sink counters. The summary adds a
warmup baseline, tail median, peak, per-hour slopes, and findings.

The report ignores a warmup of 10% of the run (capped at 20 minutes), so the
first full-snapshot path and first-mount allocation do not become the baseline.

The gate is intentionally split:

- **Smoke** is a short observation. It proves the harness, workload, sampling,
  and cleanup work. A smoke pass is **not** a multi-hour pass.
- **Full** is the release gate. A 4-hour run (or the documented shorter
  opt-in run) must be recorded in a verification record with its duration,
  sample count, baseline/tail, growth slope, peak queue/native state, and
  findings. Run it on a dedicated host or nightly; do not block a local release
  review on an unrealistic short run.
- The gate fails on RSS growth above 256 MiB/hour, normalized growth above
  64 MiB per 1,000 durable messages, or when the durable queue or native state
  is still unsettled at the tail. The normalized gate distinguishes the
  harness's intentional message/task retention from a leak; the absolute gate
  catches a firehose workload or a constant leak. Findings are always printed
  in observe-only mode.

Artifacts: `soak-summary.json` is the compact record; `soak.jsonl` is the raw
sample series; `soak-errors.log` exists only when a send or sample failed. The
live harness still writes its usual redacted failure artifacts when a run
fails.

## Diagnostics and support bundle

There is no telemetry. All evidence is local and user-initiated.

```sh
npm run doctor -- --json <directory> [<directory> ...]
npm run support:bundle -- --out /tmp/ensemble-support
npm run logs:summary -- --json
```

- **Doctor** calls only the read-only `diagnostic` RPC. It compares rosters,
  workspaces, memberships, bindings, dispatch ledger invariants, and native
  reconciliation facts. `--json` is the machine-readable report.
- **Support bundle** writes `manifest.json`, `doctor.json`,
  `logs-summary.json`, `logs/recent.jsonl`, `logs/files.json`, and
  `service.json` (password always `[redacted]`). It never calls a mutating RPC,
  never uploads, and can still produce a useful bundle when the service is
  unreachable (the doctor error is recorded).
- **Log summary** reports counts, events, failures, feed gaps, and dispatch
  warnings across the local JSONL logs.

These are operator tools run from a source checkout. The published package
excludes the CLI/helper modules (like `doctor` and `data`) and their scripts;
installed integrations use the service RPCs directly.

Redaction rules in the bundle:

- conversation content, task titles, instructions, prompts, results, patches,
  diffs, and file bytes are omitted by key;
- credentials, bearer/basic values, `sk-`/GitHub token shapes, and
  password/token assignments are replaced with `[redacted]`;
- the home directory becomes `~`, the state directory `<state>`, the log
  directory `<logs>`, and requested workspace/live roots `<path>`;
- log rows are bounded to the most recent 500 warn/error/failure rows.

Review the bundle before attaching it to an issue. The command prints the
directory and file sizes; it does not open a browser or send anything.

## Telemetry policy

**Ensemble has no telemetry.** There is no analytics, crash reporting, usage
counter, update ping, or automatic diagnostic upload. The plugin's network
traffic is the user's OpenCode host and the model/provider they configured; the
soak harness uses a loopback fake provider and makes no external model call.

The only operational data is local:

- structured service/TUI logs under `$XDG_STATE_HOME/ensemble/logs` (content
  off by default; `ENSEMBLE_LOG_CONTENT=1` is an explicit opt-in);
- crash/restart facts in the service log and `diagnostic` RPC;
- soak records only when an operator runs the harness;
- support bundles only when an operator runs the command.

If a future release adds telemetry, it must be opt-in, documented here, and
must not carry conversation content, credentials, or private paths.

## Known findings

- **Fixed:** the native ingestion per-session map retained one empty
  `NativeSessionState` per session ever seen until service restart. Settled
  values are now evicted oldest-first above 512, while a live execution,
  inbox, text, row, watchdog, or deferred child is never evicted. Unit coverage
  is in `native-state.test.ts`.
- **Accepted:** durable transcript and dispatch-group growth until workspace
  delete (see above). The scoped read path bounds what the TUI loads; it does
  not delete durable history.
- **Not yet run:** the default 4-hour gate. The smoke and the sustained
  observation are recorded in
  [the ticket #276 verification record](../verification/2026-11-16-ticket-276.md);
  the full run is a nightly/opt-in gate, not a claimed pass.
