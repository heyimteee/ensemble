# Live TUI verification

Run from the repository with Node 22.23.4+, OpenCode, tmux, Git, and curl available:

Flake policy: `scripts/live-matrix.sh` retries a failed suite at most once, and
only when the harness classified the failure as a TUI timing failure. Product,
unknown, and infrastructure failures never retry. Every attempt is recorded in
`flake-records.jsonl`; the matrix prints `flake-report` rows with suite,
attempt, classification, and artifact path, and writes `flake-report.json`
beside the failure artifacts. A failure preserves redacted pane captures and
logs under `ENSEMBLE_LIVE_ARTIFACTS` (CI uploads them). Quarantine entries in
`scripts/flake-quarantine.json` require a linked issue and an owner, and they
apply only to a classified timing failure; any product, unknown, or
infrastructure failure still fails the run. The full budget and quarantine
rules are in
[docs/verification/flake-policy.md](../docs/verification/flake-policy.md).

- `npm run test:live`: existing real-runtime acceptance (agent/workspace wizards,
  composer agent/file completions, sending, command palette, RPC deletion, help,
  and return to the native TUI). The v5.8 section checks the message-start
  palette flags, proves prose `/init` stays ordinary group text, and runs `I`
  through the visible System Agent job to a terminal report. File completion
  additionally requires `fd`. Models come from the host's default catalog, not
  your personal configuration. With no models, the agent/workspace/composer
  portion is explicitly skipped.
- `npm run test:live:fake`: no API key or external model request. A local Node
  HTTP server binds an ephemeral loopback port and streams fixed rich Markdown.
  The walkthrough runs the explicit legacy surface (`nativeFirst: off`) because
  its direct, DM-queue, and statusline assertions predate default-on; the Vera
  regression covers the default-on cutover. Checks observe streaming, finalized content, single occurrences of reply
  markers, no remaining streaming label, no stale lines after navigation,
  searchable help, the v5.7 persistent mode (roster/chat `Enter` keeps the
  mode; wizard steps keep their arrival mode), block/line caret transitions,
  one-by-one wizard memories with `n`/`N`/`Esc` navigation, settings memory
  parity, statusline segments and `│` separators, the leader badge spacing,
  composer drafts and queued messages, the wizard Esc ladder, and that typing
  plus `/` reach the native prompt immediately after `:q`, while `:`/`/` still
  open Command mode after an F2 round-trip. The v5.8 section adds deterministic
  project skill fixtures and checks visible System Agent init progress and
  reports for `I`/`:init`/`/init`, the visible `/init` audit line, `|` palette
  flags, assigned-skill invocation with exact text, multi-skill grouping,
  multi-agent and mixed anchors, one-run General-skill leader triage, the owner
  picker, and atomic validation errors that preserve the draft. Ticket #177
  adds the three-pane shell: split rail grouping with durable collapse across a
  TUI restart, ACTIVE/HISTORY movement and retention, the native-session
  picker and its missing-binding message, aligned member columns, right-pane
  approvals opened with `v`/Enter and resolved with Enter/Esc, Work-card action
  validity and focus borders, untracked/spaced/suffixed composer file
  references with a
  cached index (a counting `fd` wrapper proves filtering spawns no discovery),
  a genuine native FAILED card next to a controlled-stop CANCELLED card, and
  doctor plus `logs:summary` artifacts. Ticket #186 adds the pane-interaction
  delivery: the select/interact focus matrix, chat Enter versus `i`, Agents-first
  `h`, Work via `l`, `Space b l/r` toggles with durable visibility and F3
  removal, ANSI evidence for focused white / unfocused grey pane headings and
  borders, task-level HISTORY with rollup/expand/dismiss/clear, the one-line
  aggregate activity summary with Work open, and the small/full approvals modes
  with the left footer, chat modal, and `V` retired. The long-run lifecycle case
  lives in `test:live:lifecycle`.
