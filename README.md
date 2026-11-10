# Ensemble

**Your persistent agent team, inside OpenCode.**

Ensemble is a TUI workspace where you and a team of named agents share one group chat, delegate visible subtasks, and inspect each agent's native OpenCode session underneath.

> **Status: developer preview.** The v2 runtime is the default. It is not published, versioned, or licensed. Compatibility is recorded against OpenCode 2.2.1; the v5.8 live matrix was run on OpenCode 2.2.5.

> **Native-first decisions.** The conversation/session, ingestion, and mention-routing decisions for native-first coordination are recorded in [ADR 0009](docs/adr/0009-conversation-identity-and-sessions.md), [ADR 0010](docs/adr/0010-native-turn-ingestion.md), and [ADR 0011](docs/adr/0011-mention-routing-and-budgets.md). Product behavior follows in tickets #212–#227.

## What it does

- **Three panes.** The left rail splits into grouped Agents above Workspaces, the selected chat is in the center with the composer pinned below it, and a dedicated Work pane stays on the right. Below 118 columns the shell compacts; below 96 columns Work becomes a right drawer.
- **Direct chats and group chats.** Selecting an agent opens its DM; selecting a workspace opens the group chat. Each agent currently has one native session per workspace, plus a no-workspace DM under `~/.ensemble/agents/<id>/`; native-first separates these into one session per agent per conversation ([ADR 0009](docs/adr/0009-conversation-identity-and-sessions.md)).
- **Workspaces are directories.** One workspace belongs to one project directory. Directory history restores the last chat, task, and focused pane.
- **Agents group by workspace.** Each agent appears once under its primary workspace group (active workspace, then most recent membership, then Homeless). Group headers collapse with `z` or a click and the state survives restarts; the subline shows only the role.
- **New agents start with no workspace.** Creating an agent opens a direct chat in its own `.ensemble` home. Add it to a workspace with `e` on the workspace; you can move its no-workspace session into the workspace.
- **The leader coordinates.** Unaddressed messages go to the workspace leader, who can answer or delegate typed subtasks.
- **Work has an honest lifecycle:** pending, working, waiting, retrying, needs you, replied, failed, stalled, or cancelled. `Failed` is a real native execution error; `Stalled` is a delivery or lease problem and stays visible until retry, cancel, or dismissal. The Work pane starts in ACTIVE; each finished card moves to HISTORY as it finishes (`f`), even while its group still has live work. See [ADR 0005](docs/adr/0005-work-status-and-delivery-lease-separation.md).
- **Work is one spatial surface.** `hjkl` moves to the nearest card rather than a fixed column, and `j`/`k` at a page edge pages while keeping the column. Focus follows the task id across streaming, pagination, and filter changes. The focused card has a white border; unfocused cards stay grey, and the pane border is a separate focus state. Approvals stay sticky at the bottom of the pane (`v`), with the full inbox only for overflow (`V`). On a group chat, `o` asks which workspace member's native session to open; on a focused Work card it opens that card's assignee directly. See [ADR 0006](docs/adr/0006-three-pane-workspace-shell.md).
- **Replies stream and stay readable.** Group and direct replies stream token by token, then settle into rich colored Markdown with author lines, tables, fenced code, headings, quotes, and links. The transcript keeps a stable scroll position, scrolls with `PageUp` / `PageDown`, and jumps to the newest reply with `End`.
- **Workspace config is human-editable.** `<workspace>/.ensemble/config.json` is authoritative for its name, leader, members, synthesis, and pause state. History stays in OpenCode storage, not the repository.
- **Init writes the team contract.** `I`, `:init`, or `/init` appends a visible `/init` line and starts a System Agent init job. Progress streams into the chat and finalizes into a report; on success Ensemble writes the versioned block at the top of `AGENTS.md` and `.ensemble/init.json`, and on failure it restores the previous `AGENTS.md`. Init is solo-only and workspace-only, and the composer never falls through to native `/init`.
- **Completions stay in the composer.** The composer is a wrapping textarea. `$`, `@`, and `/` open a bordered popup above it; typing filters, arrows move, Enter inserts or runs, and `Shift+Enter` adds a line. Workspace and agent creation use a centered multi-step wizard. List steps take `j`/`k`, `Enter`, `Space`, `/`, and `Esc`; text steps use the shared editor grammar. Move between steps with `n` next and `N` previous; `Esc` cancels, with a discard confirm when the draft is dirty. The optional memories step lists entries one by one with `a` add, `e` edit, and `x` delete.
- **One modal grammar, one persistent mode.** Normal, Insert, Visual, and Command are global interaction states shared by the roster, chats, settings, wizards, and dialogs. Focus moves, overlays, wizard steps, and surface changes never change the mode; only explicit mode keys do, and `Enter` never does. Every text editor uses the same caret: a block in Normal, a line in Insert, Visual, and Command, and no caret when unfocused. `Esc` goes up one level and never quits; `Ctrl+G` leaves the focused editor and sets Normal. Leaving Ensemble hands the keyboard back to OpenCode immediately, so typing and `/` work in the native prompt without an `Esc`; `F2` returns. The two-row statusline uses typed segments (mode chip, context, git, position, hints) and faint `│` chrome separators with an ASCII `|` fallback. `Space` opens the leader menu and `?` opens the generated, searchable help catalog. App bindings are designed to avoid `Ctrl+letter` collisions with macOS and Herdr, but that intent has not been verified on a macOS/Herdr host; see the remaining limits in the v5.8 verification record.
- **Mentions and team work are explicit.** `$Name` addresses a teammate in chat, `@path` is file-only, and work is assigned through Ensemble tools. The agent contract includes the same rules.
- **Dispatch budgets are explicit and layered.** Every delegation and handoff requires `maxHops`, the direct dispatches the recipient may make (`0` is a one-shot ask). A command budget bounds all groups for one user command, a group budget bounds one relay segment, and depth bounds the ancestor chain. Defaults are 24/8/8 in 8-hop tiers. Work headers and tool results show used and left, an exhausted group is a controlled stop rather than a failure, and only the leader can open a linked continuation group inside the command remaining. `:limits` edits group hops, command hops, depth, and continuations for new commands; structured dispatch logs carry IDs, counts, and reason codes without task text, and the doctor verifies ledger invariants. See [ADR 0004](docs/adr/0004-dispatch-budgets-and-continuation.md).
- **Skills are deliberate.** `/` at message start lists commands and every catalog skill with `Command`, `Skill | General`, or `Skill | <Owner>` flags; `$Agent /` lists only that agent's assigned skills. Assigned skills stay with their owner, General skills go to the leader for triage, and multiple `/skill` tokens for one agent group into one prompt carrying the exact user text. Invalid references reject the whole message and keep the draft. The built-in `/init` row is a General system executor, not a host skill.
- **One team state across locations.** All OpenCode locations share the same Ensemble roster, workspace membership, and bindings; config remains authoritative.
- **Skillboxes and models are per-agent.** Only assigned skills are available; backup models recover from availability failures.
- **Memory and approvals are scoped.** Project memory, workspace memory, and global memory have provenance and approval rules.
- **Work continues through OpenCode's server** after the Ensemble page closes.

