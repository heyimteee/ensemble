# Ensemble v2 implementation

> **v3 UI and streaming pass.** The v3 work adds real delta streaming, inline composer completions, a searchable member checklist, semantic theme tokens, focus borders, git metadata, and the visible `I` init shortcut. The v2 runtime model and authority boundaries are unchanged.

Status: **developer preview**, compatibility recorded against OpenCode 2.2.1. The v2 runtime is the default. The v1 preview was removed. The v5.8 live matrix ran on OpenCode 2.2.5.

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
- **`src/v2/skill-invocation.ts`** — the shared pure skill invocation planner used by composer completion and server validation: anchors, assigned/General skills, owner choices, direct-chat rejection, and work titles.
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

The directory picker uses `fd` to enumerate directories and fuzzy filtering in the TUI. Recent workspace directories come first, `~/` expands, and manual paths are supported. The workspace rail groups workspaces by canonical project directory, supports `/` search, and shows unread (`●`), busy (Braille `⠋`), and paused (`⏸`) markers. The selected workspace and subtask are persisted and restored when the page reopens.

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

- New agents start with no workspace. Their native DM session lives under `~/.ensemble/agents/<id>/`.
- Adding an agent to a workspace can move its no-workspace session with `session.move`; `g` edits members and the leader without recreating the workspace.
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
- One composer message creates at most one prompt per unique addressed agent. A normal anchor is an ordinary peer turn; skill anchors use the same recipient rule and group their resolved skills. Separate messages stay separate queued items.
- The System Agent is a display identity, not a roster member: it cannot be mentioned, has no model or Skillbox, and authors ordinary left-side transcript bubbles through `Message.displayAuthor`. Workspace-level jobs such as init use its messages and the existing live/streaming row conventions.
- No mention routes only to the leader.
- Unknown `$Name`/`!Name` values fail with a clear `unknown_member` error instead of silently falling back.
- Archived mentions are refused loudly instead of routing to the leader; one refused peer never aborts the remaining recipients.
- `i` focuses an inline bottom composer in Insert. `Enter` on a roster or chat row opens/focuses the target without changing mode. `$` opens an agent picker and inserts a stable `$Name` reference; `@` opens a workspace file picker; `/` opens the Ensemble command palette. `m` is the keyboard shortcut for the agent picker.
- File references are resolved inside the workspace and appended to the subtask instruction. `@` is not a mention.
- Agent replies and task cards appear in the same transcript.
- Group replies subscribe to the native `session.text.delta` event. The service maps `sessionID` to the active run, appends deltas to one live message row, throttles persistence, and reconciles with the final assistant text when the run completes. The live slot registers before the opening row persists, so a delta that lands in between is buffered, never dropped. Direct chats consume the same native delta event in the TUI and clear the live block on `session.execution.succeeded`, then reload the committed native transcript.
- Direct chats render the native OpenCode transcript in the center column and stream deltas into a live assistant block. `o` opens that native session as a normal OpenCode route.
- Selecting an agent opens its DM; selecting a workspace opens the group chat. The empty state appears when no chat is open.

## Skill invocation and leader triage

The authoritative boundary and its trade-offs are recorded in [ADR 0001: Native-skill boundary](adr/0001-native-skill-boundary.md). This section describes the implementation of that decision.

`/` at message start shows commands, the built-in Ensemble init skill, assigned skills as `Skill | <Owner>`, and unassigned catalog skills as `Skill | General`. `$Agent /` shows only that agent's Skillbox. The TUI and server run the same pure planner; the server re-validates against authoritative state before appending a message or creating work.

- Assigned skills route only to their owner. A message-start skill owned by the leader runs on the leader; one owned elsewhere opens an owner picker. With no mention, the leader is tried first, then the picker.
- General skills route to the leader for triage, even with no anchor. A General skill under a non-leader mention is rejected with a fix message naming the leader.
- The leader receives a one-run native `skill` permission allow for exactly the requested General skills and a prompt directive to read them with the native skill tool, then use or delegate them. The Skillbox permission baseline is restored after the turn. A delegatee receives the leader's self-authored instruction and no host skill grant.
- Direct conversations reject General skills with a pointer to the workspace group chat. The DM agent's own assigned skills pass through.
- The built-in `/init` palette entry is displayed as General but executes the System Agent init job. It is not assignable in the Skillbox and remains solo-only.
- Exact user text is the prompt body, preserved for skill delivery; the service adds routing directives outside that text. No prompt `skills` attachment or experimental skill activation is used.
- One planner message creates at most one prompt per unique addressed agent. Multiple `/skill` tokens for the same agent are grouped into that one prompt; the planner never extracts per-skill bodies or creates per-skill child tasks. Separate composer messages remain separate queued items and therefore run sequentially through the conversation queue.
- Validation is atomic and server-authoritative: an unknown skill, wrong owner, archived or non-member agent, missing workspace, cap overflow, or General skill on a non-leader mention rejects the whole message before a transcript line, task, or prompt exists. The error names the exact skill, owner, agent, or workspace problem, and the TUI keeps the draft for correction.

