# Ensemble v2 implementation

Status: **developer preview**, tested against OpenCode 2.2.1. The v2 runtime is the default. The v1 preview was removed.

## Architecture

```text
Ensemble TUI workspace page
  workspace rail · group chat · subtask board · settings · approvals
                         │
                  typed RPC + events
                         │
Ensemble server plugin
  workspace registry · roster · task graph · scheduler
  memory · approvals · session bindings · recovery
                         │
                  native session API
                         │
OpenCode engine
  sessions · models · tools · providers · permissions · skills
```

### Components

- **`src/v2/tui`** — full-screen plugin page. Workspace rail, group chat, subtask board, settings, approvals, leader key.
- **`src/v2/service.ts`** — domain service and orchestrator. Workspaces, agents, messages, subtasks, delegation, approvals, memory, model fallback, scheduling, recovery.
- **`src/v2/execution.ts`** — pure execution helpers: model availability, tool-call inspection, prompt/context assembly, memory formatting, Skillbox permissions.
- **`src/v2/tui/`** — page shell, presentational components, palette, formatting, and keymap layers.
- **`src/v2/store.ts`** — durable state in OpenCode plugin storage, keyed per agent, workspace, message, subtask, binding, memory, and approval.
- **`src/v2/routing.ts`** — `@`/`!` mention routing and leader fallback.
- **`src/v2/paths.ts`** — canonical workspace directories.

Every execution is a native OpenCode session. Ensemble does not replace tools, providers, permissions, or skills.

## Workspaces

A workspace is the directory-bound project room:

```ts
Workspace {
  id, name, directory,
  leaderID, memberIDs,
  synthesis, archived, nextSeq,
  createdAt, lastActiveAt
}
```

- One canonical directory maps to one active workspace.
- Switching workspace changes the group chat, task board, and directory for new runs.
- Sessions are bound to `workspace + agent`, so switching does not discard them.

The directory picker uses `fd` to enumerate directories and fuzzy filtering in the TUI. Recent workspace directories come first, `~/` expands, and manual paths are supported. The workspace rail groups rooms by canonical project directory, supports `/` search, and shows unread (`●`) and busy (`◐`) markers. The selected workspace is persisted and restored when the page reopens.

## Agents

An agent is a reusable profile:

```ts
Agent {
  id, name, title, role,
  mainModel, backupModels,
  skillbox, color,
  archived, pendingSettings, version
}
```

- General, Models, Memories, and Skillbox settings.
- Main model and supported reasoning; ordered backups.
- Exclusive Skillbox enforced with per-session `skill` permissions.
- Behavior changes bump the version and create a new native session for subsequent work. Renaming does not.
- `pendingSettings` is cleared when the new session is created.

## Group chat

The transcript is shared and attributed:

```ts
Message {
  id, workspaceID, seq,
  author: "user" | "agent" | "system",
  agentID?, text, kind, taskID?, createdAt
}
```

- `@Name` is primary; `!Name` is an alias.
- Multiple known mentions create one task per recipient.
- No mention routes only to the leader.
- Unknown `@Name`/`!Name` values fail with a clear `unknown_member` error instead of silently falling back.
- `m` opens a member picker and composes an addressed message.
- Agent replies and task cards appear in the same transcript.
- Native sessions are not alternate chat tabs; `o` opens the selected agent's session.

## Subtasks

```ts
Subtask {
  id, workspaceID, parentID?,
  creatorType, creatorAgentID?, assigneeID?,
  title, instruction, constraints?, expected?,
  mode: "research" | "edit",
  state: "pending" | "working" | "replied",
  outcome, stage, interrupted, approvalID?,
  resultMessageID?, error?, attempts
}
```

```text
pending ──assign──▶ working ──result──▶ replied
   │                   │
   └────cancel─────────┴────cancel──────▶ removed
```

- Failed replies stay **Replied** with a failed outcome.
- Approval waits are badges on **Working**, not a fourth state.
- The leader delegates through the `ensemble_delegate` tool with a typed envelope.
- When all children reply, a leader synthesis subtask is created unless the workspace disables synthesis.
- The board groups Pending, Working, and Replied. `d` delegates, `t` reassigns, `Enter` opens the result, `r` retries, `R` stops and restarts, `x` cancels, and `o` opens the run.
- Reassignment and restart interrupt the active run and clear its run token, so a late reply from the stopped run cannot overwrite the new assignee.

## Scheduling and recovery

- Default three active runs.
- One active run per agent per workspace.
- One editing run per canonical directory; research can continue.
- Closing the Ensemble page does not stop native work.
- On restart, working subtasks return to Pending with an interrupted badge and an `interrupted` approval. They never replay automatically; the user resumes or discards them.
- Model fallback uses the ordered backup list and surfaces switches.
- Permission denials, tool failures, and provider exhaustion pause the subtask with an interrupted approval; an uncertain tool outcome is never retried automatically.
- Message sequence numbers are allocated inside the store, so concurrent appends cannot overwrite a transcript key.

## Memory and approvals

Memory scopes:

- **project** — agent + workspace
- **workspace** — shared with all workspace members
- **global** — agent across workspaces, approval-gated when promoted

Entries record origin (`automatic`/`manual`), source, and history. Deleting a memory excludes it from future retrieval but does not erase native transcripts.

Approvals cover:

- `ask_person`
- outside-roster delegation
- memory promotion
- cross-project/private transcript sharing
- interrupted work

Approvals appear inline in the chat and in the inbox. Resolutions are idempotent: repeating the same decision returns the resolved approval, while a conflicting decision fails with `already_resolved`. Only the user can approve. Approving interrupted work resumes it once; discarding marks it failed.

## Leader key

- `~` enters leader mode outside text entry.
- `~ ?` opens the full grouped shortcut list.
- `~ q` leaves Ensemble for the native TUI.
- `Esc` cancels leader mode.
- `~` inside a dialog or message remains text.

## Ticket map

| Ticket | Implementation |
|---|---|
| #18 | OpenCode navigation/native-session validation |
| #19 | Native-like workspace shell and leader key |
| #20 | Directory-bound workspaces and `fd` picker |
| #21 | Agent roster and settings |
| #22 | Group chat, leader routing, mentions |
| #23 | Subtask board, delegation, synthesis |
| #24 | Native-session drill-down and run detail |
| #25 | Memory and approvals |
| #26 | Queues, concurrency, editing locks, recovery |
| #27 | Skillboxes and model fallback |
| #28 | Archive/delete, migration, v2 switch, v1 removal |
| #29 | Acceptance and verification |

## Known limitations

- The group chat composer is a dialog opened with `i`, not an inline focused input.
- Mention selection uses `m` plus a member picker; there is no inline autocomplete inside the text prompt.
- Direct one-to-one conversations are not implemented in the v2 TUI; a one-member workspace is not treated as a DM.
- Some host dialog closes leave stale cells until the next full repaint; the page remains usable.
- No npm package, versioning policy, or license has been selected.