## Install for local development

Add the repository to `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/home/you/dev/ensemble"]
}
```

Run `/ensemble` or the **Open Ensemble** palette command. Do not also load the same plugin from `.opencode/plugins/`; that creates a duplicate plugin ID.

If the plugin was already loaded before updating the package exports, run `opencode reload` or restart the OpenCode service.

Upgrading from a pre-ledger workspace synthesizes dispatch groups on first
access: used hops come from the existing non-completion delegations and
handoffs, caps are raised to at least observed usage, and live rows that lack a
task budget receive the group's remaining budget. In-flight work is not retroactively refused;
reconciliation is logged. `settings.maxDepth` is deprecated and ignored for
enforcement; depth now comes from `dispatchDepth` per group. Stale Ensemble
blocks in workspace instruction files are rewritten at contract v4. See
[ADR 0004](docs/adr/0004-dispatch-budgets-and-continuation.md).

## Keyboard

Ensemble starts in **Normal** and never leaves on `Esc`. Press `?` for the
generated, searchable help catalog; it is the source of truth for every
binding below. The mode is global: opening a dialog, moving focus, or changing
a wizard step never changes it. Only explicit mode keys do, and `Enter` never
does. Text editors show a block caret in Normal and a line caret in Insert,
Visual, and Command; an unfocused editor shows no caret.