## v3 composer, transcript, and visual system

- `$`, `@`, and `/` open an inline bordered completion popup above the composer. The composer stays focused; typing filters the list, `↑/↓` move, `Enter` inserts an agent/file token or runs a command, and `Esc` closes. No host completion dialog opens.
- Agent and file completion insert stable references in place. Slash selection executes through the same command path as a typed `/command`.
- Workspace creation and editing share a centered wizard: Directory → Name → Members → Leader → Synthesis. Editing an existing workspace uses Members → Leader → Synthesis. The leader step lists every member selected in the previous step and preselects the current leader when still selected.
- Agent creation uses a centered wizard: Name → Title → Role → Memories → Model → Variant. Wizard list steps use `j`/`k` (`gg`/`G`), `Enter`, `Space` on multi-select steps, `/` to filter, `n` next, `N` previous, and `Esc` to cancel (a dirty draft asks first). Text steps use the shared Insert/Normal/Visual grammar: `Enter` continues or saves, `Esc` goes to field Normal, and the next `Esc` cancels. `Shift+Enter` adds a newline in text steps. Steps do not validate; the final submit validates and jumps to the first invalid step with an inline error. The Main model step tracks the live model catalog and explains an empty catalog instead of showing a bare zero.
- Agent name, title, and role fields are wrapping textareas. Workspace and agent drafts remain in the modal while navigating; the memories step is an ordered list with `a` add, `e` edit, `x` delete, and `j`/`k` selection. A memory add/edit field stays focused after `Enter`: an add clears for the next entry, an edit keeps its text, and `Esc` returns to the list. Each list entry is saved as a separate memory on agent creation; an empty list skips.
- Modal panels use an opaque raised surface and a double focus border. The page bars dim while a modal is open.
- Rail agent names are predictable: selected agents use the success/accent color, every unselected agent uses normal text. Agent identity colors are not shuffled per row.
- Focused panes and the composer use a white/contrast focus border; inactive panes use the muted border token.
- The transcript is one stable rich Markdown scrollbox. Finalized messages keep stable identity and render in place with a colored author line, full Markdown scopes, tables, fenced code, headings, quotes, and links. The live reply is a separate colored, wrapped block; when it finalizes it moves into the stable history without remounting the transcript. Snapshot and chat-context polls are serialized so stale responses cannot repaint older text.
- The transcript preserves scroll position when the user has scrolled up and stays pinned to the bottom when already there. A floating `↓ bottom` button and `End` jump to the newest message. `PageUp` / `PageDown` scroll by a page.
- All chrome uses OpenCode semantic theme tokens: text, muted/faint metadata, borders, focus, and feedback colors. Chat author lines use stable per-agent categorical colors; the rail remains one selected color and white unselected agents. The v5.6 platform keymap layer is removed: app bindings are terminal key tokens and are not rewritten to Cmd labels on macOS. The only Ctrl app chords are the documented editor keys (`Ctrl+C` stop, `Ctrl+D`/`Ctrl+U` half page, `Ctrl+G` leave editor, `Ctrl+R` redo). The Leader is `Space`.
- The top bar shows the workspace, directory, and familiar `git:(branch*) ↑N ↓N` metadata when the directory is a repository. Git status is read with stderr suppressed; non-git directories show no git segment.
- `I` is bound as `shift+i` and appears in the footer and help. `/init` and `Ctrl+G` remain available.
- The composer is a wrapping textarea inside the chat column. It grows to eight lines, then scrolls internally. `Enter` sends, `Shift+Enter` adds a newline, and completions stay above the composer. Its border uses the focus token while active and the muted border token otherwise.
- Creating an agent starts a visible onboarding prompt in its home session. The prompt includes the agent's name/title/role, colleague behavior, handoff rules, and the full versioned AGENTS.md Ensemble block. It runs in the background; hidden identity instructions also carry the block into every session.

