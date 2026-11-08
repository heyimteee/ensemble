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

**Group chat**: The shared transcript of a workspace where the user and agents communicate. It is the primary interface; native sessions are execution detail underneath.

**Leader**: The workspace member responsible for receiving unaddressed messages, coordinating work, and delegating subtasks. Leadership does not confer additional permissions.

**Mention**: An explicit recipient reference introduced with `$` and associated with an agent's lasting identity. `!` is accepted as an alias. `@` is reserved for workspace file references only.

**Direct conversation**: A private conversation between the user and one agent, separate from a workspace group chat.

**Handoff**: A visible request from one agent to another, with a recipient, typed task, constraints, expected answer, and status.

**Subtask**: A unit of work inside a workspace with an assignee, typed instructions, and exactly one visible state: pending, working, or replied.

**Task tree**: The parent/child relationship between a user request, a leader's delegation, worker subtasks, and an optional leader synthesis.

**Work**: A queued or running execution of a subtask, with an agent, mode, and status.

**Work status**: The derived lifecycle of Work: pending, working, waiting, retrying, needs_you, replied, failed, stalled, or cancelled. Only failed means a native execution error; stalled covers delivery, lease, or attempt exhaustion. The persisted subtask state stays pending, working, or replied. Non-terminal cards stay mounted; completed groups clear after the shared hold.

**Recovered work**: Work whose real answer arrives after a retry or a false stalled/terminal state. The answer supersedes transient retry and failure notices, the card ends replied, and a structured `task.recovered` audit row records the previous state. A completed group's retained history is a separate Work-pane concern.

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

**Native session**: An OpenCode session in which an agent's execution and tool activity can be inspected through OpenCode's existing interface. A workspace binds one native session per agent.

**Session binding**: The association between a workspace, an agent, and that agent's persistent native session and behavioral version.

**Mode**: The global interaction state—Normal, Insert, Visual, or Command—that decides whether keys act on lists or type into the focused text editor.

**Leader key**: The `Space` prefix that opens Ensemble's keyboard navigation menu outside text entry.

**Backup model**: An alternative model in an agent's ordered fallback list, used for eligible model availability failures.
