# Ensemble

Ensemble is a persistent team workspace inside OpenCode. These terms describe the agreed product concepts, not an implementation architecture.

## Language

**Agent**: A named teammate with a lasting identity, instructions, model settings, memory, and Skillbox. Its identity is independent of its current name or conversations.
_Avoid_: Bot, worker (when referring to the lasting teammate).

**Roster**: The user's personal collection of agents, reusable across projects.

**Skillbox**: The exclusive collection of optional skills assigned to an agent. A skill is reusable guidance, not a grant of tool permissions.
_Avoid_: Toolbox (when referring to assigned skills).

**Skill**: Reusable guidance that an agent loads through OpenCode's native skill tool. The host catalog supplies skills; the Skillbox decides assignment. A skill is not a tool permission.

**General skill**: A catalog skill assigned to no workspace member. It has no owner, so the workspace leader handles it through triage.

**Skill invocation**: An explicit `/skill` token in composer text, resolved by the shared planner to the addressed agent.

**System Agent**: A non-roster transcript identity that reports workspace-level jobs such as init.

**Init job**: A durable workspace-level job that runs native `/init` in a temporary session and reports through the System Agent. It is not a Subtask and does not enter the work queue.

**Workspace**: A directory-bound project room with a group chat, a roster, and exactly one leader. One canonical directory belongs to one workspace.
_Avoid_: Channel, room, group (when referring to this concept).

**Group chat**: The shared transcript of a workspace where the user and agents communicate. The group chat and the workspace group's native session are two views of one conversation: the native session is where the agent works, and the group chat is the durable team record and router.

**Leader**: The workspace member responsible for receiving unaddressed messages, coordinating work, and delegating subtasks. Leadership does not confer additional permissions.

**Mention**: An agent name introduced with the routing operator (`$`, or `!` as its alias). A mention routes work only in a workspace group conversation; a bare name is a reference, and a direct conversation never routes. `@` is reserved for workspace file references only.
_Avoid_: Bare-name mention (for a reference), @mention (for an agent).

**Routing operator**: The `$` prefix that turns a known agent name in sanitized prose into a work recipient; `!` is an accepted alias. It applies only to prose, so code blocks, inline code, URLs, and file paths never route. Without the operator, a name is only a reference. See [ADR 0011](docs/adr/0011-mention-routing-and-budgets.md).
_Avoid_: Mention sigil, @-mention.

**Direct conversation**: A private conversation between the user and one agent, separate from a workspace group chat. It has its own conversation channel, native session, and Work history, and it never shares the group session.

**Conversation channel**: The durable identity that scopes one conversation's transcript, messages, native turns, and Work history. Group and direct conversations are separate channels, so a message or Work card belongs to exactly one conversation.
_Avoid_: Thread, room.

**Direct session**: The native session bound to one direct conversation. A workspace direct session runs in the workspace directory; a home direct session runs in the agent's home directory. It is never the workspace group session.
_Avoid_: DM session (when distinguishing the two direct kinds), private group session.

**Handoff**: A visible request from one agent to another, with a recipient, typed task, constraints, expected answer, and status.

**Subtask**: A unit of work with an assignee, typed instructions, and one stored state: pending, working, or replied. Its visible lifecycle is Work status. A native turn is a Subtask of kind turn; it is adopted rather than queued.
_Avoid_: Task (when referring to the durable unit), job.

**Task tree**: The parent/child relationship between a user request, a leader's delegation, worker subtasks, and an optional leader synthesis.

**Work**: A visible unit of execution with an agent, mode, and status. It is either queued or running Subtask work, or a native turn without a lease, claim, or attempts.
_Avoid_: Task (for the card).

**Tool surface**: The set of Ensemble tools registered in a native session. The native surface keeps only decision tools (task status, batch review, ask-person, memory, share); the legacy surface is the one-release rollback that restores chat routing and explicit delegate/handoff. Roster, conversation, and budget values arrive in the injected `ensemble_turn` block instead of read-only tool calls. See [ADR 0011](docs/adr/0011-mention-routing-and-budgets.md).
_Avoid_: Tool list (when distinguishing migration surfaces), tool budget.

**Work status**: The observed lifecycle of Work: pending, working, waiting, retrying, needs you, replied, failed, stalled, or cancelled. Failed names a native execution error; stalled names a delivery, lease, or attempt-exhaustion problem. Work status is derived from the durable delivery and execution facts, not read from a stored label.
_Avoid_: Task state (when referring to the derived lifecycle), timeout error (for a stall).

**Recovered work**: Work whose real answer arrives after a retry or a false stalled or terminal state. The answer supersedes transient retry and failure notices.