## Direct chats and sessions

- Every agent has a direct chat. If the agent belongs to the active workspace, the DM uses that workspace’s native session; otherwise it uses a no-workspace session in `~/.ensemble/agents/<id>/`.
- Direct chat messages are queued while the agent is running and flushed when the native session becomes idle.
- Native session transcripts are authoritative; Ensemble stores only queue and UI state.
- A Direct conversation accepts the DM agent's own assigned `/skill` tokens. General skills are rejected with a pointer to the workspace group chat, where the leader can triage them.
- Adding an agent with no workspace to a workspace can move its session with `session.move`; `/cd` is the human-facing equivalent in OpenCode 2.2.2.

## Configuration and init

`<workspace>/.ensemble/` contains:

```text
config.json          workspace name, leader, members, synthesis, paused
handoffs/            typed Markdown handoffs
init.json            AGENTS.md block version
```

`I`, `:init`, or a message-start `/init` appends a visible `/init` audit line and starts a System Agent init job. An init alias attached to an agent anchor is rejected as a mixed solo request; a prose `/init` is ordinary text. The job creates a temporary native session in the workspace, calls native `/init` with the full `initInstructions()` text (inspect the project, preserve project guidance, replace one Ensemble block), streams progress into the System Agent message, and finalizes a report. The internal native call is deliberate: the user-facing composer path never forwards text to native OpenCode, and native `/init` in a native prompt is not shadowed. On success it places the versioned `<!-- ensemble:start v2 -->` block at the top and writes `.ensemble/init.json`; existing content outside the markers is preserved. On failure, cancellation, reset/archive/delete, or service restart, the previous `AGENTS.md` is restored (or removed when it did not exist) and the report says so. Init is solo-only and workspace-only; a duplicate active init is rejected.

Reset is available through the `/reset-ensemble` composer command, requires typing `RESET`, and deletes Ensemble state, bound native sessions, config, and legacy v1 state. Handoffs are preserved unless explicitly deleted.

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

`ensemble_send_message` posts to the group or sends a direct agent message (member DMs deliver with an envelope carrying addressing, correlation, ordering, and delivery state; cross-boundary contact requires an `outside_roster` approval). A group post that names `$Name`/`!Name` mentions also creates one peer turn per named member: a durable `turn` work item through the same queue, lease, retry, and recovery machinery as delegations, with per-agent serialization, depth and per-run caps, idempotency, and visible per-recipient refusals (unknown/archived/outside-roster mentions never abort the remaining peers). The recipient's reply in the asking transcript is the relay, attributed via `answeredByID` and linked by correlationID, with no second leg. `ensemble_handoff` validates a typed Markdown file under `.ensemble/handoffs/` as structured frontmatter and creates a handoff hop: a queued unit of work routed to the named recipient, acknowledged in the group chat, retried within its attempt budget and deadline, and relayed back into the asking conversation (or failed visibly there). Handoff caps are handoff-specific, not the generic delegation settings: chains stop after one hop (`HANDOFF_MAX_DEPTH = 1`), and one run fans out at most three hops (`HANDOFF_MAX_PER_RUN = 3`); only handoff hops count toward the per-run budget because relay/failure-notice legs are messages, not work rows. `ensemble_delegate` remains the leader-only work-creating tool.

Idempotency keys (`work:`/`handoff:`) scope actor, workspace, kind, a hashed run prefix (never the raw parent id), the addressed recipient, and the canonical task/constraints/expected body. Suppression honors the row lifetime: a matching row suppresses resubmission while it is retained (live or terminal; finished rows purge after 24h retention). Intentional re-asks stay explicit: `task.retry`/`task.restart` re-queue the same row, and asking from a different parent/run is a different unit of work by construction. Cancellation is structural: only an explicit `stoppedAt` marker reads `cancelled`; error text is never substring-matched.

Outside-roster rule: the user is the authorizer, so a user group post naming a roster agent outside the workspace fails loudly with a clear message and no leader fallback. Agent posts (group mentions and handoffs) follow the existing approval model instead: contact needs user consent, then the approved turn/hop runs once through the same queue.

Single-process claim boundary: claim ownership (`claimedBy`, `leaseUntil`, `activeRunID`) is process-local. Store `sync()` never overwrites a locally held claim with a storage row's claim fields, and a fresh claim is re-read from storage before work starts (`claimWon`) so a racing writer cannot be double-claimed silently. Two processes actively pumping against one store is unsupported; `SharedEnsemble` keeps one service per process and `sync()` converges cross-location views of that service.

