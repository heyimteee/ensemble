# OpenCode/OpenTUI runtime guide

Read before changing the TUI or host integration, or diagnosing location divergence. This is a navigation guide, not a new extension contract. Preserve the [compatibility boundaries](../../AGENTS.md#compatibility-boundaries).

## Evidence and versions

- **Declared API/source:** the lockfile installs `@opencode/plugin` **2.2.1** and OpenTUI **0.7.0** for checking. Inspect their declarations and shipped implementation using the paths below.
- **Observed runtime:** the November 1, 2026 probes used Node **26.12.1** and OpenCode **2.2.3**. The [v5.8 integration matrix](../verification/2026-11-05-v58.md) ran Node **26.12.1** with OpenCode **2.2.5** on Linux/tmux. CI now pins Node **26.12.1** and OpenCode **2.2.6** for the deterministic fake/empty live job. These are not the same as the pinned type-package version. The [v7 verification](../verification/2026-11-07-v7.md) ran Node **26.12.1** with OpenCode **2.2.6** on Linux/tmux. The [2.2.1 compatibility report](../compatibility/opencode-2.2.1.md) and [October 31 verification](../verification/2026-10-31.md) are historical, version-scoped evidence.
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

## Verification gates

Use Node **26.4+** (the package engine), with Node/npm on `PATH`. `npm ci` installs the locked development dependencies. Run from the repository:

| Command | What it establishes |
| --- | --- |
| `npm run check` | Strict no-emit TypeScript check; no execution or host compatibility proof. |
| `npm test` | Existing behavioral unit suite; strips types rather than checking them. |
| `npm run verify` | Required local gate: check followed by unit tests. |
| `npm run test:live` | Real OpenCode/TUI acceptance against the available host/default model catalog. Record any skipped model-dependent portions. |
| `npm run test:live:fake` | Real host with deterministic local fake-provider streaming, rich output/finalization, stale-line markers, help, and platform labels; no API key/external model request. |
| `npm run test:live:fake:all` | Fake then empty-catalog scenarios in order; fails fast and prints a compact `PASS`/`FAIL`/`SKIP` summary. Deterministic fake-and-empty suite. |
| `npm run test:live:all` | The full local matrix: fake, empty catalog, then real host catalog. Same fail-fast summary; the real scenario is not deterministic and stays local. |
| `npm run test:live:latency` | Reproducible keypress-to-repaint probe on the isolated fake host: rail `j`/`k` from `tmux send-keys` to the first capture showing the moved cursor, plus v7 delegation-card appearance from the `task.delegate` RPC to the first capture showing the card title. Reports samples and percentiles; no threshold gate. |
| `npm run test:live:sizes` | Targeted Work-card size matrix at 80×24, 100×30, 120×40, and 160×50 on the isolated fake host. Checks card/compact layout, overflow, focus, and composer; records idle TUI CPU and CPU for one to three working cards, and runs a `NO_COLOR=1` still-motion check. Linux/tmux only. |
| `npm run test:live:preflight` | Resolve and print the live Node/OpenCode/tmux versions; pass `all` to include the real scenario's `fd`. Missing tools follow the [skip-versus-fail contract](../../scripts/README.md#skip-versus-fail). |
| `ENSEMBLE_LIVE_KEEP=1 npm run test:live:fake` | Preserve this run's processes/files **on failure** for inspection; also works with `test:live`. Success still cleans up. |

See [the harness instructions](../../scripts/README.md) for prerequisites, binary overrides, isolation, timeouts, CI tool setup, exact cleanup, and the authoritative [skip-versus-fail contract](../../scripts/README.md#skip-versus-fail). The real scenario also needs `fd` and stays local. Preserved output lists the owned tmux sessions and fixture path; clean up only those artifacts and review logs for sensitive content before sharing. Documentation-only acceptance is content/link review, not a new test framework.

## Editing discipline

Use patch/direct file edits for source changes. If a multi-site scripted transformation is necessary, write a narrow temporary script outside tracked source, inspect its targets and expected match counts, and run it once. Review the resulting diff before continuing; stop on unexpected matches rather than rerunning a broad replacement. Prefer this to a large inline Python/shell heredoc whose quoting or partial execution is hard to audit.

Run `git diff --check` and inspect every changed file; run `npm run verify` after source edits and before handoff. Report exact commands, versions, skips, and unresolved runtime assumptions. Keep this guide as the reference rather than copying it into root instructions or issue comments.
