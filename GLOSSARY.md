# Ensemble

Ensemble is a persistent team workspace inside OpenCode. These terms describe the agreed product concepts, not an implementation architecture.

## Language

**Agent**: A named teammate with a lasting identity, instructions, model settings, memory, and Skillbox. Its identity is independent of its current name or conversations.
_Avoid_: Bot, worker (when referring to the lasting teammate).

**Roster**: The user's personal collection of agents, reusable across projects.

**Skillbox**: The exclusive collection of optional skills assigned to an agent. A skill is reusable guidance, not a grant of tool permissions.
_Avoid_: Toolbox (when referring to assigned skills).

**Workspace**: A directory-bound project room with a group chat, a roster, and exactly one leader. One canonical directory belongs to one workspace.
_Avoid_: Channel, room, group (when referring to this concept).

**Group chat**: The shared transcript of a workspace where the user and agents communicate. It is the primary interface; native sessions are execution detail underneath.

**Leader**: The workspace member responsible for receiving unaddressed messages, coordinating work, and delegating subtasks. Leadership does not confer additional permissions.

**Mention**: An explicit recipient reference introduced with `@` and associated with an agent's lasting identity. `!` is accepted as an alias.

**Direct conversation**: A private conversation between the user and one agent, separate from a workspace group chat.

**Handoff**: A visible request from one agent to another, with a recipient, typed task, constraints, expected answer, and status.

**Subtask**: A unit of work inside a workspace with an assignee, typed instructions, and exactly one visible state: pending, working, or replied.

**Task tree**: The parent/child relationship between a user request, a leader's delegation, worker subtasks, and an optional leader synthesis.

**Work**: A queued or running execution of a subtask, with an agent, mode, and status.

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

**Leader key**: The `~` prefix that opens Ensemble keyboard navigation outside text entry. `~?` shows all shortcuts; `~q` leaves Ensemble.

**Backup model**: An alternative model in an agent's ordered fallback list, used for eligible model availability failures.