## Subtasks

```ts
Subtask {
  id, workspaceID, parentID?,
  creatorType, creatorAgentID?, assigneeID?,
  title, instruction, constraints?, expected?,
  mode: "research" | "edit",
  state: "pending" | "working" | "replied",
  outcome, stage, interrupted, approvalID?,
  resultMessageID?, error?, attempts,
  skillGrants?
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

- `Space` enters the which-key leader menu outside text entry.
- `Space ?` opens the full grouped shortcut list.
- `Space q` leaves Ensemble for the native TUI; `:q` is the equivalent command.
- `Esc` cancels leader mode and never leaves Ensemble.
- `Space` inside a dialog or message remains text.

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
| #30 | v3 specification: streaming, rich text, and TUI visual system |
| #31 | Native delta streaming and formatted Markdown |
| #32 | Inline composer completion popup |
| #33 | Custom searchable member picker |
| #34 | Semantic theme, focus borders, layout, git metadata, and `I` |
| #35 | v3 acceptance and verification |

## v4 reliability, shortcuts, and team rules

- One process-level service registry owns a single Ensemble service/store, with reference-counted location setup and changes broadcast to every RPC registration. Stores also merge roster/membership/binding updates and reconcile every workspace config when snapshots are read.
- Direct-chat assistant messages use the same `agent` transcript role as group replies.
- Markdown styling covers heading levels, strong, italic, strikethrough, inline/block code, links, lists, quotes, images, and syntax token scopes. Styling failures are reported instead of silently downgrading.
- The interaction layer is modal: Normal, Insert, Visual, and Command share one binding catalog and one Esc ladder. `Space` is the leader, `Esc` never leaves, and the old Ctrl app shortcuts are gone.
- `Space ?` opens a searchable shortcut reference with fuzzy filtering and a scrollable list generated from the binding catalog.
- The Leader key is `Space`; `Space q` and `:q` leave Ensemble deliberately, and `Esc` never leaves.
- The versioned team contract is v2. It explicitly defines `$Name` chat mentions, `@path` file references, and Ensemble tools as the work-dispatch mechanism.
- Agent replies that write `@KnownAgent` are display-normalized to `$KnownAgent`; a system note clarifies that a mention does not dispatch work.
- The shared service is the root fix for the stale-location lost update: Jessy's profile and binding remained in storage, but one location held a workspace row without her. Both locations now reconcile to three members.

## v5.7 persistent modes, native key ownership, and interaction polish

- **One persistent mode.** Normal, Insert, Visual, and Command are global interaction states. Focus moves, overlay opens/closes, wizard-step changes, and surface changes never assign a mode; only explicit insert entry, `Esc`, visual entry/exit, command open/close, `Ctrl+G`, and route leave do. `Enter` opens/focuses a target but never changes mode. Command records its return mode, Visual is self-contained, and leaving Ensemble resets Normal.
- **Esc ladder.** Insert/Visual/Command → Normal. From Normal, `Esc` clears a search/filter, leaves the composer to chat, backs out of a field/overlay/dialog, or is a no-op. A wizard text field's first `Esc` goes to field Normal; the second cancels the wizard, with a discard confirm when the draft is dirty. `Ctrl+G` leaves the focused editor and sets Normal.
- **One caret model.** Every text editor (composer, settings fields, wizard/prompt fields, and the command/search input) paints a non-blinking block caret in Normal and a non-blinking line caret in Insert, Visual, and Command. An unfocused editor paints none. Insert → Normal keeps the editor focused; only leaving the editor or its context blurs it.
- **Native key ownership.** Raw keys are handled only when the page is both the newest mount and on the Ensemble route. Leaving Ensemble blurs every editor, clears command/leader/overlay/pending state, sets Normal, and keeps the page mounted for `F2`. A hidden page therefore never consumes native keys, and typing plus `/` reach the native prompt without an `Esc`.
- **Typed statusline.** Row one is built from segments: a filled mode chip, context, selection, git, position, pending chord, and catalog hints. Keys are accent-colored, descriptions muted, git/position accent, and feedback success/error colored. Row two carries the `:`/`/` input or the latest message. The command/search input keeps its own cursor and a visible line caret; Left/Right, Home/End, Backspace, Delete, and insertion at the cursor edit in place, and history/Tab completion still apply. The prompt cell renders outside the scrolling input, so the prompt and mode chip never truncate and the caret stays visible while long text scrolls horizontally. Hints drop first when the bar is narrow.
- **Immediate navigation.** The rail row reads the current cursor reactively, so `j`/`k` repaints on the next frame instead of waiting for the 250 ms snapshot poll. The other list surfaces already read `cursor` inside their rendered expressions; the rail was the only one capturing it once.
- **Chrome separators.** Non-content chrome joins with a faint `│` and one space (ASCII `|` fallback). This covers the statusline, hints, footers, rail metadata, work rows, and activity lines. Chat message content is never rewritten.
- **Leader label.** The rail stays transparent. `LEADER` is inline text after a faint `│` separator on the agent's name row, colored with the leader accent and bold. There is no badge box, padding row, or opaque cutout to paint. The title branch follows on the next row.
- **Wizard navigation and memories.** `n` next, `N` previous, `Enter` next/confirm, and `Esc` cancel. Text steps open in the mode the user arrived with, never auto-Insert. The memories step replaces the old multi-line blob with an ordered list; `a`/`e`/`x` add, edit, and delete, and `Enter` saves one entry while keeping the field focused. Settings memory add/edit uses the same persistent-field flow.
- **Changed from v5.6.** Enter no longer forces Insert, text fields no longer auto-enter Insert, and step arrival no longer resets mode. Tests and live probes that expected the old coupling were updated rather than weakened.

## v5.8 System Agent init and deliberate skill invocation

- **System Agent identity.** A non-roster display identity for workspace-level jobs. It has no model, Skillbox, or mention route; its messages use the normal left-side agent bubble and streaming lifecycle.
- **Visible init job.** `I`, `:init`, and `/init` append the same visible `/init` line, then start a durable init job. The System Agent row starts as `Initializing workspace…`, receives progress, and finalizes into the full report. The job survives navigation; reset/archive/delete cancel it, and restart marks it interrupted with a rerun instruction.
- **Deliberate internal native init.** The job owns a temporary native session in the workspace and calls the native `init` command with the full `initInstructions()` text. Only the success path writes the canonical block and `init.json`; every failure path restores the prior `AGENTS.md`. Only a message-start trigger or an anchor-attached alias is init; prose `/init` is ordinary text. The composer never falls through to native `/init`, and native `/init` outside Ensemble is unchanged.
- **Exact-text routing.** The shared planner resolves `$Agent` anchors and `/skill` tokens but never rewrites the request. Each unique addressed agent receives one prompt containing the exact user text; multiple skills for that agent are grouped, separate messages stay sequential, and there are no per-skill bodies or per-skill tasks.
- **General-skill leader triage.** Assigned skills stay with their owner. General skills route to the leader, who reads them under a one-run native permission grant and either uses them or delegates with a self-authored instruction. The grant is restored after the turn; a delegatee receives guidance, not a host grant.
- **No attachment bypass.** General skills are never delivered through prompt `skills` attachments or the experimental skill-activation endpoint. Native per-agent skill permissions remain authoritative, and the identity contract tells agents to load deliberate `/skill` tokens with the native skill tool.
- **Atomic validation.** A bad skill, owner, agent, workspace, or cap rejects the whole message before any transcript line or work row, names the specific problem, and leaves the draft in place.

## Known limitations

- The composer completes agents on `$`, files on `@`, and Ensemble commands on `/`; arbitrary native OpenCode slash commands are not proxied into the group chat.
- Rich Markdown has no per-line color API; author identity colors are separate rows above each message. Clickable links are not implemented.
- Multiple OpenCode locations synchronize roster, workspace membership, and bindings through the shared service/store plus config reconciliation. Messages and active runs remain owned by the instance handling them.
- Direct chats read the native OpenCode session context and render it in the Ensemble transcript; `o` opens the native session route. There is no separate Ensemble DM store, search, or export.
- Some host dialog closes leave stale cells until the next full repaint; the page remains usable.
- macOS/Herdr behavior remains unverified in v5.8: the environment is Linux/tmux. The collision-free shortcut intent, inline leader label on that host, `Esc`/`Ctrl+G` under a live native run, System Agent live progress, the `/` and `$Agent /` palettes, and `/init` under Herdr remain a manual check.
- Real mouse-drag copy remains manual because tmux does not reliably inject drag gestures; the pane-bound selection/copy policy is unit-covered.
- The host keeps old plugin pages mounted; the route gate prevents stale key ownership but cannot force the host to dispose them.
- The large TUI application component remains a follow-up; v5.8 did not split it.
- No npm package, versioning policy, or license has been selected.
