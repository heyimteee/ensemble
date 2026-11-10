# Ensemble v2 implementation

> **v3 UI and streaming pass.** The v3 work adds real delta streaming, inline composer completions, a searchable member checklist, semantic theme tokens, focus borders, git metadata, and the visible `I` init shortcut. The v2 runtime model and authority boundaries are unchanged.

Status: **developer preview**, compatibility recorded against OpenCode 2.2.1. The v2 runtime is the default. The v1 preview was removed. The v5.8 live matrix ran on OpenCode 2.2.5.

> **Native-first decisions (2026-11-10).** [ADR 0009](adr/0009-conversation-identity-and-sessions.md), [ADR 0010](adr/0010-native-turn-ingestion.md), and [ADR 0011](adr/0011-mention-routing-and-budgets.md) record the decided conversation/session, ingestion, and routing model. Where this document describes the current v2 path that differs (one workspace session per agent, a DM reusing it, TUI transcript reads, explicit `maxHops`), the ADR is authoritative for the target; implementation lands under tickets #212–#227.

## Architecture

```text
Ensemble TUI workspace page
  agents + workspaces rail · direct/group chat · Work pane · settings · approvals
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
- **`src/v2/shared-service.ts`** — process-global, versioned `SharedEnsemble` registry on `globalThis`; reference-counts locations so one service starts per host realm.
- **`src/v2/location-adapter.ts`** — `LocationAttachment` for one plugin `setup(ctx)`: the shared service reference plus that location's RPC, tool, retry-hook, and event-stream registrations and their disposal. Host events are claimed once by the realm before handling.
- **`src/v2/host-events.ts`** — event identity for realm-wide dedupe: the host event id, with documented stable fallbacks for id-less stream, permission, config, and catalog events.
- **`src/v2/tool-registrar.ts`** — the reusable `ensemble_*` tool declarations installed on every location's context; behavior stays on the shared service.
- **`src/v2/catalog.ts`** — model/skill catalog refresh with a timeout guard.
- **`src/v2/execution.ts`** — pure execution helpers: model availability, tool-call inspection, prompt/context assembly, memory formatting, Skillbox permissions.
- **`src/v2/skill-invocation.ts`** — the shared pure skill invocation planner used by composer completion and server validation: anchors, assigned/General skills, owner choices, direct-chat rejection, and work titles.
- **`src/v2/tui/`** — page shell, presentational components, palette, formatting, and keymap layers.
- **`src/v2/store.ts`** — durable state in OpenCode plugin storage, keyed per agent, workspace, message, subtask, binding, memory, and approval. Reads use targeted accessors or the live read-only view; `snapshot()` is the single full-state clone boundary. Read-modify-save paths clone only the entity they save. Live streaming rows are indexed by id, foreign-version message merges use an id index rather than nested scans, and checkpoint writes persist live text without a coordination version. Set `ENSEMBLE_DEBUG_CLONES=1` to expose full-clone counts and timing on the `diagnostic` RPC (`clones`). Store writes expose optional lifecycle observers for operational logging.
- **`src/v2/logging.ts`** — bounded in-memory ring, per-process JSONL sinks, level/category filtering, redaction, rotation, and retention.
- **`src/v2/log-events.ts`** — store observer that projects durable task/message/approval/init transitions into stable log events without heartbeat spam.
- **`src/v2/failure-record.ts`** — self-contained failure records: error chain, model/session/run, tool outcomes, recent message metadata, and the retry/park/terminal decision.
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
- Switching workspace changes the chat, Work pane, and directory for new runs.
- Sessions are bound to `workspace + agent` in the current path; [ADR 0009](adr/0009-conversation-identity-and-sessions.md) replaces that key with a conversation binding.
- `<workspace>/.ensemble/config.json` is authoritative for workspace name, leader, members, synthesis, and paused state. OpenCode storage remains authoritative for agents, messages, subtasks, approvals, memories, bindings, and history.
- Valid config files discovered in a directory register a workspace automatically; invalid config is rejected and the last good state is kept.
- `.ensemble/` is created when a workspace is created, is added to `.gitignore`, and contains only config, handoffs, and init metadata. Conversation history stays in OpenCode storage.

The directory picker uses `fd` to enumerate directories and fuzzy filtering in the TUI. Recent workspace directories come first, `~/` expands, and manual paths are supported. The workspace rail groups workspaces by canonical project directory, supports `/` search, and shows unread (`●`), busy (Braille `⠋`), and paused (`⏸`) markers. The selected workspace, focused task, and focused pane are persisted and restored when the page reopens.

A workspace can be paused with `p`; paused workspaces reject new work until resumed. Automatic leader synthesis is chosen when the workspace is created.

## Workspace shell

The root row is three stable panes: Rail, Chat, Work. [ADR 0006](adr/0006-three-pane-workspace-shell.md) records the decision and trade-offs; this section maps it to the implementation.

- **Widths.** `workspacePaneWidths(terminalWidth, visibility)` in `tui/workpane.ts` is the only width function. It owns the rail clamp, the chat remainder, the Work share, and the drawer width, and it consumes the two durable column switches. The transcript composes `messageWidth` from `chatContentWidth` while Work is present and `chatOnlyContentWidth` when it is absent. `workPaneBodyHeight` is the matching body-height helper. Breakpoints: ≥118 columns is the full three-pane card shell, 96–117 is three panes with compact Work, and <96 becomes a right drawer; `Space b l` / `Space b r` toggle the columns at every width and the right switch owns the drawer. No consumer recomputes these numbers; the size tests read the same helpers.
- **Rail.** `tui/railmodel.ts` is pure. Agents group by primary workspace (active workspace, then most recent membership, then Homeless), each agent appears once, the subline is the role title, and a group header carries the workspace name, counts, and collapse state. `z` and a header click toggle a group; `j`/`k` skip collapsed agents. Collapse is durable UI state (`ui.collapsedRailGroups`). The Workspaces section is a separate pane with the directory label, unread/busy counts, paused marker, and active selection. One cursor traverses the visible rows.
- **Work pane.** `workpane.ts` partitions **tasks**, not groups: `workViewGroups` keeps non-terminal tasks in ACTIVE and terminal tasks in HISTORY even while their group still has live work, so one group may appear in both views with disjoint cards. HISTORY groups order by latest terminal finish (task or native subagent), newest first, and cards inside a HISTORY group order by finish, newest first; ACTIVE keeps the task-then-native order. `paginateWorkGroups` lays whole group rows into pages by body height and repeats a group header with `cont.` when it crosses a page. The card design is unchanged; only container width/height and the focus border adapt. Completed cards leave ACTIVE at once, a never-seen newest history group expands, a seen group keeps its row when later finishes reorder it, older groups roll up, and the history view retains finished work under the existing 24h retention rather than adding a second policy.
- **Focus and actions.** `workfocus.ts` turns the rendered page sections into card rectangles and `nextWorkCard` picks the nearest card with perpendicular tie-breaking. `j`/`k` at a page edge auto-page and keep the horizontal column; `gg`/`G` and `Ctrl+d`/`u` use the same geometry. Focus is stored by task id in `app.tsx` and settled by `settleWorkFocusByPosition`; a disappearing card falls back to the nearest prior position. `Enter` opens the result; `d`/`t`/`r`/`R`/`x`/`o` run only the actions `workTaskActions` advertises for the derived status. A pending retry/restart/cancel label is compared against the dispatch-time lifecycle signature and clears on the durable update, never on the RPC return alone.
- **Approvals.** The right column has two approval modes. Split mode pins a small approvals summary under Work; the summary is its own selected pane and does not whiten the WORK heading. `v` opens the full-height right-column approvals from any pane (opening the right column first when it is closed), Enter from the small selection opens the same full view, `j`/`k` move the one cursor, Enter resolves, and `Esc` returns to split mode. The old chat modal, inline-only inbox, and `V` overflow binding are retired. Approvals are deliberately workspace-scoped so one workspace cannot see or resolve another workspace's pending decisions, and they join the Tab cycle only while pending.
- **Borders and alignment.** Focused cards use `theme.cardFocus` (white); unfocused cards use the subdued border grey, while the Work pane keeps its own separate focus border. `format.ts` `alignedDetailRows` computes one label width for the member wizard and picker rows, so `|` separators align for ASCII and Unicode and long labels truncate once.
- **Native picker.** A group-chat `o` opens a picker of workspace members (name, role, leader, busy); Enter routes to that member's native session, Esc closes, and a missing binding raises a clear toast. Work focus `o` opens the focused card's assignee directly, and a DM keeps the current agent route.
- **Native subagents.** OpenCode child sessions become durable `NativeSubagentRun` records keyed by `childSessionID`; they are not Subtasks, never enter the queue, and spend no hop. `session.created.parentID` resolves the parent task/group/workspace/agent, the parent's `subagent` tool input supplies a bounded instruction head, and `session.execution.*`, `session.idle`, and `session.deleted` drive working/replied/failed/cancelled. The Work pane renders a read-only `Subagents: <instruction>` card under the parent dispatch group, named for the parent agent, and `o`/Enter open the child native session. Because the host can settle a parent turn while a `background: true` child still runs, a successful run holds on the existing heartbeat lease until child terminal events or a bounded five-minute timeout; logs carry IDs, parent agent names, states, sources, counts, and durations only, never instructions or message content. See [the #188 verification record](verification/2026-11-09-subagent-live.md).
- **Performance.** Rail grouping, view filtering, pagination, spatial navigation, and alignment are pure functions. There are no new timers: the existing one-shot Work invalidation timer still covers status, lease, retry, and hold transitions. Static card data stays in the identity cache; focus changes only the selected prop, and approvals reuse the existing pending memo.

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
- General, Models, Memories, and Skillbox settings. `s` saves and closes the surface; one app toast confirms the save.
- Main model and supported reasoning; ordered backups can be added, moved, and removed.
- Exclusive Skillbox enforced with per-session `skill` permissions.
- Automatic leader synthesis is chosen when a workspace is created.
- Behavior changes bump the version but keep the existing native session. The next task or direct message applies the persona instructions, main model, and Skillbox permissions in place (`instructions.entry.put`, `session.switchModel`, `session.update`), marks the binding at the new version, and clears `pendingSettings`; `binding.history` is untouched. Renaming does not bump the version.
- A new native session is created only when the binding is missing or the bound native session no longer exists (the old ID is appended to `history`), or when the user explicitly rebounds. A run never saves its pre-claim agent snapshot, so it cannot resurrect `pendingSettings` or overwrite a concurrent settings save.
- `agent.rebindSession` takes `{ agentID, workspaceID?, sessionID }`; an omitted `workspaceID` selects the `home` binding. The target must be the current session or a member of `binding.history`, and the current session must have no active run and not be direct-busy. Rebinding to the current session is a no-op. A history target whose native session no longer exists is rejected with `invalid_session` before anything is applied. Success applies the current behavior to the target, sets `history = [current, ...history without target]`, `sessionID`, `agentVersion`, and `updatedAt`, and logs `agent.session.rebound` with IDs only.
- `agent.update` emits `agent.updated` with `{ agentID, version, changed }`. `changed` lists field names only (`name`, `title`, `role`, `mainModel`, `backupModels`, `skillbox`, `color`); it never records role text, skill names, or model values.
- See [ADR 0007](adr/0007-apply-agent-behavior-in-place.md).

## Group chat

Native-first target: `$Name` in sanitized native prose is the routing operator; the current tool path below remains during migration. See [ADR 0011](adr/0011-mention-routing-and-budgets.md).

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
- Group replies subscribe to the native `session.text.delta` event. The service maps `sessionID` to the active run, appends deltas to one live message row, emits coalesced ephemeral text for the visible row, and checkpoints persistence at a bounded interval. The live slot registers before the opening row persists, so a delta that lands in between is buffered, never dropped. Finalization publishes one durable message upsert with the exact final text, which replaces the live overlay and recovers any missed ephemeral event. Direct chats consume the same native delta event in the TUI through the same coalescer and clear the live block on `session.execution.succeeded`, then reload the committed native transcript.
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

Native-first target: each direct conversation has its own native session and Work history; the current path below reuses the workspace session until #214. See [ADR 0009](adr/0009-conversation-identity-and-sessions.md).

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

`I`, `:init`, or a message-start `/init` appends a visible `/init` audit line and starts a System Agent init job. An init alias attached to an agent anchor is rejected as a mixed solo request; a prose `/init` is ordinary text. The job creates a temporary native session in the workspace, calls native `/init` with the full `initInstructions()` text (inspect the project, preserve project guidance, replace one Ensemble block), streams progress into the System Agent message, and finalizes a report. The internal native call is deliberate: the user-facing composer path never forwards text to native OpenCode, and native `/init` in a native prompt is not shadowed. On success it places the current `<!-- ensemble:start v5 -->` block at the top and writes `.ensemble/init.json`; existing content outside the markers is preserved. On failure, cancellation, reset/archive/delete, or service restart, the previous `AGENTS.md` is restored (or removed when it did not exist) and the report says so. Init is solo-only and workspace-only; a duplicate active init is rejected.

Reset is available through the `/reset-ensemble` composer command, requires typing `RESET`, and deletes Ensemble state, bound native sessions, config, and legacy v1 state. Handoffs are preserved unless explicitly deleted.

## Native tools

Ticket #225 retires the chat-routing surface on the native-first path. The
normal path is prose: an agent's final native text is the group message, and
`$Name` in a workspace group routes peer turns with server-assigned budgets.
The service injects a compact `ensemble_turn` block with the roster,
conversation, and dispatch budget each turn, so no read-only roster tool call
is required.

The native tool surface keeps only decisions the server cannot infer safely:

- `ensemble_task_status`
- `ensemble_review`
- `ensemble_ask_person`
- `ensemble_remember`
- `ensemble_share`

`ensemble_delegate` and `ensemble_handoff` stay on the legacy surface while the
migration flag carries the explicit path. `ensemble_send_message` is a
compatibility shim there, not a native-first tool; it still posts to the group
or sends a direct agent message (member DMs deliver with an envelope carrying
addressing, correlation, ordering, and delivery state; cross-boundary contact
requires an `outside_roster` approval). A post that names `$Name`/`!Name`
mentions creates one peer turn per named member through the same queue, lease,
retry, and recovery machinery as delegations, with per-agent serialization,
unified depth and per-run caps, idempotency, and visible per-recipient refusals.
The recipient's reply is the relay, attributed via `answeredByID` and linked by
correlationID, with no second leg. `ensemble_handoff` validates a typed Markdown
file under `.ensemble/handoffs/` and creates a handoff hop; every delegation and
handoff requires `maxHops`; the group depth ceiling and per-run fan-out cap still
apply. Relay and failure-notice legs are messages, not work rows, so they never
consume a hop or the fan-out budget. See [Dispatch budgets](#dispatch-budgets).

The surface follows the migration setting. `nativeFirst: "on"` selects the
native list; `off` and `shadow` keep the legacy list. An explicit
`settings.toolSurface` of `native` or `legacy` overrides the mode for one
release, which is the rollback path. Both lists are registered per host
location and are replaced in place when the setting changes.

Idempotency keys (`work:`/`handoff:`) scope actor, workspace, kind, a hashed run prefix (never the raw parent id), the addressed recipient, and the canonical task/constraints/expected body. Suppression honors the row lifetime: a matching row suppresses resubmission while it is retained (live or terminal; finished rows purge after 24h retention). Intentional re-asks stay explicit: `task.retry`/`task.restart` re-queue the same row, and asking from a different parent/run is a different unit of work by construction. Cancellation is structural: only an explicit `stoppedAt` marker reads `cancelled`; error text is never substring-matched.

Outside-roster rule: the user is the authorizer, so a user group post naming a roster agent outside the workspace fails loudly with a clear message and no leader fallback. Agent posts (group mentions and handoffs) follow the existing approval model instead: contact needs user consent, then the approved turn/hop runs once through the same queue.

Single-process claim boundary: claim ownership (`claimedBy`, `leaseUntil`, `activeRunID`) is process-local. Store `sync()` never overwrites a locally held claim with a storage row's claim fields, and a fresh claim is re-read from storage before work starts (`claimWon`) so a racing writer cannot be double-claimed silently. Two processes actively pumping against one store is unsupported; `sharedEnsemble()` keeps one service per host realm and `sync()` converges cross-location views of that service.

### Shared service registry

OpenCode re-evaluates the plugin module once per location (project, channel, or
agent home). `src/v2/shared-service.ts` keeps one `SharedEnsemble` registry on
`globalThis` under `Symbol.for("ensemble.v2.shared-service")`, so every module
load joins the same service and store:

- The registry exposes `SHARED_SERVICE_VERSION`. A location reuses an existing
  registry only when it is structurally compatible
  (`typeof registry.acquire === "function"`) and the version matches. The check
  must never use `instanceof`: class identity changes when the module is
  evaluated again for another location.
- `acquire(ctx)` reference-counts the location. The bootstrap location's
  plugin context owns storage, sessions, and the event stream for the realm;
  every location shares that service and store. `release()` is idempotent, and
  the service stops only after the last location releases it. An `acquire()`
  that arrives during that final teardown waits for the in-flight stop, then
  concurrent acquires coalesce onto one replacement service.
- `attach(ctx)` returns a `LocationAttachment` for one plugin `setup(ctx)`.
  The attachment owns that location's RPC registration, tool transform, retry
  hook, and realm reference. It installs the same `ensemble_*` toolset on the
  location's own context, so a non-first channel or agent home is not limited
  to RPC. Disposing the attachment removes only those registrations, releases
  the reference, and leaves other locations untouched.
- Tool handlers read the calling session from `context.sessionID` and the
  shared service store; they do not treat the first plugin context as the host
  authority for tool execution. The tool declarations live in
  `tool-registrar.ts` so every attachment installs one reusable registrar.
- Every location still registers and disposes its own RPC handlers. The
  registry shares the service and store, not the transport registration, tool
  transform, or retry hook.
- A version bump creates a new registry while the old one keeps serving its
  existing locations until they release. Lease-safe recovery covers that
  overlap window; do not rely on the global slot to point at the old registry.

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
- The leader delegates through the `ensemble_delegate` tool with a typed envelope and a required `maxHops` task budget. Depth is the group's unified `dispatchDepth` ceiling; `settings.maxDepth` is deprecated and no longer enforced.
- When all children reply, a leader synthesis subtask is created unless the workspace disables synthesis.
- The board groups Pending, Working, and Replied. `d` delegates, `t` reassigns, `Enter` opens the result, `r` retries, `R` stops and restarts, `x` cancels, and `o` opens the run.
- Reassignment and restart interrupt the active run and clear its run token, so a late reply from the stopped run cannot overwrite the new assignee.

## Dispatch budgets

The dispatch trust model is recorded in [ADR 0004](adr/0004-dispatch-budgets-and-continuation.md).
One user command gets one root dispatch group and a durable ledger. Four
layers bound work, each with one owner:

| Layer | Field | Bounds | Owner | Default | Tiers |
|---|---|---|---|---|---|
| Command | `commandMaxHops` | Every hop for one user command | User settings | 24 | 8, 16, 24, 32, 40, 48 |
| Group | `maxHops` | Hops in one group | User for the root; leader for a continuation | 8 | 8, 16, 24 |
| Task | `taskMaxHops` | Direct dispatches the recipient may make | Dispatching agent (`maxHops`) | Required | Any integer ≥ 0 |
| Depth | `depthMax` | Longest ancestor chain in one group segment | User settings | 8 | 1–16 |

Settings fields are `dispatchGroupMaxHops`, `dispatchCommandMaxHops`,
`dispatchDepth`, and `dispatchContinuations`. They are validated as one set:
command hops cannot be below group hops, and the continuation count must fit
at the smallest 8-hop group (`group + 8 × continuations ≤ command`). A root
group captures the current values, so settings edits apply to new commands
only. `:limits` and the leader menu edit the same four values; the service
revalidates every `settings.update`.

**Consumption.** A user command and its initial recipients consume nothing.
An agent-created delegation or explicit handoff consumes one group and one
command hop in the same serialized store mutation. Completion handoffs, batch
review, synthesis, peer turns, retries, restarts, recovery, and idempotent
replays never consume; cancellation never refunds. Two concurrent dispatches
at one remaining hop admit exactly one.

**Required task budget.** `ensemble_delegate`, `ensemble_handoff`, and a
`delegate` decision in `ensemble_review` require `maxHops`. Missing or
malformed values are validation errors, never silent defaults. Zero is a
one-shot ask: the recipient may answer and complete but cannot create work.
The task budget counts direct dispatches, not a reserved subtree; the group
and command remain the hard subtree cap. Only agent delegation and handoff
rows carry one; user-command recipients, peer turns, completion, batch,
synthesis, retry, restart, and recovery rows carry none, so no row receives a
silent group-remaining grant. Refusal order is task, closed group, group,
depth, command, then per-run fan-out. Copy names the layer and the next action
(return to the leader, continue in a new group, or ask the user for a new
command).

**Continuations.** A continuation is a leader-only, linked segment of the
same command. It is allowed only after the referenced group is exhausted, with
a required `groupMaxHops` tier that fits the command remaining and the
captured continuation count. Creating it seals the parent with
`closeReason: "continued"` and spends no hop; the first work item spends one.
The new group references its parent and root, starts a fresh depth segment,
and leaves command counters and depth on the root. Opening one bypasses the
leader task's spent budget: it is a new segment bounded by the group, command,
continuation-count, and fan-out caps, so a leader that spent every direct
delegate can still continue. Later leader dispatches join the newest active
continuation automatically; naming an active continuation as
`continuationOf` is refused while it still has hops. A closed group admits no
new hop; completion, batch, synthesis, peer-turn, retry, restart, and recovery
rows may still save directly.

**Ledger.** `SnapshotState.dispatchGroups` is a full durable map. Each
`DispatchGroup` records identity, workspace, root, parent, continuation index,
group maximum/used hops, depth maximum, root-only command maximum/used,
continuation maximum/used, creation/close time, close reason, and a
`reconciled` marker. State (`active`, `exhausted`, `closed`) is derived from
counters and closure, never stored. The store's `admitDispatchedSubtask`
performs admission, counter increments, and work creation in one serialized
mutation. Admission deduplicates by task id and by queue key inside that
serialized mutation, so two concurrent identical dispatches create one work
item and spend one hop. Snapshots, scoped reads, the change feed, and
`diagnostic` carry the full group entities; protocol-2 clients fall back to a
snapshot.

**Upgrade and migration.** The required task budget is enforced immediately.
Pre-ledger groups are synthesized on first access and persisted in bounded
maintenance batches (`reconcileDispatchGroups`): used hops equal the existing
non-completion delegation/handoff count, caps are raised to at least observed
usage and depth, and live rows that still lack a budget receive the group's
remaining budget. A stored budget, including zero, is never overwritten. No
in-flight work is retroactively refused. Reconciliation logs
`dispatch.group.reconciled`; the team contract is bumped and config
reconciliation rewrites a stale `AGENTS.md` block and `.ensemble/init.json`
from either version marker, preserving project-owned content and never
downgrading a newer version. `settings.maxDepth` is deprecated: it remains
readable but is ignored for enforcement, and removal is a future settings
cleanup.

## Scheduling and recovery

- Default three active runs.
- One active run per agent per workspace.
- One editing run per canonical directory; research can continue.
- Closing the Ensemble page does not stop native work.
- On restart, live `working` rows are never rewritten. A claim with an unexpired lease stays with its owner; an expired claim with no local run is re-queued with attempts preserved, and a working row with no claim is repaired. No approval is synthesized for dead work.
- Cancelling, retrying, or reassigning a subtask closes its pending question/interrupted approvals, so stale decisions cannot restart dead work.
- Model fallback uses the ordered backup list and surfaces switches.
- Permission denials, tool failures, and provider exhaustion pause the subtask with an interrupted approval; an uncertain tool outcome is never retried automatically.
- Transient failures retry at 5 s, 15 s, 30 s, then a 60 s cap, with jitter. The Work card shows `retry <n>s · <attempt>/5` (or `retry due · r now`) and the transcript gets one `Retrying in …` event with the reason.
- Maintenance claims due work after its repair pass. A future retry therefore resumes within about one second of its ETA after a restart, hot reload, or lost in-memory timer, without waiting for an unrelated action.
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

Approvals live only in the right column: a small summary under Work in split mode, and the full-height inbox opened by `v` or Enter from the small selection. `Esc` returns to split mode; the old inline chat modal and `V` overflow inbox are retired. Approvals are workspace-scoped so a workspace cannot see or resolve another workspace's pending decisions. Resolutions are idempotent: repeating the same decision returns the resolved approval, while a conflicting decision fails with `already_resolved`. Only the user can approve. Approving interrupted work resumes it once; discarding marks it failed.

## Leader key

- `Space` enters the which-key leader menu outside text entry.
- `Space ?` opens the full grouped shortcut list.
- `Space b l` / `Space b r` toggle the left / right column; `Space b` shows the submenu.
- `Space q` leaves Ensemble for the native TUI; `:q` is the equivalent command.
- `Esc` cancels leader mode (including a pending prefix) and never leaves Ensemble.
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

- One process-level service registry owns a single Ensemble service/store, with reference-counted location setup and changes broadcast to every RPC registration. Stores also merge roster/membership/binding updates, and every workspace config is reconciled on the serialized maintenance timer and before pump work, never on a snapshot read.
- Direct-chat assistant messages use the same `agent` transcript role as group replies.
- Markdown styling covers heading levels, strong, italic, strikethrough, inline/block code, links, lists, quotes, images, and syntax token scopes. Styling failures are reported instead of silently downgrading.
- The interaction layer is modal: Normal, Insert, Visual, and Command share one binding catalog and one Esc ladder. `Space` is the leader, `Esc` never leaves, and the old Ctrl app shortcuts are gone.
- `Space ?` opens a searchable shortcut reference with fuzzy filtering and a scrollable list generated from the binding catalog.
- The Leader key is `Space`; `Space q` and `:q` leave Ensemble deliberately, and `Esc` never leaves.
- The versioned team contract is v4 (`ENSEMBLE_BLOCK_VERSION = 4`); stale workspace blocks are rewritten on reconciliation. It defines `$Name` chat mentions, `@path` file references, Ensemble tools as the work-dispatch mechanism, the required `maxHops` task budget, and the layered command/group/task/depth budgets with leader-only continuation groups.
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
- **Visible init job.** `I`, `:init`, and `/init` append the same visible `/init` line, then start a durable init job. The System Agent row and its live phase row carry `starting`, `running`, `writing`, and `reporting`; the native `/init` portion reads `running · indeterminate` with four discrete stage marks and never a fabricated percentage. The row finalizes into the full report. The job survives navigation; reset/archive/delete cancel it, and restart settles it as interrupted with an explicit rollback and rerun report.
- **Deliberate internal native init.** The job owns a temporary native session in the workspace and calls the native `init` command with the full `initInstructions()` text. Only the success path writes the canonical block and `init.json`; every failure path restores the prior `AGENTS.md`. Only a message-start trigger or an anchor-attached alias is init; prose `/init` is ordinary text. The composer never falls through to native `/init`, and native `/init` outside Ensemble is unchanged.
- **Exact-text routing.** The shared planner resolves `$Agent` anchors and `/skill` tokens but never rewrites the request. Each unique addressed agent receives one prompt containing the exact user text; multiple skills for that agent are grouped, separate messages stay sequential, and there are no per-skill bodies or per-skill tasks.
- **General-skill leader triage.** Assigned skills stay with their owner. General skills route to the leader, who reads them under a one-run native permission grant and either uses them or delegates with a self-authored instruction. The grant is restored after the turn; a delegatee receives guidance, not a host grant.
- **No attachment bypass.** General skills are never delivered through prompt `skills` attachments or the experimental skill-activation endpoint. Native per-agent skill permissions remain authoritative, and the identity contract tells agents to load deliberate `/skill` tokens with the native skill tool.
- **Atomic validation.** A bad skill, owner, agent, workspace, or cap rejects the whole message before any transcript line or work row, names the specific problem, and leaves the draft in place.

## v7 durable feed and message streaming

- **Message patches.** Durable message append/save/remove publishes full-entity `message` upserts/removes through the protocol-3 patch feed. System and task lines therefore appear without a full snapshot; duplicate and reordered patches are harmless because the client upserts by `(workspaceID, id)` and the version gate drops old batches. A remove records a short client tombstone, so a delayed duplicate cannot resurrect a deleted entity; the tombstone map is time- and size-bounded.
- **Ephemeral live text.** A streaming agent reply publishes a coalesced `stream` event carrying accumulated text for its visible row. The event is version-neutral: it never enters the change ring and never advances the cursor. The client applies it only to a row still marked `streaming`, so a late event cannot overwrite final text.
- **Checkpoints and finalization.** Live text is checkpointed to storage at a bounded interval with no `v2/meta` version, change-ring entry, or published patch. A crash reloads the last checkpoint, clears `streaming`, and marks the row interrupted. Finalization drops queued live text, persists once through `saveMessage`, and publishes the exact final message upsert; that patch replaces the live overlay exactly once and recovers any missed stream event.
- **Shared client coalescing.** Workspace stream events and direct-chat native deltas both pass through the same client coalescer, so a chunk burst repaints the visible row once per window rather than once per chunk. Direct-chat finalization clears pending text before the committed transcript refresh.

## v7 Tier 3 scoped reads (ticket #141)

Tier 3 is a gated scale layer over the durable store, not a second source of
truth. The store remains authoritative; every projection and window is a
disposable read model rebuilt from durable entities when a scope is stale.

- **Recorded gate.** Scoped bootstrap/projection engages when durable history
  reaches 1,000 messages or 500 retained task rows, or when the last measured
  full snapshot payload is at least 512 KiB, or its build took at least 120 ms.
  Small workspaces keep the existing full-snapshot path. The gate, its reason,
  and its measured inputs travel with every bootstrap/resync response
  (`gate`) and the revision heartbeat; `src/v2/scoped-read.ts` is the single
  policy source. A disabled gate keeps steady-state refreshes on the snapshot
  path, and the bootstrap measures that snapshot so a borderline workspace can
  switch paths on the next refresh.
- **Scoped bootstrap.** `bootstrap` returns shell entities, the visible Work
  projection, one active transcript window (40 rows by default, 200 max), and
  server-derived per-workspace unread/busy counts. The full `snapshot` RPC
  remains the recovery path and still returns the complete state.
- **Work projection.** Only dispatch groups that are active, needs-you, or
  inside the shared 1.2 s completion hold are included. Long-retained terminal
  rows (24 h retention) with no visible group do not travel. A fully terminal
  group whose last approval just resolved starts its hold from that resolution.
- **Transcript windows.** `transcript.window` pages durable messages by
  `seq` (`beforeSeq`, bounded limit) and reports `hasMoreOlder`. The client
  keeps at most 240 patched messages per workspace. Paging an older window
  anchors the loaded range there, so ordinary patches preserve the fetched
  page; returning to the bottom fetches the newest bounded window.
- **On-demand results.** A result message outside the loaded window is fetched
  by id through `message.get` when opened; the whole history is never loaded
  to show one result.
- **Server-derived counts.** Unread and busy counts are computed from durable
  messages/tasks at bootstrap, snapshot, scoped resync, and the revision
  heartbeat. Patches stay entity-only so a 5k-task burst remains linear; the
  rail reads the server counts and falls back to the old scan only for legacy
  servers.
- **Scoped resync.** The store records the latest version that changed each
  scope (`shell`, `work`, `transcript`). A feed gap asks `changes.since` for
  those versions and calls `resync` with only the scopes whose version moved
  after the client cursor. A malformed or unknown batch that only mentions Work
  entities resyncs the Work scope; other malformed responses and epoch changes
  fall back to the full snapshot.
- **Bounded client memory.** Patched message windows and visible-work pruning
  are enforced in `src/v2/tui/client-store.ts`; a long-session benchmark feeds
  thousands of patches and asserts both bounds hold. A full snapshot remains
  the legacy recovery path and is applied whole.

The scoped paths are covered by `src/v2/scoped-read.test.ts`,
`src/v2/scoped-read-service.test.ts`, `src/v2/tui/client-store.test.ts`, and
the fake TUI checks; payload/latency budgets run as part of `npm test`.

## v7 Work lifecycle and recovery model

This section is the end-to-end model for the v7 Work pane. The architecture
decision and its invariants are recorded in
[ADR 0002: Server-authoritative durable patch feed](adr/0002-durable-patch-feed.md).
The message, feed, and scoped-read mechanics are described in the preceding
v7 sections; this section explains how Work moves through them.

### Dispatch groups

A **Dispatch group** is the set of Subtasks caused by one dispatch action: one
user command plus every descendant handoff, delegation, peer turn, synthesis,
completion hop, and group-scoped completion batch it caused. The group id is
durable on the Subtask, and the group's caps and counters live in the durable
dispatch ledger described in [Dispatch budgets](#dispatch-budgets). A
continuation group is a linked segment of the same command, not a new command.

- **Minting.** A user message mints exactly one group and passes it to every
  task in that fan-out. The root work item carries the group in its
  idempotency key, so sending the same command again creates a new group and
  task, while duplicate tool calls inside one run still dedupe.
- **Inheritance.** Agent-created work inherits the parent/run group. Handoffs,
  peer turns, synthesis, completion hops, and approval-created work carry or
  resolve the same group. Retry, restart, reassign, and cancel preserve it.
- **Legacy rows.** A task without a stored group resolves one from its root
  ancestor. The derivation is deterministic and does not expose the root id.
- **Completion batches.** A leader review consolidates only completions from
  one group, so unrelated commands never share a review.

### Visibility, hold, and needs-you

The Work pane derives its visible groups from the durable task list on every
static refresh. For each group it counts active and done members and decides
whether to show it:

- A group is visible while any member is non-terminal.
- A complete group remains visible for a shared **1.2 s hold** derived from
  its latest terminal timestamp (or the latest linked approval resolution).
  The hold is shared, so all cards in the batch clear together.
- A **needs-you** member overrides the hold. A task needs the user when it is
  interrupted, gated on a still-pending approval (`approvalID`), or blocked by
  a pending native permission mirror. A needs-you group stays until the
  decision resolves; the hold then starts from the resolution time.
- Terminal means replied, failed, or cancelled. A terminal task with a pending
  decision still counts as needs-you.
- A new command appends a new group without disturbing an older one. The
  newest group receives visible capacity under height pressure; older groups
  become compact summaries.
- The cursor and every Work action operate on non-terminal cards only.
  Terminal cards are display-only, and overflow is never selectable.

### Terminal events

Each task emits exactly one canonical terminal event: `finished`, `failed`, or
`cancelled`, with the terminal task row as the durable record. A plain failed
task no longer emits a duplicate generic `Subtask failed` line; correlation
specific handoff and peer-turn notices remain. Failure and success are
therefore symmetric in the transcript and in the Work card state.

### Work pane projection

The Work pane maps visible groups to static cards and a separate animated
layer:

- The card header is name left in pale blue, a flexible spacer, then the glyph
  and the uppercase status. The status word never truncates; the name
  truncates first.
- Ticket #160/#164: cards and compact rows carry the dispatch budget just left
  of the glyph (`hops 3/8 · cmd 21 left`, `3/8 · 21 left`, or `3/8`). The label
  yields before the status word and the right edge; at the narrowest rows a
  long title yields before the budget. Group labels add hop and command
  remaining, `EXHAUSTED`, and `CONT N · from root` lineage. Exhaustion uses
  the warning tone, never the failure treatment.
- State tones are pure mapping: WORKING/RETRYING use a yellow Braille glyph, a
  grey status word, and a yellow left bar; REPLIED uses a green dot, status,
  and bar; NEEDS YOU uses a yellow diamond, status, and bar; QUEUED is faint
  and muted; FAILED is red; CANCELLED is a faint cross-out. The rounded border
  stays neutral and selection is a focus border, not a green gutter.
- Static card data (identity, title, detail, status, tones, tide variant) is
  memoized and rebuilt only when the task, approval, retry countdown, or layout
  changes. Only the glyph and tide cells read the animation clocks: Braille
  runs at 8 fps and the tide at 15 fps. A one-shot invalidation timer covers
  status deadlines, lease expiry, retry countdowns, and the group hold; it is
  not an animation clock.
- Reduced motion and `NO_COLOR` pin the glyph and tide to frame zero while
  preserving the state word, final glyph, and layout.

### Durable feed and recovery

The server store is the source of truth; the client store is disposable. The
full recovery ladder is:

1. **Durable write.** A mutation persists its entity and the meta version,
   appends one change record, and schedules publication.
2. **Patch.** Protocol-3 clients apply full-entity upserts/removes atomically.
   Duplicate delivery is harmless; an older batch is ignored; a remove leaves
   a short client tombstone.
3. **Heartbeat.** A cheap revision check runs about every 2 s idle and 1 s
   while Work is live, and immediately on reconnect.
4. **`changes.since`.** A version gap asks the server for the missing range.
   The server returns contiguous batched entries or a reset that names why
   (`invalid-cursor`, `epoch`, `future-version`, `ring-gap`). The response is
   JSON-sanitized at the RPC boundary: the host rejects explicit `undefined`
   entity fields, so absent optional fields are omitted exactly as they are at
   the snapshot/bootstrap boundaries.
5. **Scoped resync.** A reset repairs only the scopes whose recorded version
   moved (`shell`, `work`, `transcript`). A malformed batch that mentions only
   Work entities repairs the Work scope; other malformed input falls back.
6. **Full snapshot.** A foreign boot epoch on a patch has no comparable
   cursor, so it never enters `changes.since`; a trailing 200 ms window
   coalesces one forced snapshot. An unrecoverable scoped read also uses the
   full durable snapshot. It is the last resort, not the steady-state path.
7. **Legacy fallback.** Protocol-2 clients keep the old changed event and
   snapshot path. They never see a protocol-3-only shape as an authoritative
   replacement.

Steady-state Work changes do not wait for a snapshot. A handoff or delegation
publishes its task change before pump work, so its card appears from the patch
path. A task mutation that is still in the write queue is not visible to a
reader that requires consistency until the queue settles.

### Streaming checkpoints

Workspace text streams as a coalesced ephemeral event carrying the full
accumulated text for the visible row. The event is version-neutral and never
enters the change ring. Live text is checkpointed to storage at a bounded
interval without a coordination version or patch. On reload the last
checkpoint is present, `streaming` is cleared, and the row is marked
interrupted; at most the text after the final checkpoint is lost. Finalization
drops queued stream text, persists once, and publishes one exact durable
message upsert, which replaces the live overlay exactly once and repairs a
missed ephemeral event.

### Tier 3 scale path

Scoped bootstrap, Work projection, transcript windows, on-demand result fetch,
and server-derived counts are gated read models. They are described under
[the gated Tier 3 reads](#v7-tier-3-scoped-reads-ticket-141). The gate decision
travels with every bootstrap/resync/heartbeat response. A disabled gate keeps
the snapshot path; an enabled gate never changes authority, only payload size.

### Bounded memory and diagnosis

The client keeps at most 240 patched transcript rows per workspace and prunes
invisible terminal Work rows; a full snapshot remains the legacy recovery path
and is applied whole. Clone, patch, bootstrap, and resync diagnostics report
counts, sizes, versions, and timings only — never credentials or conversation
content. `ENSEMBLE_DEBUG_CLONES=1` exposes full-clone counts and timing on the
`diagnostic` RPC.

### Structured operational logging (tickets #145, #150)

The service and TUI each own a small structured logger. Every row carries its
role, a stable instance ID (the service boot epoch or the TUI mount UUID), and
the `node:worker_threads` thread ID; one service log is kept per role, not per
instance. The service observes store writes and emits task lifecycle
(`task.created`, `task.transition`, `task.claimed`, `task.completed`,
`task.failed`, `task.cancelled`), message append/finalize, approval
requested/resolved/superseded, init lifecycle, retry scheduling/skips, feed
batches/resets, and refresh measurements. `service.location` is logged once on
the first viewed directory, and `logs.recent` accepts an `instanceID` filter.
Lease heartbeats and streaming deltas never produce lines; they remain counters
or trace-only data.

The `dispatch` category records `dispatch.group.created`, `dispatch.group.continued`,
`dispatch.group.exhausted`, `dispatch.group.closed`, `dispatch.group.reconciled`,
`dispatch.group.refused`, `dispatch.hop.consumed`, `dispatch.hop.refused`, and
`dispatch.settings.invalid`. Rows carry workspace, group, root, parent,
continuation index, actor/recipient IDs, work kind, caps, used and remaining
counts, depth, reason code, and duration. They never carry task titles,
instructions, handoff paths, file content, or conversation text. Exhaustion and
refusal rows are warnings; routine hops stay info. `logs.recent` filters by
category and the `diagnostic` response includes both the compact ledger summary
and the full group entities. `scripts/log-summary.mjs` reports group, hop,
exhausted, continued, refused, closed, reconciled, and invalid-settings counts;
`--group <id>` includes the group's continuation lineage (rows whose
`dispatchGroupID` is the group or whose `rootID` is the group).

A dispatch refusal is a controlled stop, not a generic failure. A failure
record recognizes a budget stop only from structured evidence (the dispatched
error code/type plus a `DispatchRefusalLayer`); refusal copy is never matched
as a second vocabulary. It reports `FailureClass "budget"` with reason code
`budget-exhausted`, and the Work pane renders exhaustion with the warning tone
instead of FAILED. The doctor checks every group against its
captured caps, checks a group counter is never below its visible counted work
(the unsafe direction; a higher counter after terminal retention is allowed),
checks each root's command counter equals the sum of its groups, checks every
continuation has a parent and reaches its root, and flags an active
continuation with no work and no spent hops.

`feed.reset` names its reason and identical resets collapse to one warning per
10 s per instance with a `suppressed` count; a burst that stops also reports a
trailing summary when the window closes (and `logs.recent`/shutdown flush any
pending count). Every TUI `feed.gap` observation increments the logger's
`feedGaps` stat, but a burst collapses into one trailing line per 10 s: a
caught-up `changes.since` recovery is debug `feed.gap.recovered`, while a
full-snapshot fallback, exhausted recovery passes, or a reset/epoch/malformed/
other decision warns as `feed.gap`. `:logs` shows `feedGaps`, and the TUI
coalesces foreign-epoch patches into one forced snapshot instead of a reset
loop.

A failure is a self-contained JSONL record, not a longer `task.error` string.
Each failed attempt emits `failure.attempt` at `warn`, an uncertain outcome
emits `failure.parked` at `warn`, and a permanent failure emits
`failure.terminal` at `error`. The record carries the error name/message/code/
stack/cause chain, task and dispatch-group identity, attempt and deadline,
provider/model/variant, run/session IDs, tool outcomes, the last eight message
metadata rows, and the retry/park/terminal decision. Task instruction,
constraints, expected output, and message text are included only when content
logging is enabled.

```text
ENSEMBLE_LOG=0|1                 disable/enable all logging (default on)
ENSEMBLE_LOG_LEVEL=error|warn|info|debug|trace   default info
ENSEMBLE_LOG_DIR=<path>          default $XDG_STATE_HOME/ensemble/logs
ENSEMBLE_LOG_CONTENT=1           include task/message text (default off)
ENSEMBLE_LOG_STDERR=1            mirror lines to stderr
```

Each process writes `<role>-<date>-<pid>.jsonl` and
`<role>-failures-<date>-<pid>.jsonl` with `0600` permissions in a `0700`
directory. Main logs rotate at 10 MB with five files and seven days; failure
logs rotate at 20 MB with five files and 30 days. Writes are batched
asynchronously; overflow drops the oldest queued line and increments
`dropped`, and a write failure increments `failedWrites` without failing work.
Tests keep the ring but do not write into the user's state directory unless a
test supplies an explicit directory.

`logs.recent` returns the bounded ring filtered by limit, level, category,
event prefix, or task. `:logs` opens the viewer; `:logs failures` filters
failure records; `:logs task <id>` shows one task timeline. The viewer shows
the current sink paths, ring/drop counters, and content flag, with `r` to
refresh, `j`/`k` to scroll, and `Esc` to close. `diagnostic` includes the same
log summary for the doctor and tests.

Redaction covers bearer/basic tokens, credential-bearing URLs, API-key-shaped
values, GitHub tokens, and credential field names. Logs stay local and are
never committed. They must not be attached to public issues without review.

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
