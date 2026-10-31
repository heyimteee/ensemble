# Ensemble

**Your persistent agent team, inside OpenCode.**

Ensemble is a TUI workspace where you and a team of named agents share one group chat, delegate visible subtasks, and inspect each agent's native OpenCode session underneath.

> **Status: developer preview.** The v2 runtime is the default. It is not published, versioned, or licensed. Tested against OpenCode 2.2.2.

## What it does

- **Three columns.** Agents sit above workspaces in the left rail, the selected chat is in the center with the composer pinned below it, and subtasks stay on the right.
- **Direct chats and group chats.** Selecting an agent opens its DM; selecting a workspace opens the group chat. Each agent has one native session per workspace, plus a homeless DM under `~/.ensemble/agents/<id>/`.
- **Workspaces are directories.** One workspace belongs to one project directory. Directory history restores the last chat, subtask, and focused column.
- **New agents start homeless.** Creating an agent opens a direct chat in its own `.ensemble` home. Add it to a workspace with `g`; you can move its homeless session into the workspace.
- **The leader coordinates.** Unaddressed messages go to the workspace leader, who can answer or delegate typed subtasks.
- **Subtasks have three states:** Pending, Working, Replied.
- **Replies stream and stay readable.** Group and direct replies stream token by token, then settle into rich colored Markdown with author lines, tables, fenced code, headings, quotes, and links. The transcript keeps a stable scroll position, scrolls with `PageUp` / `PageDown`, and jumps to the newest reply with `End`.
- **Workspace config is human-editable.** `<workspace>/.ensemble/config.json` is authoritative for its name, leader, members, synthesis, and pause state. History stays in OpenCode storage, not the repository.
- **Init writes the team contract.** `I` or `/init` runs native `/init`, then places the versioned Ensemble block at the top of `AGENTS.md`.
- **Completions stay in the composer.** The composer is a wrapping textarea. `$`, `@`, and `/` open a bordered popup above it; typing filters, arrows move, Enter inserts or runs, and `Shift+Enter` adds a line. Workspace and agent creation use a centered multi-step wizard with Back/Next; member selection is a searchable checklist.
- **Platform-native shortcuts.** macOS uses Cmd for every Ctrl shortcut and displays `Cmd`; Windows/Linux keep `Ctrl`. `~ ?` opens a searchable, scrollable reference with every shortcut.
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

| Key | Action |
|---|---|
| `~` | Leader key |
| `~ ?` | Full shortcut help |
| `~ q` | Leave Ensemble for the native TUI |
| `h` / `l` | Move focus left / right between columns |
| `j` / `k` | Move selection down / up |
| `Enter` | Open the selected agent or workspace |
| `i` | Focus the composer |
| `$` | Insert an agent mention in the composer |
| `@` | Reference a workspace file in the composer |
| `/` | Ensemble command palette in the composer; workspace search when not composing |
| `p` | Pause or resume the workspace |
| `I` | Init Ensemble in the current workspace |
| `n` | New workspace |
| `g` | Edit workspace members / leader |
| `w` / `W` | Next / previous workspace |
| `a` | New agent |
| `z` / `Z` | Next / previous agent |
| `s` | Agent settings |
| `v` | Approvals inbox |
| `d` | Delegate selected subtask |
| `t` | Reassign selected subtask |
| `Enter` | Open the selected subtask result |
| `r` | Retry selected subtask |
| `R` | Stop and restart selected subtask |
| `x` | Cancel selected subtask |
| `o` | Open the selected agent's native session |
| `Tab` | Cycle settings tabs |
| `e` | Edit the selected setting |
| `Ctrl+S` / `Cmd+S` on macOS | Save settings |
| `Space` | Toggle skill in Skillbox |
| `Ctrl+F` / `Cmd+F` on macOS | Filter skills |
| `PageUp` / `PageDown` | Scroll the transcript |
| `Esc` | Back or cancel |

On macOS, every `Ctrl` shortcut is `Cmd` and the TUI displays `Cmd` instead of `Ctrl`.

A literal `~` typed in the composer or a dialog stays text. The leader key only acts when the composer and dialogs are inactive. Press `i` to focus the bottom composer; `Esc` cancels it. In the composer, `$Name` addresses an agent, `@path` references a workspace file, and `/` opens Ensemble commands.

## Development

```bash
npm test
```

The unit suite covers routing, config discovery, workspace canonicalization, message sequencing, streaming, direct-chat queues, recovery, approvals, scheduling, init, reset, and reassignment races. `npm run test:live` boots an isolated OpenCode server and TUI to verify the packaged plugin, empty state, agent creation, direct chat, leader help, and composer completions. Live checks are recorded in [docs/verification/2026-10-30.md](docs/verification/2026-10-30.md).

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