- `npm run test:live:probe`: ticket #210's native host event-contract probe. It
  starts an isolated OpenCode 2.2.6 host and fake provider, loads a recording
  plugin through the same `ctx.event.subscribe` surface the service uses, and
  drives the native turns native-first ingestion depends on: direct, workspace,
  retry, interruption, attachment, synthetic, background subagent, delivery
  change/cancel, move, session-list scopes, and a ten-second idle observation.
  It writes a normalized JSONL fixture (text lengths/digests only; no content or
  absolute paths) and runs `src/v2/native-host-fixture.test.ts` against the fresh
  record. `ENSEMBLE_PROBE_OUT` selects the output path,
  `ENSEMBLE_PROBE_ARTIFACTS` copies the host logs, and
  `ENSEMBLE_PROBE_WRITE=1` refreshes the committed fixture at
  `src/v2/fixtures/native-host-contract.jsonl`.
- `npm run test:live:native-first`: ticket #227's cutover matrix. It starts
  the isolated fake host, loads the worktree Ensemble plugin, and drives real
  native prompts through the same `@opencode/client` surface as the #210 probe:
  a direct turn, a workspace turn, user and agent final-text `$Name` routing,
  an attachment prompt, session adoption, retry, user interruption, Work
  history paging and a fresh reload, rollback to `toolSurface: "legacy"`, a
  full host restart with post-restart ingestion, and latency/token metrics.
  The restart phase asserts the `nativeFirst: "shadow"` contract: shadow
  ingestion, a content-free comparison row, and an unchanged visible path. The
  scenario fails on any recorded shadow gap or prompt content in service logs.
- `npm run test:live:vera`: ticket #241's Vera regression plus ticket #251's
  multi-ticket and token verification. One isolated fake host, three starts,
  and a real temp workspace. The scenario seeds a v5 contract, removes the
  persisted `nativeFirst` key from the isolated plugin store, restarts, and
  requires the effective mode to be `on` and the default to be persisted. It
  then checks the generated v7 roster table, drives one leader native turn that
  explicitly delegates one member and `$Name`-mentions several more, and
  asserts one work item per member, one `already-routed` suppression for the
  explicit recipient, no completion hop back to the leader, and one settlement.
  It exercises `nativeFirst: "off"` plus `toolSurface: "legacy"`, restores
  `on`/`native`, and then runs a second `VeraFlows` workspace: a six-turn
  five-hop `$Name` relay, the relay root's terminal `ensemble_dispatch` into a
  five-way fan-out, the next ticket's one-synthesis root, a visible
  command-cap dispatch refusal with no work created, and a worker `$Name` route
  to a sibling. Every command root is leader-owned, so the completion guard
  skips per-child reviews; the driver records leader turns, leader output,
  synthesis prompt/context characters, and the native six-tool vs legacy
  eleven-tool schemas. The fake provider is the only model; the store fixture
  removes one settings key and reports counts only.
