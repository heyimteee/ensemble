# Live TUI verification

Run from the repository with Node 26.4+, OpenCode, tmux, Git, and curl available:

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
  Checks observe streaming, finalized content, single occurrences of reply
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
  doctor plus `logs:summary` artifacts. The long-run lifecycle case lives in
  `test:live:lifecycle`.
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
- `npm run test:live:latency`: a reproducible keypress-to-repaint probe on the
  isolated fake host. It reports min/p50/p95/max/mean and raw samples for the
  grouped rail `j`/`k` navigation and for delegation-card appearance
  (`task.delegate` RPC to the first capture showing the right-pane Work card
  title); it is a measurement, not a pass/fail threshold. Set
  `ENSEMBLE_LATENCY_SAMPLES` (default 10) for rail samples and
  `ENSEMBLE_LATENCY_CARD_SAMPLES` (default 5) for card samples.
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

CI keeps the existing `verify` job (`npm ci` then `npm run verify`) and adds a
`live` job on every push and pull request. The live job pins the host toolset:
Ubuntu 24.04, Node 26.12.1 through `actions/setup-node`, OpenCode 2.2.6 through
`npm install --global @opencode/cli@2.2.6`, the runner's `tmux`, and fd 10.2.0
from its release archive. It then runs `npm run test:live:preflight` (fake
scope), `npm run test:live:fake:all`, and
`npm run test:live:multilocation`; all steps set `ENSEMBLE_LIVE_REQUIRE=1`. The
preflight prints the resolved versions and fails if a required tool is missing
or the pinned Node/OpenCode version differs. The fake/empty and multi-location
suites do not use fd; the job still installs it so the same pinned toolset can
validate the full local matrix with `npm run test:live:preflight -- all`.
Real-model checks stay local and are never required in CI.

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
creates one agent and one workspace through the RPC surface, then times rail
`j`/`k` cursor moves from `tmux send-keys` until a pane capture first shows the
cursor on the target row. It then opens the workspace and times `task.delegate`
RPC invocations until the first capture shows the new Work card title. It
reports raw samples plus min/p50/p95/max/mean and both measurement boundaries.
`ENSEMBLE_LATENCY_SAMPLES` controls the rail sample count and
`ENSEMBLE_LATENCY_CARD_SAMPLES` the card sample count.

The number includes tmux send/capture overhead, so compare runs from the same
machine and terminal host rather than treating it as pure render time. The
probe measures and exits; it does not assert a latency threshold.

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

## Size matrix

`npm run test:live:sizes` (ticket #127, three-pane shell #166/#172/#173,
verification #177) is the targeted shell geometry check. It starts the isolated
fake host once, creates three agents and one workspace through the RPC surface,
then restarts the TUI at 80×24, 100×30, 120×40, and 160×50. At each size it
starts a fresh five-group fixture (one two-task group and four single-task
groups), then checks:

- 160×50: three panes, six tasks in two-column cards across two pages, the
  Work header and group labels, spatial `hjkl`, `gg`/`G`, page-edge `j`/`k`,
  the exact right edge, and the focused white / unfocused grey card borders
  read from `tmux capture-pane -e`.
- 120×40 and 100×30: three panes with compact Work rows, group labels, the
  dispatch budget label, focus movement, the page indicator, and the exact
  right edge.
- 80×24: the Work drawer starts closed, `F3` opens and focuses it, compact rows
  and the drawer page indicator are checked, the page edge advances by
  keyboard, and `F3` closes it back to the chat.
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
