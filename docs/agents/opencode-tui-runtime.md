# OpenCode/OpenTUI runtime guide

Read before changing the TUI or host integration, or diagnosing location divergence. This is a navigation guide, not a new extension contract. Preserve the [compatibility boundaries](../../AGENTS.md#compatibility-boundaries).

## Evidence and versions

- **Declared API/source:** the lockfile installs `@opencode/plugin` **2.2.1** and OpenTUI **0.7.0** for checking. Inspect their declarations and shipped implementation using the paths below.
- **Observed runtime:** the November 1, 2026 probes used Node **26.12.1** and OpenCode **2.2.3**. The [v5.8 integration matrix](../verification/2026-11-05-v58.md) ran Node **26.12.1** with OpenCode **2.2.5** on Linux/tmux. CI now pins Node **26.12.1** and OpenCode **2.2.6** for the deterministic fake/empty live job. These are not the same as the pinned type-package version. The [v7 verification](../verification/2026-11-07-v7.md), the [dispatch-budget verification](../verification/2026-11-08-dispatch-budgets.md), the [workspace-v2 verification](../verification/2026-11-09-workspace-v2.md), and the [native host contract probe](../verification/2026-11-10-native-host-contract.md) ran Node **26.12.1** with OpenCode **2.2.6** on Linux/tmux. The [2.2.1 compatibility report](../compatibility/opencode-2.2.1.md) and [October 31 verification](../verification/2026-10-31.md) are historical, version-scoped evidence.
- **Repository behavior:** links below describe the current implementation. A passing typecheck establishes agreement with installed types, not compatibility with every installed host. Record `node --version` and `opencode --version` with live results; recheck assumptions when upgrading.

Research proposals are not implemented guarantees. In particular, one local service descriptor does not discover every service process, and a snapshot request is not guaranteed to be free of server-side writes from unrelated maintenance.

## Page inputs and reactive access

**Declared:** `node_modules/@opencode/plugin/dist/tui/context.d.ts` defines `Page.render({ data? })`; it does not promise reactive page-data updates. The same file explicitly describes *slot* inputs as reactive. Do not generalize between these two surfaces.

**Observed constraint:** page/component values captured as snapshots do not become live merely because they were passed to a plugin page. Solid component bodies and `<For>` item callbacks do not rerun wholesale when selection changes. A local `const selected = props.cursor === index()` captures that evaluation; use a getter/accessor evaluated in JSX or a reactive computation when the value must change.

For state owned by Ensemble, keep it in signals/memos, and read accessors inside tracked expressions. The [page entry](../../src/v2/tui/index.tsx) renders `EnsembleV2App` without route data; the [app](../../src/v2/tui/app.tsx) obtains fresh RPC snapshots into a signal. Accessors over local signals help; wrapping an unchanged host snapshot in a function does not make the host publish updates.

For a small control whose local state must reset when its identity changes, a keyed `<Show when={identity()} keyed>` can deliberately recreate the child. The app uses keyed boundaries for pickers, text prompts, and wizard steps. Choose an identity that changes only when reset is intended. This is a local lifecycle tool, **not a transcript refresh strategy**.

## Textarea content contract

**Declared:** OpenTUI's `renderables/Textarea.d.ts` and `renderables/EditBufferRenderable.d.ts` expose `initialValue`, `onContentChange`, `plainText`, `setText`, and a separate `onSubmit`. This is not the browser `onInput(event.target.value)` contract, nor a string-valued `onChange`.

Read the current content from the renderable ref inside the notification and submission handlers, as the app's composer does:

```tsx
<textarea
  ref={(value) => { composerRef = value }}
  initialValue={draft()}
  onContentChange={() => setDraft(String(composerRef?.plainText ?? ""))}
  onSubmit={() => submit(String(composerRef?.plainText ?? ""))}
/>
```

This excerpt illustrates the contract, not a standalone component. `initialValue` initializes the buffer; it is not a controlled `value` prop. Use the declared buffer methods for programmatic changes. Configure submit/newline key bindings explicitly; preserve multiline text, paste, focus, and draft behavior when changing the composer.

## Markdown needs a SyntaxStyle

**Declared:** `renderables/Markdown.d.ts` consumes a `SyntaxStyle`; `syntax-style.d.ts` declares `SyntaxStyle.fromStyles(styles, owner)` and `destroy()`. A theme color object alone is not that native style resource.

**Repository pattern:** [syntax.ts](../../src/v2/tui/syntax.ts) is the authoritative complete style map for Ensemble. It covers defaults/text, code-token families, headings 1–6, strong/emphasis, raw inline/block code, links/labels/URLs, lists/check states, quotes, rules, and images. Reuse it rather than supplying a heading-only map or duplicating the token list. Missing scopes can leave rich content unstyled; the declarations do not prove that every missing scope throws.

The app creates one style with `SyntaxStyle.fromStyles(markdownStyles(context.theme), context.renderer.nativeScene)` and destroys it on cleanup. That scene access is the current integration point (cast in source), not proof of a portable host API; verify ownership against the target runtime before changing it. The app warns and falls back to plain rendering if style creation fails. A readable fallback is not evidence that rich styling passed. Verify headings, emphasis, lists, quotes, inline/fenced code, links, and tables in the live TUI.

## Keep transcript scrollbox identity stable

**Repository behavior:** the app keeps finalized messages inside one scrollbox and renders the live streaming block outside it. It uses `stickyScroll`, `stickyStart="bottom"`, `viewportCulling={false}`, and a stored scrollbox ref. Scroll synchronization checks scroll height/viewport/top; the bottom action moves the existing box.

Preserve that identity through snapshot refreshes and streaming finalization. Do not key/remount the transcript on message count, text, or snapshot version to clear stale lines: recreation resets scroll state and native renderable lifecycle. Keyed resets appropriate for a wizard are not appropriate here. Normal navigation/empty-state transitions may still create or destroy the surface; this is not a claim that the box lives forever.

**Observed:** the [October 31 check](../verification/2026-10-31.md) recorded stable finalization without stale overlap. That does not prove every resize or long-history case. For regressions, inspect child identity, content sizing, clipping, and scroll synchronization; run the fake live scenario and manually inspect scroll position/resize as relevant. Content-marker assertions are not pixel-level proof against all ghosting.

## Locations, services, and storage

**Repository source:** [shared-service.ts](../../src/v2/shared-service.ts) reference-counts one Ensemble service/store through the registry used by [server.ts](../../src/v2/server.ts). OpenCode re-evaluates the plugin module for each location, so module-scoped state resets; the registry is a versioned `globalThis` symbol (ADR 0003). A multi-location probe with project + 4 channel + 8 agent locations produced 13 plugin loads and, before ticket #147, 13 service instances; after #147 it produces one `service.start`. It is not a cross-process singleton, distributed lock, or service directory.

[store.ts](../../src/v2/store.ts) syncs durable plugin state; [service.ts](../../src/v2/service.ts) discovers and reconciles workspace config on a serialized maintenance timer and before pump work, not during snapshot reads. Separate processes can still have separate in-memory state over shared storage. Compare canonical directory, agent IDs, workspace membership/leader, and [session bindings](../../GLOSSARY.md) as well as `.ensemble/config.json`; config membership uses names while stored membership uses IDs. Do not infer consistency merely from two matching snapshots of the same shared service.

**Source-backed and observed on 2.2.3:** the local managed-service descriptor is `${XDG_STATE_HOME:-$HOME/.local/state}/opencode/service.json`, not the remote/pairing config under the config directory. It may contain a password. Plain standalone `opencode serve` does not supply that managed descriptor; the harness manages its own connection details.

The snapshot RPC selects the location with `location[directory]` and supplies the same directory in its input. Its declared output is in [rpc.ts](../../src/v2/rpc.ts). The research probe observed only `state`, `models`, `skills`, and `directory`; do not rely on the service's internal `configError` surviving the declared output schema. Validate workspace config independently when diagnosing errors.

Snapshot is the supported read surface; its server-side path merges foreign storage but performs no writes, discovery, reconciliation, or purging. Maintenance runs on the service's serialized timer and before pump work. Avoid `invoke` for diagnosis. One descriptor targets one service; it cannot establish agreement with other processes without explicit connections to those processes. Do not read opaque storage internals, print descriptors/auth headers, restart unrelated services, or use real conversation data as fixtures.

Use the checked-in doctor rather than ad hoc credential-bearing probes:

```sh
npm run doctor -- /path/to/project /path/to/another-project
npm run --silent doctor -- --json --service-file /path/to/service.json /path/to/project
npm run doctor -- --server http://127.0.0.1:4096 /path/to/project
```

The [doctor reference](../../README.md#runtime-diagnosis) and `npm run doctor -- --help` define options, credential resolution, and exit codes. It queries one selected service sequentially, not atomically; config is read after each snapshot. Absent lazy bindings and retained former-member bindings alone are not defects. Treat differences as diagnostic evidence, not automatic proof of stale processes or a pre-reconciliation view.

## Three-pane workspace shell

**Repository source:** [workpane.ts](../../src/v2/tui/workpane.ts) owns
`workspacePaneWidths`, `workPaneBodyHeight`, ACTIVE/HISTORY filtering, and
pagination; [railmodel.ts](../../src/v2/tui/railmodel.ts) owns rail grouping;
[workfocus.ts](../../src/v2/tui/workfocus.ts) owns spatial navigation;
[workapprovals.ts](../../src/v2/tui/workapprovals.ts) owns the approvals
modes, workspace scope, and window budgets;
[picker.ts](../../src/v2/tui/picker.ts) owns native-session routing; and
[format.ts](../../src/v2/tui/format.ts) owns `alignedDetailRows`. The decision
and trade-offs are recorded in [ADR 0006](../adr/0006-three-pane-workspace-shell.md).

- The root row is Rail | Chat | Work. `workspacePaneWidths` is the only width
  function: the rail clamps to 26–34, Work takes a responsive share, and chat
  receives the remainder with a readable minimum. Breakpoints are ≥118
  (three panes), 96–117 (three panes, compact Work), and <96 (right drawer).
  `workPaneBodyHeight` is the matching body-height helper. Do not recompute
  either number in a consumer or test; the size matrix reads these helpers.
- Rail agents group by primary workspace (active, most recent membership,
  Homeless), each appears once, the subline is role only, and `z` or a header
  click toggles a durable collapse group. The Workspaces section is a separate
  pane. One cursor traverses the visible rows.
- Ticket #180 owns one pane select/interact state machine
  ([panefocus.ts](../../src/v2/tui/panefocus.ts)). Select chooses a pane with
  `h`/`l`/`j`/`k`; `Enter` enters it; `Esc` returns to select and never quits.
  Chat `Enter` is transcript navigation and `i` focuses the composer. `h` from
  chat selects Agents first, `j` selects Workspaces, and `l` reaches Work.
  Ticket #183 makes `Space b l`/`Space b r` the only column switches (durable
  UI state); `F3` is retired. Closing a focused column returns to chat
  selection, reopening selects the column's first pane without entering it.
- Ticket #184 partitions Work by **task**: ACTIVE keeps non-terminal tasks and
  HISTORY keeps terminal tasks, so one group can appear in both views with
  disjoint cards. HISTORY orders groups by latest finish, expands the newest
  group, rolls up older groups (`N done`, active count, age), and supports
  `Enter` expand, `x` dismiss, and `D` clear as a durable view filter. `h`/`l`
  at a row edge cross pages like `j`/`k`. A page-split group repeats its header
  with `cont.`.
- `workfocus.ts` emits card rectangles from the rendered sections and picks
  the nearest card in a direction with perpendicular tie-breaking. `j`/`k`
  at a page edge auto-page and preserve the horizontal column. Focus is keyed
  by task id or history-group id; updates, pagination, and filter changes keep
  it until the target disappears, then settle to the nearest prior position.
- A focused card uses the white `cardFocus` token; unfocused cards use the
  grey border token. The selected/interacting pane's border and heading are
  white, unselected panes stay grey, and `AGENTS`/`WORKSPACES` follow their own
  sub-pane. Pane focus and card focus are separate states.
- Approvals live only in the right column. Split mode pins a small summary
  under Work; `v` opens the full-height inbox from any pane (opening the right
  column first when needed), Enter from the small selection opens the same
  inbox, `j`/`k` move, `Enter` resolves, and `Esc` returns to split. Full
  approvals hide Work; closing the right pane hides both. Approvals are
  workspace-scoped and join the Tab cycle only while visible. The left footer,
  chat approvals modal, and `V` are retired.
- Chat keeps one aggregate activity line (`Asking $Name…`, `Working…`,
  `Retrying…`, `Queued…`, `+N more`) even while Work is open; there are no
  per-agent activity rows.
- Group-chat `o` opens the workspace-member native picker; Work `o` opens the
  focused card's assignee; DM `o` keeps the current agent. A missing binding
  toasts instead of doing nothing.
- Keep layout pure. Do not add timers, rebuild cards on focus, or introduce a
  second width/height helper. The existing one-shot Work invalidation timer
  remains the only clock for status, lease, retry, and hold transitions.

## Dispatch budgets and the ledger

**Repository source:** [dispatch-budget.ts](../../src/v2/dispatch-budget.ts) owns
the pure arithmetic; [store.ts](../../src/v2/store.ts) owns the serialized
admission mutation; [service.ts](../../src/v2/service.ts) owns the ordered
preflight, continuation routing, refusal copy, and dispatch log events; and
[tool-registrar.ts](../../src/v2/tool-registrar.ts) declares the required
`maxHops`. The trust model is recorded in [ADR 0004](../adr/0004-dispatch-budgets-and-continuation.md).

- Four layers: command (user), group (user root, leader continuation), task
  (`maxHops` per delegation/handoff), and depth (per group segment). Defaults
  are 24/8/8 with 8-hop tiers; settings live in `Settings.dispatch*` and are
  captured by each new root group. `settings.maxDepth` is deprecated and
  ignored for enforcement.
- A user command's recipients consume nothing. Each agent-created delegation
  or explicit handoff spends one hop. Completion handoffs, batch review,
  synthesis, peer turns, retries, restarts, recovery, and idempotent replays
  do not spend; cancellation never refunds.
- Creating work and spending the hop is one serialized store mutation. This is
  why one service per realm (ADR 0003) is a budget prerequisite: two writers
  could admit past the same cap.
- Only the workspace leader may open a continuation, only after the referenced
  group is exhausted, and only with a `groupMaxHops` tier that fits the
  command remaining and continuation count. The parent is sealed as
  `continued`; completion and other exempt rows may still save into it.
- Snapshot, scoped reads, the change feed, and `diagnostic` carry full
  dispatch-group entities. `diagnostic.dispatch` adds the compact counts for
  support. The Work header and compact row show the group/command budget; the
  Limits panel (`:limits` or the leader menu) edits the four user values for
  new commands only.

`dispatch` log rows carry IDs, counts, tiers, reason codes, and durations, never
task titles, instructions, paths, or conversation text. `logs:summary` reports
dispatch counts and `--group <id>` follows a root's continuation lineage. The
doctor adds ledger invariants: no group or command over its cap, a counter
never below its visible counted work (the unsafe direction; a higher counter
after terminal retention is allowed), command counters equal to the sum of
their groups, every continuation has a parent and reaches its root, and no
active continuation is empty. A budget stop is a controlled stop
(`FailureClass "budget"`, reason `budget-exhausted`), not a generic task
failure.

On upgrade, pre-ledger groups are synthesized on first access with used hops
equal to the existing counted work, caps at least at observed usage, and live
rows granted the group's remaining task budget. Reconciliation is bounded per
maintenance pass and logged as `dispatch.group.reconciled`; no in-flight work
is retroactively refused. The team contract is bumped and stale workspace
blocks are rewritten.

## Navigate installed package source

Run from the repository after `npm ci`:

```sh
node --version
opencode --version
npm ls @opencode/plugin @opentui/core @opentui/solid solid-js
```

Start with these installed files (not another developer's temporary probes):

| Question | Installed source/declarations |
| --- | --- |
| Page vs slot inputs, router, theme/context | `node_modules/@opencode/plugin/dist/tui/context.d.ts` |
| Plugin context binding | `node_modules/@opencode/plugin/dist/tui/solid.js` |
| Textarea events/buffer | `node_modules/@opentui/core/renderables/{Textarea,EditBufferRenderable}.d.ts` |
| Markdown and scroll options | `node_modules/@opentui/core/renderables/{Markdown,ScrollBox}.d.ts` |
| Style ownership/lifetime | `node_modules/@opentui/core/syntax-style.d.ts` |
| Solid intrinsic props/renderer | `node_modules/@opentui/solid/` |

Follow each package's `package.json` exports into shipped JS and source maps when declarations are insufficient. Package layouts can change; confirm paths locally. To inspect the CLI installation, use `command -v opencode` and `npm root -g`, then inspect the resolved installation's package metadata. A wrapper can select a different installation; a compiled CLI binary is not readable source. Neither a strings dump nor 2.2.1 declarations prove 2.2.3 internals. Use supported APIs and isolated live checks to resolve gaps rather than depending on private host implementation.

## TUI module graph and full client restart

The TUI plugin runs in each OpenCode client process, not in the service. A
service restart or a hot reload of [server.ts](../../src/v2/server.ts) does not
rebuild that client's module graph. After a TUI module move or export rename,
the client can keep importing the old location and log the stale export on each
reconciliation read.

**Observed (November 8, 2026):** after `skillPageItems` moved from
`src/v2/tui/bubbles.ts` to [skills.ts](../../src/v2/tui/skills.ts), a running
client logged repeated `plugin operation failed` warnings:
`Export named 'skillPageItems' not found in module .../tui/bubbles.ts`. The
server was already on the new module and a hot-reloaded TUI mount was clean; a
server-only restart would not have changed the client graph.

To clear a stale TUI module graph, **fully restart the client**:

1. Quit every OpenCode TUI client attached to the host (and any other client
   process that loads the TUI plugin), not only the service or `opencode serve`.
2. Confirm the client process exits. A new mount in the same process keeps the
   old module graph.
3. Start the client again and find the new `tui.mount` event in the Ensemble
   TUI log: `${XDG_STATE_HOME:-$HOME/.local/state}/ensemble/logs`.
4. Confirm no `plugin operation failed` warning naming the old module or export
   appears after that mount in `~/.local/share/opencode/log/opencode.log`.

Do not restart unrelated services or the sharing host as a diagnostic; the
client restart is the targeted remedy for a stale TUI graph.

## Verification gates

Use Node **26.4+** (the package engine), with Node/npm on `PATH`. `npm ci` installs the locked development dependencies. Run from the repository:

| Command | What it establishes |
| --- | --- |
| `npm run check` | Strict no-emit TypeScript check; no execution or host compatibility proof. |
| `npm test` | Existing behavioral unit suite; strips types rather than checking them. |
| `npm run verify` | Required local gate: check followed by unit tests. |
| `npm run test:live` | Real OpenCode/TUI acceptance against the available host/default model catalog. Record any skipped model-dependent portions. |
| `npm run test:live:fake` | Real host with deterministic local fake-provider streaming, rich output/finalization, stale-line markers, help, platform labels, and the ticket #177 three-pane/rail/picker/approvals/file-reference matrix; no API key/external model request. |
| `npm run test:live:fake:all` | Fake then empty-catalog scenarios in order; fails fast and prints a compact `PASS`/`FAIL`/`SKIP` summary. Deterministic fake-and-empty suite. |
| `npm run test:live:all` | The full local matrix: fake, empty catalog, then real host catalog. Same fail-fast summary; the real scenario is not deterministic and stays local. |
| `npm run test:live:latency` | Reproducible keypress-to-repaint probe on the isolated fake host: grouped rail `j`/`k` from `tmux send-keys` to the first capture showing the moved cursor, plus right-pane delegation-card appearance from `task.delegate` to the first capture showing the card title. Reports samples and percentiles; no threshold gate. |
| `npm run test:live:sizes` | Three-pane shell size matrix at 80×24, 100×30, 120×40, and 160×50 on the isolated fake host. Checks the right pane and the open-by-default 80×24 drawer with durable `Space b r` visibility and F3 removal, card/compact layout, ACTIVE pagination, spatial `hjkl` and page-edge `j`/`k`/`h`/`l`, the exact right edge, white/grey card focus borders, and per-pane heading/border focus from ANSI capture; records idle TUI CPU and CPU for one to three working cards, and runs a `NO_COLOR=1` still-motion check. Linux/tmux only. |
| `npm run test:live:lifecycle` | Full wall-clock fake lifecycle run: a ~5m40s stream crosses the old five-minute delivery deadline while heartbeats keep the 60s lease live, and an immediate backlog delivery stays pending past its own deadline before running. Also captures the doctor and structured log summary. Late-success, genuine interruption, and stalled/retrying labels remain service/TUI-seam tests (logged as skips). About six minutes. |
| `npm run test:live:probe` | Ticket #210's native host event-contract probe: records the real 2.2.6 event order and payload shapes for native turns, retry, interruption, attachments, synthetic messages, background subagents, move, and session-list scopes, then replays the committed fixture contract without a model. Privacy-gates the generated record before the contract test runs. |
| `npm run test:live:preflight` | Resolve and print the live Node/OpenCode/tmux versions; pass `all` to include the real scenario's `fd`. Missing tools follow the [skip-versus-fail contract](../../scripts/README.md#skip-versus-fail). |
| `ENSEMBLE_LIVE_KEEP=1 npm run test:live:fake` | Preserve this run's processes/files **on failure** for inspection; also works with `test:live`. Success still cleans up. |

See [the harness instructions](../../scripts/README.md) for prerequisites, binary overrides, isolation, timeouts, CI tool setup, exact cleanup, and the authoritative [skip-versus-fail contract](../../scripts/README.md#skip-versus-fail). The real scenario also needs `fd` and stays local. Preserved output lists the owned tmux sessions and fixture path; clean up only those artifacts and review logs for sensitive content before sharing. Documentation-only acceptance is content/link review, not a new test framework.

## Editing discipline

Use patch/direct file edits for source changes. If a multi-site scripted transformation is necessary, write a narrow temporary script outside tracked source, inspect its targets and expected match counts, and run it once. Review the resulting diff before continuing; stop on unexpected matches rather than rerunning a broad replacement. Prefer this to a large inline Python/shell heredoc whose quoting or partial execution is hard to audit.

Run `git diff --check` and inspect every changed file; run `npm run verify` after source edits and before handoff. Report exact commands, versions, skips, and unresolved runtime assumptions. Keep this guide as the reference rather than copying it into root instructions or issue comments.
