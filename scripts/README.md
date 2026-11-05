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
  picker, and atomic validation errors that preserve the draft.
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
- `npm run test:live:latency`: a reproducible keypress-to-repaint probe on the
  isolated fake host. It reports min/p50/p95/max/mean and raw samples for rail
  `j`/`k` navigation; it is a measurement, not a pass/fail threshold. Set
  `ENSEMBLE_LATENCY_SAMPLES` (default 10) to change the sample count.

The aggregate runner streams each scenario's output unchanged and never
retries. A failing scenario stops the run and later scenarios are reported as
`NOT RUN`. A scenario that prints the harness skip line is reported as `SKIP`,
not `PASS`. Its exit stays zero locally to match the individual commands, so
read the summary: a `SKIP` means the scenario did not run.

All scenarios and the latency probe source `scripts/lib/live-harness.sh`.
Each run owns a temporary project and HOME, plus isolated XDG
config/data/state/cache. Child processes receive a clean environment, not
inherited API keys or OpenCode overrides.
Only the repository plugin is loaded. No real workspace is used. The resolved
absolute OpenCode binary is invoked because HOME-dependent wrappers cannot run
with an isolated HOME. The harness prefers an installed nvm binary; override
with `OPENCODE_BIN`, `TMUX_BIN`, or `NODE_BIN` (executable absolute paths).

Missing OpenCode, tmux, or Node prints an explicit skip and exits zero; the real
scenario also explicitly skips when `fd` is missing. Invalid binary overrides
fail rather than skip. A green live command is not evidence of execution if it
printed a skip.

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
cursor on the target row. It reports raw samples plus min/p50/p95/max/mean and
the measurement boundary. `ENSEMBLE_LATENCY_SAMPLES` controls the count.

The number includes tmux send/capture overhead, so compare runs from the same
machine and terminal host rather than treating it as pure render time. The
probe measures and exits; it does not assert a latency threshold.

The fake provider is infrastructure only and is never imported by the plugin.
It implements `/v1/models` and `/v1/chat/completions` (also without `/v1`).
`fake-rich-fixture` selects the Markdown reply; other prompts get a short
onboarding reply. SSE ends with `finish_reason: "stop"` and `[DONE]`.

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
