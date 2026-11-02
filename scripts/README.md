# Live TUI verification

Run from the repository with Node 26.4+, OpenCode, tmux, Git, and curl available:

- `npm run test:live`: existing real-runtime acceptance (agent/workspace wizards,
  composer agent/file completions, sending, command palette, RPC deletion, help,
  and return to the native TUI). File completion additionally requires `fd`.
  Models come from the host's default catalog, not your personal configuration.
  With no models, the agent/workspace/composer portion is explicitly skipped.
- `npm run test:live:fake`: no API key or external model request. A local Node
  HTTP server binds an ephemeral loopback port and streams fixed rich Markdown.
  Checks observe streaming, finalized content, single occurrences of reply
  markers, no remaining streaming label, no stale lines after navigation,
  searchable help, the current platform's shortcut labels, and that the wizard
  footer advertises `Ctrl+P back` / `Ctrl+N next` with both chords actually
  advancing and returning a step.
- `npm run test:live:fake:empty`: same isolated fake provider, but configured
  with no models. Walks the New-agent wizard to the Main model step and asserts
  the explained empty state (`0 options` plus `No models available …`) and that
  Escape still cancels the wizard.

Both scenarios source `scripts/lib/live-harness.sh`. Each run owns a temporary
project and HOME, plus isolated XDG config/data/state/cache. Child processes
receive a clean environment, not inherited API keys or OpenCode overrides.
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

Waits poll observable conditions with bounded timeouts. Slow machines may set
`ENSEMBLE_LIVE_START_TIMEOUT` (30s), `ENSEMBLE_LIVE_TUI_TIMEOUT` (60s), or
`ENSEMBLE_LIVE_STEP_TIMEOUT` (20s) for helpers using those defaults. Individual
scenario assertions also supply explicit timeouts. Set `ENSEMBLE_LIVE_DEBUG=1`
to print resolved binaries and fixture paths. No exact full ANSI frame is
asserted; these are content/behavior checks, not pixel-level visual tests.

The fake provider is infrastructure only and is never imported by the plugin.
It implements `/v1/models` and `/v1/chat/completions` (also without `/v1`).
`fake-rich-fixture` selects the Markdown reply; other prompts get a short
onboarding reply. SSE ends with `finish_reason: "stop"` and `[DONE]`.
