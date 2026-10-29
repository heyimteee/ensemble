# Ensemble

Ensemble is a persistent team workspace inside OpenCode. These terms describe the agreed product concepts, not an implementation architecture.

## Language

**Agent**: A named teammate with a lasting identity, instructions, model settings, memory, and Skillbox. Its identity is independent of its current name or conversations.
_Avoid_: Bot, worker (when referring to the lasting teammate).

**Roster**: The user's personal collection of agents, reusable across projects.

**Skillbox**: The exclusive collection of optional skills assigned to an agent. A skill is reusable guidance, not a grant of tool permissions.
_Avoid_: Toolbox (when referring to assigned skills).

**Project**: The body of work associated with a project directory or repository and its channels.

**Channel**: A project conversation with a defined membership and exactly one leader.
_Avoid_: Room, group (when referring to this concept).

**Leader**: The channel member responsible for receiving unaddressed messages and coordinating work. Leadership does not confer additional permissions.

**Mention**: An explicit recipient reference introduced with `!` and associated with an agent's lasting identity.

**Direct conversation**: A private conversation between the user and one agent, separate from channel conversations.

**Handoff**: A visible request from one agent to another, with a recipient, context, result, and status.

**Task chain**: A connected sequence of work and handoffs originating from a request.

**Approval**: An explicit decision requested from the user before dependent work can proceed. It is distinct from, and cannot override, OpenCode's tool permissions.

**Conversation queue**: Pending messages awaiting an agent's availability in one conversation.

**Editing queue**: Pending editing work coordinated across Ensemble channels that target the same checkout.

**Agent memory**: Saved knowledge belonging to an agent, distinct from conversation history. Its scope can be project-specific or cross-project.

**Channel memory**: Saved project facts and decisions shared with all members of one channel.

**Memory provenance**: The recorded origin of a memory: Automatically learned or Manually added. Later edits do not erase its origin.

**Native session**: An OpenCode session in which an agent's execution and tool activity can be inspected through OpenCode's existing interface.

**Backup model**: An alternative model in an agent's ordered fallback list, used for eligible model availability failures.
