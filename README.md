# Ensemble

**Your persistent agent team, inside OpenCode.**

Ensemble is a TUI workspace where you and a team of named agents share one group chat, delegate visible subtasks, and inspect each agent's native OpenCode session underneath.

> **Status: developer preview.** The v2 runtime is the default. It is not published, versioned, or licensed. Tested against OpenCode 2.2.2.

## What it does

- **Three columns.** Agents sit above workspaces in the left rail, the selected chat is in the center with the composer pinned below it, and subtasks stay on the right.
- **Direct chats and group chats.** Selecting an agent opens its DM; selecting a workspace opens the group chat. Each agent has one native session per workspace, plus a no-workspace DM under `~/.ensemble/agents/<id>/`.
- **Workspaces are directories.** One workspace belongs to one project directory. Directory history restores the last chat, subtask, and focused column.
- **New agents start with no workspace.** Creating an agent opens a direct chat in its own `.ensemble` home. Add it to a workspace with `e` on the workspace; you can move its no-workspace session into the workspace.
- **The leader coordinates.** Unaddressed messages go to the workspace leader, who can answer or delegate typed subtasks.
- **Subtasks have three states:** Pending, Working, Replied.
- **Replies stream and stay readable.** Group and direct replies stream token by token, then settle into rich colored Markdown with author lines, tables, fenced code, headings, quotes, and links. The transcript keeps a stable scroll position, scrolls with `PageUp` / `PageDown`, and jumps to the newest reply with `End`.
- **Workspace config is human-editable.** `<workspace>/.ensemble/config.json` is authoritative for its name, leader, members, synthesis, and pause state. History stays in OpenCode storage, not the repository.
- **Init writes the team contract.** `I` or `/init` runs native `/init`, then places the versioned Ensemble block at the top of `AGENTS.md`.
- **Completions stay in the composer.** The composer is a wrapping textarea. `$`, `@`, and `/` open a bordered popup above it; typing filters, arrows move, Enter inserts or runs, and `Shift+Enter` adds a line. Workspace and agent creation use a centered multi-step wizard with Back/Next; member selection is a searchable checklist.
- **One modal grammar.** Normal, Insert, Visual, and Command modes are shared by the roster, chats, settings, wizards, and dialogs. `Esc` goes up a level and never quits; `Space` opens the leader menu and `?` opens the generated, searchable help catalog. No `Ctrl+letter` app shortcuts collide with macOS or Herdr.
- **Mentions and team work are explicit.** `$Name` addresses a teammate in chat, `@path` is file-only, and work is assigned through Ensemble tools. The agent contract includes the same rules.
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

## Keyboard

Ensemble starts in **Normal** and never leaves on `Esc`. Press `?` for the
generated, searchable help catalog; it is the source of truth for every
binding below.

| Key | Action |
|---|---|
| `j` / `k`, `gg` / `G` | Move rows or scroll; `Ctrl+d` / `Ctrl+u` move a half page |
| `h` / `l` | Move between the rail and the chat, or switch settings tabs |
| `Enter` | Open the selection, send, or confirm |
| `Tab` / `Shift+Tab` | Move focus zones (rail → chat → work list → composer) |
| `Esc` | Go up one level; it never quits |
| `i` | Focus the composer in Insert |
| `Space` | Leader key: which-key menu for create, edit, archive, delete, settings, approvals, pause/resume, init, native, delegate, reassign, retry, restart, cancel, leave, and help |
| `Space q` or `:q` | Leave Ensemble deliberately |
| `/` | Search the transcript or filter the focused list |
| `:` | Command line with completion and history |
| `?` | Full, searchable keyboard help |
| `n` / `N` | Next / previous search match |
| `F2` | Return to Ensemble from a native session |
| `a` / `n` | New agent / new workspace |
| `e` / `s` | Edit selection / agent settings |
| `x` / `X` | Archive / delete the selection (destructive actions confirm) |
| `p` / `I` | Pause or resume / init workspace files |
| `v` | Approvals inbox |
| `d` / `t` / `r` / `R` / `x` / `o` | Work list: delegate / reassign / retry / restart / cancel / native session |

