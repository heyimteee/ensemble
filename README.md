# Ensemble

**Your persistent agent team, inside OpenCode.**

Ensemble is a TUI workspace where you and a team of named agents share one group chat, delegate visible subtasks, and inspect each agent's native OpenCode session underneath.

> **Status: developer preview.** The v2 runtime is the default. It is not published, versioned, or licensed. Tested against OpenCode 2.2.1.

## What it does

- **Workspaces are directories.** One workspace belongs to one project directory. Switching workspaces preserves every session.
- **The group chat is the main interface.** User and agent messages are attributed with names, colors, and the leader badge.
- **The leader coordinates.** Unaddressed messages go to the workspace leader, who can answer or delegate typed subtasks.
- **Subtasks have three states:** Pending, Working, Replied.
- **Native sessions stay underneath.** Each agent has one persistent session per workspace; press `o` to inspect it.
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
| `i` | Compose a message |
| `m` | Mention an agent and compose |
| `/` | Search workspaces |
| `n` | New workspace |
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
| `Ctrl+S` | Save settings |
| `Space` | Toggle skill in Skillbox |
| `Ctrl+F` | Filter skills |
| `Esc` | Back or cancel |

A literal `~` typed in a dialog or message stays text. The leader key only acts when no dialog or text entry is active.

## Development

```bash
npm test
```

The unit suite covers mention routing, workspace canonicalization, message sequencing, recovery, approvals, scheduling, and reassignment races. `npm run test:live` boots an isolated OpenCode server and TUI to verify the packaged plugin and leader help. Live checks are recorded in [docs/verification/2026-10-30.md](docs/verification/2026-10-30.md).

## Documentation

- [v2 implementation notes](docs/implementation.md)
- [v2 specification](https://github.com/heyimteee/ensemble/issues/17)
- [v2 tickets](https://github.com/heyimteee/ensemble/issues)
- [OpenCode compatibility report](docs/compatibility/opencode-2.2.1.md)
- [Glossary](GLOSSARY.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## License

A license has not been selected. Public repository visibility does not grant an open-source license.