- `npm run test:live:subagent`: ticket #188's real native-subagent probe. The
  isolated OpenCode 2.2.6 host runs the worktree plugin against the fake
  provider, then an Ensemble agent's fake turn calls the host's built-in
  `subagent` tool in `background: true` mode. This creates a genuine child native
  session while the parent turn has already finished. The probe checks the
  durable `NativeSubagentRun` (parent task/group/workspace/agent, bounded
  instruction, `session-created` source), the `Subagents: Watch the…` Work card
  and parent agent name, the bounded parent barrier (parent stays `working`
  with a live lease until the child's terminal event), the child
  working→replied transition, HISTORY, cleanup with no queue row or hop spend,
  no instruction content in diagnostics/logs, `experimental.idle` background
  shape, and restart retention. Set `ENSEMBLE_SUBAGENT_EXPECT=early` to run the
  pre-barrier baseline against an older tree; it records that the parent replies
  before the child succeeds and stops before the post-barrier assertions. The
  probe defaults `ENSEMBLE_LOG_LEVEL=debug` for its isolated service logs.
- `npm run test:live:lifecycle`: a full wall-clock fake run that streams for
  about 5m40s across the old five-minute delivery deadline while the service
  heartbeat renews its 60-second lease. A second delivery sent immediately
  stays pending past its own delivery timestamp, then runs when the first turn
  finishes. Checks the card stays mounted, no false `failed`/`interrupted`
  state appears, both groups finish `replied`, and the doctor/log summary carry
  no false failure or stall. Late-success repair, genuine interruption, and
  stalled/retrying labels remain service/TUI-seam tests because no public live
  RPC can inject those durable states; the script logs those skips. Expect
  about six minutes.
- `npm run test:live:latency`: the latency budget probe on the isolated fake
  host. It gates rail keypress p95 (50 ms reference) and the deterministic
  patch-card p95 (250 ms reference), and reports first-token only. The
  patch-card fixture reads the durable `changes.since` patch and renders the
  real Work-card mapping without waiting for a model token. The default
  `smoke` profile uses generous PR thresholds; `npm run
  test:live:latency:reference` runs the strict reference gate.
  `ENSEMBLE_LATENCY_SAMPLES` (default 10) and
  `ENSEMBLE_LATENCY_CARD_SAMPLES` (default 5) control the sample counts;
  `ENSEMBLE_LATENCY_REGRESSION_MS` injects a deliberate regression that must
  fail the gate. See [the budget policy](../docs/verification/latency-budget.md).
- `npm run test:live:fake:empty`: same isolated fake provider, but configured
  with no models. Walks the New-agent wizard through the empty one-by-one
  memory list to the Main model step and asserts the explained empty state
  (`0 options` plus `No models available …`), `n`/`N` step navigation, and that
  Escape cancels through the dirty-draft confirm. It also proves the empty
  memory list writes nothing and that `:init` still routes to the Ensemble init
  path (with a workspace-first message) while `:init <mention>` is rejected as
  solo-only without a model catalog.
- `npm run test:live:fake:all`: runs the fake scenario, then the empty-catalog
  scenario, in that order. Stops at the first failure and prints one compact
  summary (`PASS`/`FAIL`/`SKIP` per scenario, counts, elapsed time). This is the
  deterministic fake-and-empty suite.
- `npm run test:live:all`: the same runner, adding the real host-catalog
  scenario last. Use it for the full local matrix; the real scenario is not
  deterministic and is not the CI guardrail.
- `npm run test:live:preflight`: resolves the harness binaries and prints the
  Node, OpenCode, and tmux versions. The default fake scope does not require
  `fd`; `npm run test:live:preflight -- all` also requires and prints it for the
  real scenario. Set `ENSEMBLE_LIVE_EXPECT_NODE` and
  `ENSEMBLE_LIVE_EXPECT_OPENCODE` to fail on a present-but-wrong version.
- `npm run test:install:rc`: ticket #270's clean-install release-candidate
  proof. Packs the current package, serves it from a loopback-only npm registry,
  installs it with `opencode plugin add` into an isolated OpenCode 2.2.7 host,
  and checks `opencode plugin list`, the installed built package and its TUI
  dependencies, the server tools, and the TUI route and `/ensemble` command.
  It uses the loopback registry only for the candidate package; the declared
  runtime dependencies come from the public npm registry. It needs no public
  publish or credentials and is not part of PR CI. See the
  [ticket #279 record](../docs/verification/2026-11-16-ticket-279.md) and the
  [ticket #270 source-package failure](../docs/verification/2026-11-16-ticket-270.md).
- `scripts/release-guard.mjs`: ticket #275's release preflight. Validates the
  triggering ref against `package.json` (a tag push must be exactly
  `v<version>`; a dispatch is always a dry run), refuses a version with no
  non-empty `CHANGELOG.md` section, writes `RELEASE_NOTES.md`, and exports
  `version`, `tag`, `dry-run`, and `dist-tag` to the workflow. It reads no
  credential. Run it with `--event` and `--ref` locally; see
  [release operations](../docs/operations/release.md).
- `npm run test:live:multilocation`: the single-service regression probe. Starts
  the isolated fake host and TUI, creates four channels and eight agents, sends
  100 requests, and asserts one `service.start`, zero `task.failed`, zero
  failure records, all related tasks successful, and fewer than five warn-level
  `feed.gap` lines in the TUI log. A fifth channel/agent pair then runs a
  fake-provider `ensemble_ask_person` tool call from that non-first location:
  the probe requires the pending approval, resolves it, and requires cleanup
  (spec #146 and #157). A sixth channel then runs the deterministic
  dispatch-budget relay (spec #159 / ticket #164): five hops in one group, nine
  hops across a continuation, an 8-hop command-cap stop, and one consumed row
  per hop. These scenarios run after the measured 100-request path, so its
  counts and timings stay unchanged. The probe then runs the doctor and
  `logs:summary` (whole run and each budget root group). Set
  `ENSEMBLE_LIVE_ARTIFACTS=/path` to copy the driver output, doctor text, log
  summaries, and service/TUI JSONL there before the isolated tree is removed.
- `npm run logs:summary -- --dir <logs>`: read-only JSONL summary by role,
  instance, level, event, task, failures, warnings, `feed.reset`, and
  `feed.gap`. It adds dispatch counts (groups, hops, exhausted, continued,
  refused, closed, reconciled, invalid settings) and recent exhaustion/refusal
  warnings. `--group <id>` includes both the named group and its continuation
  lineage (rows whose `dispatchGroupID` or `rootID` matches). Use `--json` for
  the machine-readable form and `--since` to scope a verification run.

The aggregate runner streams each scenario's output unchanged and never
retries. A failing scenario stops the run and later scenarios are reported as
`NOT RUN`. Skip handling follows the contract below.

## CI

PR feedback is split by cost; the expensive environment-sensitive checks are
nightly. Every live job pins the same toolset through
[`.github/actions/live-host`](../.github/actions/live-host/action.yml): Ubuntu
24.04, Node 26.12.1, OpenCode 2.2.7 (the latest host in the compatibility
matrix; `compatibility.yml` covers 2.2.6 and 2.2.7), the runner's `tmux`, fd
10.2.0, `npm ci`, and `npm run build` (the package exports load `dist/`, so a
fresh checkout must build the runtime before a live suite starts a host).
Every live job sets `ENSEMBLE_LIVE_REQUIRE=1`, writes
redacted artifacts to `$RUNNER_TEMP/ensemble-live-artifacts`, and uploads them
on failure. The preflight prints the resolved versions and fails if a required
tool is missing or the pinned Node/OpenCode version differs.

### Pull request and push (`verify.yml`)

| Job | Suites | Timeout | Observed |
| --- | --- | ---: | ---: |
| `verify` | `npm run verify` (typecheck + unit suite, including the CI job-graph check) | 15 min | ~1 min |
| `live-fake` | `test:live:fake:all`, `test:live:sizes`, `test:live:lifecycle`, `test:live:subagent` | 45 min | ~17 min |
| `live-native` | `test:live:native-first`, `test:live:vera`, `test:live:tool-surface` | 20 min | ~3 min |
| `live-multilocation` | `test:live:multilocation` | 20 min | ~3 min |
| `latency-smoke` | `test:live:latency` (`smoke` profile: 500 ms rail, 5000 ms card) | 20 min | ~3 min |

The live jobs run in parallel after checkout, so the PR critical path is the
longest live job plus tool setup: target 20 minutes, budget 30 minutes wall
clock. The sum of job timeouts is 120 minutes; the deterministic suite sum is
about 20 minutes on the local reference host (fake 8 min, lifecycle 6 min,
sizes 1 min, multilocation 1 min, the native suites under 1 min, latency under
1 min). The `live-fake` timeout is 45 minutes to absorb a slower shared runner
without letting one job hang indefinitely.

### Nightly (`nightly.yml`)

| Job | Suites | Timeout | Observed |
| --- | --- | ---: | ---: |
| `latency-reference` | `test:live:latency` (`reference` profile: 50 ms rail, 250 ms card) | 30 min | ~3 min |
| `soak-smoke` | `npm run soak:smoke` (180 s observe-only record; the 4-hour gate is opt-in) | 20 min | ~4 min |
| `real` | `test:live` with the real host catalog; opt-in via the `real` dispatch input or `ENSEMBLE_NIGHTLY_REAL=1` | 30 min | ~3 min |

The schedule is `17 4 * * *`; `workflow_dispatch` allows a manual run. The
real-model job is skipped unless opted in, so credentials and model cost stay
controlled. Nightly wall-clock budget is 80 minutes with all jobs; the soak
smoke record uploads even on success, and the full multi-hour gate remains a
manual/opt-in run recorded in a verification record.

### Kept separate

`compatibility.yml` runs `npm ci`, `npm run build`, the host probe, and the
deterministic fake smoke on OpenCode 2.2.6 and 2.2.7; `node-matrix.yml` runs
`npm run verify` on Node 22.23.4, 24.22.1, and 26.12.1; `docs.yml` runs
`npm run docs:check`. The old `latency.yml` is removed: the smoke profile lives
in `verify.yml` and the reference gate in `nightly.yml`. `src/v2/ci-workflows.ts`
and its test assert this job graph, the suite ownership, the timeouts, the
artifact uploads, the `ENSEMBLE_LIVE_REQUIRE=1` contract, the runtime build
after dependency install, and the OpenCode pin.

## Skip versus fail

This is the authoritative contract; other documents point here instead of
restating it.

- Local runs keep the historical contract: a missing prerequisite prints
  `...; skipping` and exits zero. The aggregate runner reads a structural skip
  marker from the harness, reports that scenario as `SKIP`, and keeps the
  overall exit zero. Read the summary and report a `SKIP` as **not run**, not
  as a pass.
- `ENSEMBLE_LIVE_REQUIRE=1` turns every prerequisite skip into a failure, so
  the aggregate runner reports `FAIL` and stops.
- A present-but-wrong pinned version in preflight is always a failure.
- Invalid binary overrides (`OPENCODE_BIN`, `TMUX_BIN`, or `NODE_BIN` set but
  not executable) fail rather than skip.

The equivalent local CI check is:

```sh
ENSEMBLE_LIVE_REQUIRE=1 npm run test:live:preflight
ENSEMBLE_LIVE_REQUIRE=1 npm run test:live:fake:all
```

The deterministic suite takes about 7 minutes on the v5.9 local Linux/tmux
host (fake scenario ~6m45s including the native-failure retry fixture, empty
catalog ~10s). GitHub Actions adds `npm ci` and tool-install time; the live
job timeout is 30 minutes.

All scenarios and the latency probe source `scripts/lib/live-harness.sh`.
Each run owns a temporary project and HOME, plus isolated XDG
config/data/state/cache. Child processes receive a clean environment, not
inherited API keys or OpenCode overrides.
Only the repository plugin is loaded. No real workspace is used. The resolved
absolute OpenCode binary is invoked because HOME-dependent wrappers cannot run
with an isolated HOME. The harness prefers an installed nvm binary; override
with `OPENCODE_BIN`, `TMUX_BIN`, or `NODE_BIN` (executable absolute paths). The
[Skip versus fail](#skip-versus-fail) contract defines what happens when one is
missing or invalid.

## Failure inspection

By default, failure prints pane captures and log tails (server password redacted)
and kills only this run's sessions, then removes its temporary directory.

Use `ENSEMBLE_LIVE_KEEP=1 npm run test:live:fake` (or `test:live`) to retain
processes and files **on failure**. The report lists the base directory, logs,
and tmux session names. Attach using the printed `tmux attach -t <session>`.
When finished, kill each listed session and remove only the printed temporary
directory. Logs and configuration are local diagnostic artifacts; inspect for
sensitive content before sharing. Successful runs always clean up.

The fake checks are the primary regression net for the v5.7 and v5.8 behavior; run
`test:live:fake` more than once when changing focus, caret, or native
key-ownership code. The real scenario covers the packaged plugin against the
host catalog but has fewer interaction assertions.

Waits poll observable conditions with bounded timeouts. Slow machines may set
`ENSEMBLE_LIVE_START_TIMEOUT` (30s), `ENSEMBLE_LIVE_TUI_TIMEOUT` (60s), or
`ENSEMBLE_LIVE_STEP_TIMEOUT` (20s) for helpers using those defaults. The T4
work fixture separately bounds its delegated-reply wait with
`ENSEMBLE_LIVE_T4_TIMEOUT` (180s); on timeout it prints the matching subtask
row, state counts, all row states, and workspace names before failing. It does
not retry. Individual scenario assertions also supply explicit timeouts. Set
`ENSEMBLE_LIVE_DEBUG=1` to print resolved binaries and fixture paths. No exact
full ANSI frame is asserted; these are content/behavior checks, not pixel-level
visual tests.

## Latency probe

`npm run test:live:latency` starts the isolated fake provider, server, and TUI,
creates one agent and one workspace through the RPC surface, then measures:

- `rail`: rail `j`/`k` cursor moves from `tmux send-keys` until a pane capture
  first shows the cursor on the target row. This includes tmux send/capture
  overhead; compare runs from the same machine and terminal host.
- `patchCard`: a deterministic headless fixture. It invokes `task.delegate`,
  reads the durable `changes.since` patch after that version, applies the
  subtask changes to a client-side state map, and renders the real
  `workCardForTask` mapping. It never waits for a model token, so the fake
  provider's hold cannot dominate the card number.
- `firstToken`: the `task.delegate` RPC to the first visible model reply. It is
  report only; a slow model is not a slow UI.

The default `smoke` profile gates rail p95 at 500 ms and patch-card p95 at
5000 ms for shared PR runners. The reference gate is strict:

```sh
ENSEMBLE_LIVE_REQUIRE=1 npm run test:live:latency:reference
ENSEMBLE_LATENCY_PROFILE=reference ENSEMBLE_LATENCY_SAMPLES=20 \
  ENSEMBLE_LATENCY_CARD_SAMPLES=10 npm run test:live:latency
```

`ENSEMBLE_LATENCY_SAMPLES` controls the rail count and
`ENSEMBLE_LATENCY_CARD_SAMPLES` the patch-card count.
`ENSEMBLE_LATENCY_REGRESSION_MS=1000` adds a deliberate per-sample regression
and must fail the reference gate. `ENSEMBLE_LATENCY_OUT` selects the result
JSON path; CI uploads it with the redacted failure artifacts. The pure
evaluator and profiles are documented in
[docs/verification/latency-budget.md](../docs/verification/latency-budget.md).

The fake provider is infrastructure only and is never imported by the plugin.
It implements `/v1/models` and `/v1/chat/completions` (also without `/v1`).
`fake-rich-fixture` selects the Markdown reply; other prompts get a short
onboarding reply. SSE ends with `finish_reason: "stop"` and `[DONE]`.
`fake-budget-relay:chain=…;consumed=…;total=…;next=…;mode=…` selects the
dispatch-budget fixture: the provider writes the typed handoff file under
`--handoff-dir` and emits one `ensemble_handoff` or `ensemble_delegate` tool
call, then answers normally after the tool result. It also closes a completion
batch with `ensemble_review`. The multi-location harness passes the isolated
workspace's handoff directory. `fake-lease-hold` streams for about 5m40s for
the lifecycle check; `fake-motion-static` streams once for the reduced-motion
Work-card probe; `fake-native-error` returns a non-retried 4xx model error for
the genuine FAILED card. `fake-subagent-parent-fixture` emits one native
`subagent` tool call in background mode with the child instruction
`fake-subagent-child-hold-fixture`; the child stream holds long enough to observe
the parent barrier and Work card. A one-shot init pre-stream pause keeps the
indeterminate System Agent row observable, and a pre-stream turn pause keeps
the transient `Asking $Name…` window observable on the narrower chat cell.

## Soak and support bundle

`npm run soak:smoke` is the short local/CI observation (180 s, observe-only).
`npm run soak` is the default 4-hour enforced gate (nightly/opt-in). Both start
an isolated fake host, create agents and one-directory-per-workspace fixtures,
send real `message.send` work, and write `soak.jsonl` plus
`soak-summary.json` under `ENSEMBLE_SOAK_OUT`. The record has counts, process
RSS, store bytes, diagnostic payload size/latency, queue/native state, and
log-sink counters only; titles, instructions, text, file bytes, and private
paths never enter it. See
[docs/operations/scale-and-monitoring.md](../docs/operations/scale-and-monitoring.md)
for the gate, knobs, and the recorded envelope.

`npm run support:bundle -- --out DIR` collects redacted local evidence:
`doctor.json`, `logs-summary.json`, bounded warn/error/failure log rows, a log
inventory, and the service descriptor with the password redacted. There is no
upload. Review the files before attaching them to an issue.

## Size matrix

`npm run test:live:sizes` (ticket #127, three-pane shell #166/#172/#173,
verification #177) is the targeted shell geometry check. It starts the isolated
fake host once, creates three agents and one workspace through the RPC surface,
then restarts the TUI at 80×24, 100×30, 120×40, and 160×50. At each size it
starts a fresh five-group fixture (one two-task group and four single-task
groups), then checks:

- 160×50: three panes, six tasks in one full-width card per row across two
  pages, the Work header and group labels, spatial `hjkl`, `gg`/`G`,
  page-edge `j`/`k` and `h`/`l`, the exact right edge, and the focused white /
  unfocused grey card borders read from `tmux capture-pane -e`. It also reads
  pane headings and borders from ANSI capture: the selected Agents/Workspaces
  section, chat, and Work are white while the rest stay grey.
- 120×40 and 100×30: three panes with compact Work rows, group labels, the
  dispatch budget label, focus movement, the page indicator, the exact right
  edge, and the same per-pane white/grey heading and border contract.
- 80×24: the Work drawer starts open with durable visibility (ticket #183),
  `Space b r` closes and reopens it, `F3` is proven retired, the closed drawer
  survives a TUI restart, compact rows and the drawer page indicator are
  checked, and the page edge advances by keyboard.
- `NO_COLOR=1` restarts at 120×40 and proves frame-0 motion plus the state
  word while work is live.

The same run records the idle TUI process CPU at 160×50, then the TUI process
CPU and tmux pane updates for one, two, and three working cards. These numbers
are observations, not thresholds. Override the set with
`ENSEMBLE_V6_SIZES="120x40 160x50"`; `ENSEMBLE_V6_SKIP_LOAD=1` skips the CPU
load probe for a faster layout-only pass. It is Linux/tmux only, like the rest
of the live harness, and is not a substitute for the full `test:live:fake`
scenario or the macOS/Herdr checklist.

The full `test:live:fake` scenario keeps its 160×80 default and contains
viewport-sensitive transcript assertions. Use the size matrix for other
geometries; running the full scenario at a smaller height can fail because a
finalized rich reply is not visible in the shorter pane, not because the Work
layout is wrong.

## Backup and restore

`npm run backup` is the operator client for ticket #273's durable-state
recovery path. It calls the running service's existing `ensemble.v2` RPC
`invoke` method and resolves the same service descriptor as `doctor`:

```sh
npm run backup -- export --out ./ensemble-backup.json "$PWD"
npm run backup -- status "$PWD"
npm run backup -- restore --in ./ensemble-backup.json --confirm RESTORE "$PWD"
npm run backup -- rollback --confirm ROLLBACK "$PWD"
```

`export` writes an owner-only (`0600`) file atomically and prints counts only.
`restore` and `rollback` refuse while work is running and never print
conversation content or credentials. The document contains conversation
content: keep it private. The full procedure, format, and failure behavior are
in [backup and restore](../docs/operations/backup-restore.md).

## Issue hygiene

`npm run issue:hygiene` is a read-only GitHub listing for tracker cleanup. It
lists parent issues whose sub-issues are all closed. The default filter is open
parents, which are the ones awaiting a closure decision:

```sh
npm run issue:hygiene
```

Use `--all` to audit already-closed parents against the records in
`docs/verification/`:

```sh
npm run issue:hygiene -- --all
```

Each row shows the issue number, state, closed/total child count, matching
verification record (or `missing` for a versioned spec), and title. The command
never edits or closes an issue. It needs an authenticated `gh` CLI; pass
`--repo owner/name` to inspect another repository, `--input <file>` to read
`gh issue list` JSON offline, or `--root <dir>` to resolve a different
verification directory. Follow the closure rule in the [issue tracker
guide](../docs/agents/issue-tracker.md#closing-a-completed-version-specification).