In the **composer**, Insert mode sends with `Enter`, adds a line with
`Shift+Enter`, leaves to composer Normal with `Esc`, leaves immediately with
`Ctrl+G`, and stops running work with `Ctrl+C`. Composer Normal and Visual use
the documented Vim subset (`i a I A o O`, motions, `x`/`d`/`dd`/`D`,
`u`/`Ctrl+r`, `yy`/`p`/`P`, `v`/`V`). Each Workspace or Direct conversation
keeps its own draft. There are no `Ctrl+letter` app shortcuts beyond the
documented editor keys; the Leader is `Space`.

Settings use `h`/`l` for tabs, `j`/`k` for rows, `Enter` to edit or toggle,
`a`/`e`/`x` to add or remove, `Space` to toggle a skill, `p` to promote a
memory, `J`/`K` to reorder backups, `s` to save, `/` to filter, and `Esc` to
close. Press `i` to focus the bottom composer; the leader only acts when the
composer and dialogs are inactive. In the composer, `$Name` addresses an agent,
`@path` references a workspace file, and `/` opens Ensemble commands.

## Development

```bash
npm test
```

The unit suite covers routing, config discovery, workspace canonicalization, message sequencing, streaming, direct-chat queues, recovery, approvals, scheduling, init, reset, and reassignment races. `npm run test:live` boots an isolated OpenCode server and TUI to verify the packaged plugin, empty state, agent creation, direct chat, leader help, and composer completions. Live checks are recorded in [docs/verification/2026-11-05-v56.md](docs/verification/2026-11-05-v56.md).

### Runtime diagnosis

```sh
npm run doctor -- /path/to/project /path/to/another-project
npm run doctor -- --json --service-file /path/to/service.json /path/to/project
npm run doctor -- --server http://127.0.0.1:4096 /path/to/project
```

The doctor compares rosters, workspaces, member IDs, leaders, session bindings, and `.ensemble/config.json` membership. It exits `0` on agreement, `1` on divergence, or `2` on usage, connection, snapshot, or config-read failure. For a JSON-only stream without npm's script banner, use `npm run --silent doctor -- --json <directory> [...]`.

By default it reads `$XDG_STATE_HOME/opencode/service.json`, or `~/.local/state/opencode/service.json` when `XDG_STATE_HOME` is unset. `--service-file` overrides that path. `OPENCODE_PASSWORD` overrides the descriptor password. `--server` alone bypasses the descriptor and uses only `OPENCODE_PASSWORD`; it never sends an unrelated local password to the override URL. Combine `--server` with `--service-file` only for the same service. Descriptor PID/version/ID are reported metadata, not verified host identity. Credentials, conversation text, and memories are omitted from output.

**Snapshot-only, not an absolute no-write guarantee:** the doctor never calls `invoke`, writes files, repairs data, or changes service lifecycle. OpenCode may reconcile and persist workspace state while answering `snapshot`. Reports include this caveat. Bindings are created lazily and retained for former members, so their absence alone (or a retained former-member binding) is not a defect.

Every requested directory is queried on the **one selected service**, sequentially. Cross-location differences can reveal stale snapshots or concurrent changes, but this command does not discover or compare separate service processes. Config is read after each snapshot, so this is not an atomic pre-reconciliation view. Review remediation manually; the command does not apply it.

## Documentation

- [v2 implementation notes](docs/implementation.md)
- [v2 specification](https://github.com/heyimteee/ensemble/issues/17)
- [v2 tickets](https://github.com/heyimteee/ensemble/issues)
- [OpenCode compatibility report](docs/compatibility/opencode-2.2.1.md)
- [OpenTUI assessment](docs/assessments/opentui.md)
- [Glossary](GLOSSARY.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## License

A license has not been selected. Public repository visibility does not grant an open-source license.
