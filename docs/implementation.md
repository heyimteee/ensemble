# Ensemble v2 implementation

Status: **developer preview**, tested against OpenCode 2.2.2. The v2 runtime is the default. The v1 preview was removed.

## Architecture

```text
Ensemble TUI workspace page
  agents + workspaces rail · direct/group chat · subtask board · settings · approvals
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

- **`src/v2/service.ts`** — domain service and orchestrator. Workspaces, agents, messages, subtasks, delegation, approvals, memory, model fallback, scheduling, recovery.
- **`src/v2/catalog.ts`** — model/skill catalog refresh with a timeout guard.
- **`src/v2/execution.ts`** — pure execution helpers: model availability, tool-call inspection, prompt/context assembly, memory formatting, Skillbox permissions.
- **`src/v2/tui/`** — page shell, presentational components, palette, formatting, and keymap layers.
- **`src/v2/store.ts`** — durable state in OpenCode plugin storage, keyed per agent, workspace, message, subtask, binding, memory, and approval.
- **`src/v2/routing.ts`** — `$`/`!` mention routing and leader fallback.
- **`src/v2/paths.ts`** — canonical workspace directories and file references.
- **`src/v2/workspace-config.ts`** — `.ensemble/config.json`, handoff paths, `.gitignore`, AGENTS.md insertion.
- **`src/v2/init-block.ts`** — the versioned AGENTS.md team contract.

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
- Switching workspace changes the chat, task board, and directory for new runs.
- Sessions are bound to `workspace + agent`, so switching does not discard them.
- `<workspace>/.ensemble/config.json` is authoritative for workspace name, leader, members, synthesis, and paused state. OpenCode storage remains authoritative for agents, messages, subtasks, approvals, memories, bindings, and history.
- Valid config files discovered in a directory register a workspace automatically; invalid config is rejected and the last good state is kept.
- `.ensemble/` is created when a workspace is created, is added to `.gitignore`, and contains only config, handoffs, and init metadata. Conversation history stays in OpenCode storage.

The directory picker uses `fd` to enumerate directories and fuzzy filtering in the TUI. Recent workspace directories come first, `~/` expands, and manual paths are supported. The workspace rail groups workspaces by canonical project directory, supports `/` search, and shows unread (`●`), busy (`◐`), and paused (`⏸`) markers. The selected workspace and subtask are persisted and restored when the page reopens.

A workspace can be paused with `p`; paused workspaces reject new work until resumed. Automatic leader synthesis is chosen when the workspace is created.

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

- New agents start homeless. Their native DM session lives under `~/.ensemble/agents/<id>/`.
- Adding an agent to a workspace can move its homeless session with `session.move`; `g` edits members and the leader without recreating the workspace.
- Agent names are unique and case-insensitive.
- General, Models, Memories, and Skillbox settings.
- Main model and supported reasoning; ordered backups can be added, moved, and removed.
- Exclusive Skillbox enforced with per-session `skill` permissions.
- Automatic leader synthesis is chosen when a workspace is created.
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

- `$Name` is primary; `!Name` is an alias. `@` is reserved for file references.
- Multiple known mentions create one task per recipient.
- No mention routes only to the leader.
- Unknown `$Name`/`!Name` values fail with a clear `unknown_member` error instead of silently falling back.
- `i` focuses an inline bottom composer. `$` opens an agent picker and inserts a stable `$Name` reference; `@` opens a workspace file picker; `/` opens the Ensemble command palette. `m` is the keyboard shortcut for the agent picker.
- File references are resolved inside the workspace and appended to the subtask instruction. `@` is not a mention.
- Agent replies and task cards appear in the same transcript.
- Group replies stream into one growing message row and finalize as full Markdown.
- Direct chats render the native OpenCode transcript in the center column. `o` opens that native session as a normal OpenCode route.
- Selecting an agent opens its DM; selecting a workspace opens the group chat. The empty state appears when no chat is open.

## Direct chats and sessions

- Every agent has a direct chat. If the agent belongs to the active workspace, the DM uses that workspace’s native session; otherwise it uses a homeless session in `~/.ensemble/agents/<id>/`.
- Direct chat messages are queued while the agent is running and flushed when the native session becomes idle.
- Native session transcripts are authoritative; Ensemble stores only queue and UI state.
- Adding a homeless agent to a workspace can move its session with `session.move`; `/cd` is the human-facing equivalent in OpenCode 2.2.2.

## Configuration and init

`<workspace>/.ensemble/` contains:

```text
config.json          workspace name, leader, members, synthesis, paused
handoffs/            typed Markdown handoffs
init.json            AGENTS.md block version
```

`Ctrl+G` or `/init` runs native `/init` in a temporary workspace session, waits for the agent to update `AGENTS.md`, then places the versioned `<!-- ensemble:start v1 -->` block at the top. Existing content outside the markers is preserved. Init failures leave no partial block.

Reset is available through `/reset-ensemble` and `Ctrl+Shift+Delete`, requires typing `RESET`, and deletes Ensemble state, bound native sessions, config, and legacy v1 state. Handoffs are preserved unless explicitly deleted.

## Native tools

Read-only tools are available in every native session:

- `ensemble_workspace_info`
- `ensemble_list_workspaces`
- `ensemble_list_agents`
- `ensemble_task_status`

Write tools are registered globally but refuse outside an Ensemble-bound session:

- `ensemble_send_message`
- `ensemble_handoff`
- `ensemble_delegate`
- `ensemble_ask_person`
- `ensemble_remember`
- `ensemble_share`

`ensemble_send_message` posts to the group or queues an agent DM; it does not create work. `ensemble_handoff` validates a Markdown file under `.ensemble/handoffs/` and posts its path. `ensemble_delegate` remains the work-creating tool.

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
- The leader delegates through the `ensemble_delegate` tool with a typed envelope. Delegation depth is capped by `maxDepth`.
- When all children reply, a leader synthesis subtask is created unless the workspace disables synthesis.
- The board groups Pending, Working, and Replied. `d` delegates, `t` reassigns, `Enter` opens the result, `r` retries, `R` stops and restarts, `x` cancels, and `o` opens the run.
- Reassignment and restart interrupt the active run and clear its run token, so a late reply from the stopped run cannot overwrite the new assignee.

## Scheduling and recovery

- Default three active runs.
- One active run per agent per workspace.
- One editing run per canonical directory; research can continue.
- Closing the Ensemble page does not stop native work.
- On restart, working subtasks return to Pending with an interrupted badge and an `interrupted` approval (or keep an existing pending question approval). They never replay automatically; the user resumes, answers, or discards them.
- Cancelling, retrying, or reassigning a subtask closes its pending question/interrupted approvals, so stale decisions cannot restart dead work.
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

- The composer completes agents on `$`, files on `@`, and Ensemble commands on `/`; arbitrary native OpenCode slash commands are not proxied into the group chat.
- The transcript renders Markdown structure (headings, bullets, code blocks, links, and tables) as terminal text. Syntax highlighting and clickable links are not implemented.
- Direct chats use the native OpenCode transcript; there is no separate Ensemble DM store, search, or export.
- Some host dialog closes leave stale cells until the next full repaint; the page remains usable.
- No npm package, versioning policy, or license has been selected.