| Key | Action |
|---|---|
| `j` / `k`, `gg` / `G` | Move rows or scroll; `Ctrl+d` / `Ctrl+u` move a half page |
| `h` / `l` | Move between the rail and the chat, move spatially between Work cards, or switch settings tabs |
| `Enter` | Enter the selected pane; inside it open the focused result, resolve the focused approval, send, or confirm |
| `Tab` / `Shift+Tab` | Cycle visible panes (rail → chat → work → approvals), skipping absent or closed ones; selection never enters content, and `i` focuses the composer |
| `Esc` | Go up one level; it never quits |
| `Ctrl+G` | Leave the focused editor and set Normal |
| `i` | Focus the composer or current text field in Insert |
| `Space` | Leader key: which-key menu for create, edit, archive, delete, settings, approvals, pause/resume, init, native, delegate, reassign, retry, restart, cancel, leave, and help |
| `Space b l` / `Space b r` | Toggle the left rail / right Work column at every width; visibility survives restarts |
| `Space q` or `:q` | Leave Ensemble deliberately; the native prompt owns keys immediately, including `/`, and `F2` returns |
| `/` | Search the transcript or filter the focused list |
| `:` | Command line with completion and history |
| `?` | Full, searchable keyboard help |
| `n` / `N` | Next / previous search match |
| `F2` | Return to Ensemble from a native session |
| `a` / `n` | New agent / new workspace |
| `e` / `s` | Edit selection / agent settings |
| `x` / `X` | Archive / delete the selection (destructive actions confirm) |
| `p` / `I` | Pause or resume / init workspace files |
| `z` | Collapse or expand the focused rail group |
| `f` | Toggle the Work pane between ACTIVE and HISTORY |
| `v` | Open full-height right-column approvals from any pane; Enter from the small summary opens the same view, and `Esc` returns to split |
| `d` / `t` / `r` / `R` / `x` / `o` | Focused Work card: delegate / reassign / retry / restart / cancel / native session |

In the **composer**, Insert mode sends with `Enter`, adds a line with
`Shift+Enter`, leaves to composer Normal with `Esc`, leaves immediately with
`Ctrl+G`, and stops running work with `Ctrl+C`. The editor keeps focus in
composer Normal so the block caret stays visible; the raw key owner prevents
typing. Composer Normal and Visual use the documented Vim subset
(`i a I A o O`, motions, `x`/`d`/`dd`/`D`, `u`/`Ctrl+r`, `yy`/`p`/`P`, `v`/`V`).
Each Workspace or Direct conversation keeps its own draft. There are no
`Ctrl+letter` app shortcuts beyond the documented editor keys; the Leader is
`Space`. The macOS/Herdr shortcut check is still unperformed, so treat the
collision-free intent as unverified there.

Settings use `h`/`l` for tabs, `j`/`k` for rows, `Enter` to edit or toggle,
`a`/`e`/`x` to add or remove, `Space` to toggle a skill, `p` to promote a
memory, `J`/`K` to reorder backups, `s` to save and close Settings, `/` to
filter, and `Esc` to close. A successful save confirms once in the app toast
after the surface closes. Memory add/edit uses the same persistent field as
the wizard: `Enter` saves and keeps the field focused, an add clears for the
next entry, and `Esc` returns to the rows. Press `i` to focus the bottom composer; the leader only
acts when the composer and dialogs are inactive. In the composer, `$Name`
addresses an agent, `@path` references a workspace file, and `/` opens Ensemble
commands or the skill palette. At message start `/` shows commands and every
skill; `$Agent /` shows only that agent's assigned skills, and General skills
are hidden under a non-leader mention. A General skill routes to the leader for
triage; `/init` is solo-only and workspace-only. A rejected skill or agent
reference keeps the draft and names the exact problem to fix.

`:limits` (or the leader menu) opens the workspace dispatch limits panel:
`j`/`k` select, `h`/`l` change, `Enter` saves, and `Esc` cancels. Group hops
use 8/16/24; command hops use 8/16/24/32/40/48; depth uses 1–16; continuations
use 0–5. The panel rejects a command below its group and a continuation count
that cannot fit the smallest groups. Changes apply to new commands only.

Wizard steps open in the mode you arrived with. `n` next, `N` previous, and
`Enter` advance or select; `Esc` in a text field goes to field Normal, and the
next `Esc` cancels (asking first when the draft is dirty). On the memories step,
`j`/`k` select, `a` adds, `e` edits, and `x` deletes. In Insert, `Enter` saves
the current memory and clears the add field while keeping it focused, so
several memories can be entered in succession. Each list entry is saved as its
own agent memory on creation; an empty list skips cleanly.

## Development

```bash
npm test
```