**Rail**: The left navigation surface, split into Agents grouped by primary workspace and a separate Workspaces section. It is navigation over the roster and workspace list, not a second store.

**Work pane**: The right surface that shows dispatch groups of Work in ACTIVE and HISTORY views, with HISTORY read from the conversation's Work history page. It is a view over the task graph, not a separate task store or scheduler.
_Avoid_: Task board (for the pane), subtask list (when referring to the grouped surface).

**Work history page**: The server-paged record of a conversation's terminal Work cards. It is a read of durable Work, independent of ACTIVE and of any client's earlier state, not a second store.
_Avoid_: Archive (for terminal Work), task log.

**Dispatch group**: The set of Subtasks caused by one dispatch action: one user command plus every descendant handoff, delegation, peer turn, synthesis, completion hop, and group-scoped completion batch it caused. A new command mints a new root group; a continuation group is a linked segment of the same command. A legacy task without a stored group derives one from its root ancestor.
_Avoid_: Batch (for the whole dispatch), run (a single execution, not the fan-out).

**Hop**: One consuming agent-created delegation or explicit handoff. A user command and its initial recipients, completion handoffs, batch review, synthesis, peer turns, retries, restarts, recovery, and idempotent replays consume no hop. Cancellation does not refund one.

**Command budget**: The user-owned ceiling on hops for one user command across every group. It is the anti-laundering cap: a continuation cannot create a fresh command total.

**Group budget**: The hops allowed inside one dispatch group. The root group captures the user's group setting; a continuation group is sized by the leader within the command remaining.

**Task budget**: The direct dispatches a delegation or handoff recipient may make. It is required on every call; zero is a one-shot ask. It bounds local fan-out, not a reserved subtree.

**Depth**: The longest ancestor chain inside one group segment. The user sets the ceiling; a continuation starts a fresh segment.

**Continuation group**: A leader-opened, linked segment of the same command after the referenced group is exhausted. It references its parent and root, resets depth, and spends from the same command ledger. Only the leader may open one, and only while the command remaining and continuation count allow.

**Dispatch ledger**: The durable per-group record of caps, used hops, depth, command counters, continuation lineage, and closure. Budget state (active, exhausted, closed) is derived from it, never stored separately.

**Exhausted group**: A group with no hop left, either because its own cap or the command cap is spent. It is a controlled stop, not a failed task.

**Pending settings**: A saved role, model, or Skillbox change that will apply to subsequent work, not silently to an active turn.

**Proposal**: An agent-initiated request for a roster, membership, leadership, or configuration change that only the user can authorize.

**Approval**: An explicit decision requested from the user before dependent work can proceed. It is distinct from, and cannot override, OpenCode's tool permissions.

**Conversation queue**: Pending messages awaiting an agent's availability in one conversation.

**Editing queue**: Pending editing work coordinated across subtasks that target the same workspace checkout.

**Agent memory**: Saved knowledge belonging to an agent, distinct from conversation history. Its scope can be project-specific or cross-project.

**Workspace memory**: Saved project facts and decisions shared with all members of one workspace.

**Memory provenance**: The recorded origin of a memory: Automatically learned or Manually added. Later edits do not erase its origin.

**Native session**: An OpenCode session in which an agent's execution and tool activity can be inspected through OpenCode's existing interface. A conversation's bound session belongs to exactly one agent and one conversation. An agent has one native session per conversation rather than one workspace session shared by both; a workspace therefore binds one native session per agent per conversation (a group session and a direct session), not one per agent. See [ADR 0009](docs/adr/0009-conversation-identity-and-sessions.md).
_Avoid_: Agent session (when the conversation is the identity), shared session (when two conversations would share one).

**Native turn**: One prompt-and-execution cycle in a conversation's native session: the inbox item that started it, the agent execution, and the terminal result. A native turn is durable Work; a host retry stays inside the same turn. See [ADR 0010](docs/adr/0010-native-turn-ingestion.md).
_Avoid_: Native message (for the turn), run (when including retries).

**Session binding**: The association between an agent, a conversation, and that conversation's native session and behavioral version. Each agent has its own binding for the group conversation and for its direct conversation.
_Avoid_: Workspace session (when the binding is per agent and conversation).

**Mode**: The global interaction state—Normal, Insert, Visual, or Command—that decides whether keys act on lists or type into the focused text editor.

**Leader key**: The `Space` prefix that opens Ensemble's keyboard navigation menu outside text entry.

**Backup model**: An alternative model in an agent's ordered fallback list, used for eligible model availability failures.