The unit suite covers routing, config discovery, workspace canonicalization, message sequencing, streaming, direct-chat queues, recovery, approvals, scheduling, init jobs, skill invocation planning, one-run leader grants, reset, reassignment races, dispatch budget arithmetic and refusal order, continuation validation, and legacy ledger reconciliation, plus the interaction reducer's persistent mode, caret mapping, wizard navigation/memory list, statusline segments/contrast, and page-activation route gate. The fake multi-location harness adds a five-hop relay, a nine-hop continuation, and an 8-hop command-cap stop after its measured 100-request path. `npm run test:live:fake` runs the deterministic fake provider and covers the v5.8 System Agent init progress/report, `/init` audit lines, `|` skill flags, assigned-skill invocation, grouped skills, multi-agent and mixed anchors, leader triage, and validation errors. `npm run test:live:fake:empty` covers the empty model catalog. `npm run test:live:fake:all` runs those two in order with a fail-fast summary; `npm run test:live:all` adds the real host-catalog scenario. `npm run test:live` boots an isolated OpenCode server and TUI against the real host catalog to verify the packaged plugin, empty state, agent creation, direct chat, leader help, and composer completions. `npm run test:live:latency` reports reproducible keypress-to-repaint samples from the isolated fake host. `npm run test:live:sizes` covers the three-pane shell at 80×24, 100×30, 120×40, and 160×50, and `npm run test:live:lifecycle` runs a full wall-clock five-minute-plus lease/heartbeat and queue-backlog scenario. Live checks are recorded in [docs/verification/2026-11-09-workspace-v2.md](docs/verification/2026-11-09-workspace-v2.md).

### Runtime diagnosis

```sh
npm run doctor -- /path/to/project /path/to/another-project
npm run doctor -- --json --service-file /path/to/service.json /path/to/project
npm run doctor -- --server http://127.0.0.1:4096 /path/to/project
```

The doctor compares rosters, workspaces, member IDs, leaders, session bindings, and `.ensemble/config.json` membership. It also validates dispatch ledger invariants: no group or command over its cap, a group counter never below its visible counted work, command counters equal to the sum of their groups, every continuation has a parent and reaches its root, and no active continuation is empty. A higher counter after terminal retention is allowed. It exits `0` on agreement, `1` on divergence, or `2` on usage, connection, snapshot, or config-read failure. For a JSON-only stream without npm's script banner, use `npm run --silent doctor -- --json <directory> [...]`.

By default it reads `$XDG_STATE_HOME/opencode/service.json`, or `~/.local/state/opencode/service.json` when `XDG_STATE_HOME` is unset. `--service-file` overrides that path. `OPENCODE_PASSWORD` overrides the descriptor password. `--server` alone bypasses the descriptor and uses only `OPENCODE_PASSWORD`; it never sends an unrelated local password to the override URL. Combine `--server` with `--service-file` only for the same service. Descriptor PID/version/ID are reported metadata, not verified host identity. Credentials, conversation text, and memories are omitted from output.

**Snapshot-only, not an absolute no-write guarantee:** the doctor never calls `invoke`, writes files, repairs data, or changes service lifecycle. OpenCode may reconcile and persist workspace state while answering `snapshot`. Reports include this caveat. Bindings are created lazily and retained for former members, so their absence alone (or a retained former-member binding) is not a defect.

Every requested directory is queried on the **one selected service**, sequentially. Cross-location differences can reveal stale snapshots or concurrent changes, but this command does not discover or compare separate service processes. Config is read after each snapshot, so this is not an atomic pre-reconciliation view. Review remediation manually; the command does not apply it.

## Documentation

- [v2 implementation notes](docs/implementation.md)
- [ADR index](docs/adr/README.md): every accepted architecture decision
- [ADR 0004: dispatch budgets and continuation](docs/adr/0004-dispatch-budgets-and-continuation.md)
- [ADR 0009: conversation identity and sessions](docs/adr/0009-conversation-identity-and-sessions.md)
- [ADR 0010: native turn ingestion](docs/adr/0010-native-turn-ingestion.md)
- [ADR 0011: mention routing and budgets](docs/adr/0011-mention-routing-and-budgets.md)
- [Native host event contract](docs/verification/2026-11-10-native-host-contract.md)
- [Workspace v2 verification](docs/verification/2026-11-09-workspace-v2.md)
- [Dispatch budget verification](docs/verification/2026-11-08-dispatch-budgets.md)
- [v5.8 verification record](docs/verification/2026-11-05-v58.md)
- [v5.7 verification record](docs/verification/2026-11-05-v57.md)
- [v2 specification](https://github.com/heyimteee/ensemble/issues/17)
- [v2 tickets](https://github.com/heyimteee/ensemble/issues)
- [OpenCode compatibility report](docs/compatibility/opencode-2.2.1.md)
- [OpenTUI assessment](docs/assessments/opentui.md)
- [Glossary](GLOSSARY.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## License

A license has not been selected. Public repository visibility does not grant an open-source license.
