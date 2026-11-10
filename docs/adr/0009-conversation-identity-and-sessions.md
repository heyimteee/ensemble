# ADR 0009: Conversation identity and per-conversation native sessions

- **Status:** Accepted
- **Date:** 2026-11-10
- **Tickets:** spec #209, ticket #211 in `heyimteee/ensemble`
- **Supersedes:** the workspace/agent binding key in [ADR 0007](0007-apply-agent-behavior-in-place.md), decision 1. Its in-place behavior-apply rules remain in force.
- **Related:** [ADR 0003](0003-single-service-and-safe-recovery.md), [ADR 0004](0004-dispatch-budgets-and-continuation.md), [ADR 0008](0008-task-level-history-and-rollup.md), [native host contract](../verification/2026-11-10-native-host-contract.md)

## Context

Ensemble binds one native session per workspace and agent. A workspace member's
direct conversation reuses that workspace session; an agent outside the
workspace uses a home session. The model was built when the group chat was the
only primary surface and the native session was execution detail underneath it.

Native-first makes the native session a primary conversation surface. A user
types directly into it, and the host delivers that prompt as a native inbox
item. The prompt carries no Ensemble conversation tag: the host identifies the
session, the user message, and the assistant message, not the Ensemble
conversation. Service-originated prompts can carry metadata, but a user-typed
native prompt cannot.

When a workspace group and a direct conversation share one session, an inbound
native prompt has no reliable identity. The service cannot tell whether to
append it to the group transcript or a direct transcript, which Work card to
open, or which history to page. Text leaks between conversations, a direct
conversation has no trustworthy Work surface, and work is attributed by timing
rather than by identity. The [native host contract](../verification/2026-11-10-native-host-contract.md)
also recorded that `session.idle`, `session.status`, and `session.synthetic`
were not delivered in the headless probe, so identity cannot be recovered from
later timing events either.

ADR 0007 remains in force for behavior changes: role, model, and Skillbox edits
apply to the existing session in place and never rotate it. This ADR changes
the binding key and the session selection, not that rule.

## Decision

### 1. Sessions are bound per agent and conversation

A binding is keyed by agent and conversation, not by workspace and agent. A bound
native session belongs to exactly one agent and one conversation; an agent has
exactly one current session per conversation, and a conversation has exactly one
current session per participating agent. A reverse session-to-binding index is
the ingestion lookup, so an event is attributed to its conversation and agent in
constant time without guessing from order or time.

| Conversation | Channel key | Native session directory | File access |
|---|---|---|---|
| Workspace group | workspace | Workspace directory | Workspace files and tools |
| Workspace direct | agent and workspace | Workspace directory | Workspace files and tools; separate transcript |
| Home direct | agent | The agent's home directory | Agent home only; no workspace files |

A workspace member's direct conversation uses the workspace-direct binding for
the active workspace. An agent with no workspace uses the home-direct binding.
The direct conversation never reuses the group session, and a group turn never
reuses a direct session.

The table describes one agent's bindings. A workspace group therefore has one
group session for each member agent; those sessions share a conversation channel
but not native context.

The group and direct channels are separate even though an agent's two workspace
sessions share a directory. Sharing a directory is a file-access decision; it
is not a transcript, context, queue, or Work decision.

### 2. Why one shared session per agent is rejected

A shared session cannot answer "which conversation is this?" for a user-typed
native prompt. Adding a conversation tag does not fix it: the tag would exist
only for service-originated prompts, while native-first exists precisely to
accept prompts typed in the host. Deriving the conversation from recent activity
is timestamp correlation under another name, and it fails on retries, queued
prompts, reconnects, and background subagent turns.

The shared model also forces four secondary failures:

- **Privacy.** Group and direct context merge. A prompt typed in a direct
  conversation can be answered in the group, and a group reply can appear in a
  direct conversation.
- **Work identity.** One session produces one turn stream for two conversations.
  A card cannot be scoped, a direct card has no home, and history cannot be
  paged per conversation.
- **Independence.** One active turn blocks the other conversation. Queue depth,
  retry, interruption, recovery, and busy state become shared.
- **Adoption.** Adopting a session for a direct conversation would retarget the
  group's context, and the reverse would retarget a private conversation.

Reusing the group session for a direct conversation saves context but makes the
privacy and identity failures unavoidable. The accepted cost is a second session
with duplicated project context for the same agent.

### 3. Conversation identity is durable and channel-scoped

Every message, native turn, Work card, route refusal, and history page carries
its conversation channel. A group message cannot be appended to a direct
channel, and a direct message cannot mint work in a workspace group. The direct
channel key is stable for the agent and optional workspace, so the same agent's
direct conversation in two workspaces has two channels and two sessions.

A conversation may exist before its first native session. The first prompt
creates the session and binding; an existing session is adopted as described
below.

### 4. Directory and file-access trade-offs

- **Workspace group and workspace direct share the workspace directory.** Both
  can read project files, run workspace tools, and honor workspace config. They
  do not share context, transcript, queue, or Work history.
- **Home direct has no workspace files.** It is private to the agent and
  appropriate for work that is not project-scoped.
- **A directory move changes future file access for that conversation.** It does
  not move or merge context, and it does not change the other conversation's
  session.
- **The same repository is read by two sessions.** Group and direct work can
  duplicate reads, token spend, and tool activity. This is the cost of
  isolation.
- **Membership changes do not retarget a session.** Adding an agent to a
  workspace selects that workspace's direct conversation for its next direct
  message while the workspace is active; the home session remains in binding
  history. The user may adopt the home session into the workspace direct
  conversation, which moves it only under the rules below.
- **Removing an agent from a workspace does not delete the group binding.** The
  direct conversation resolves to the home-direct binding; the group session
  remains bound to the workspace group for former-member history and is never
  relabeled as a direct session.

### 5. Adoption targets a conversation

Adoption is the only explicit way to bind an existing session to an agent's
conversation.

- The target is an agent's conversation binding, never a bare session. One
  session cannot serve two conversations at once.
- The service validates that the session exists, is a root session (not a
  subagent child), is not archived, is not busy for a required move, and is not
  actively bound elsewhere.
- A session already bound to another conversation is reassigned only with
  explicit confirmation. The previous conversation records the id in binding
  history and creates a fresh session on next use.
- A directory move requires confirmation. The service moves only an idle
  session. The host accepts a busy move by queuing it, so a successful move call
  is not evidence that the move happened; the binding updates only after
  `session.moved` or a confirmed location through `session.get`. A failed or
  still-queued move leaves the binding unchanged.
- Adoption applies the current identity, model, and Skillbox permissions to the
  session, then writes a visible native heads-up naming the Ensemble conversation
  it now serves.
- The previous current session remains in binding history. Adoption is
  reversible by rebinding to a history entry; it never deletes the old session.

The session picker lists recent sessions in the current scope first (direct,
workspace, project, all), searches the selected scope, and refreshes on session
events rather than a timer. A session that needs a move or is busy shows that
warning before adoption is confirmed.

## Rejected alternatives

- **One shared session per agent with a prompt tag.** Rejected: native user
  prompts carry no tag, and timing inference recreates the same failure.
- **Reuse the group session for direct chat to preserve context.** Rejected: it
  merges privacy boundaries and makes direct work unidentifiable.
- **Fork or merge a session per conversation.** Rejected: the host cannot merge
  context, and a fork still needs an identity decision for every prompt. ADR 0007
  already rejected fork/merge for behavior changes.
- **Bind on the agent's most recent session.** Rejected: recent is not identity;
  a retry or background turn can win the race.
- **Move a session automatically when workspace membership changes.** Rejected:
  it changes file access and context without confirmation, and the host only
  queues a busy move.
- **Rotate the session when agent behavior changes.** Rejected by ADR 0007;
  behavior still applies in place.

## Consequences

### Accepted trade-offs

- **More native sessions.** Each agent can have a group session, one
  workspace-direct session per workspace, and one home session. Sessions,
  context, and token spend increase.
- **Workspace direct duplicates project context.** The privacy benefit is worth
  the duplicated reads.
- **A direct conversation can span membership changes.** A home session stays in
  history when the agent joins a workspace, and the next direct message uses a
  new workspace session unless the user adopts it. Leaving reverses the
  selection; no session is deleted.
- **Adoption is deliberate.** A move can be refused or deferred while busy; the
  binding is not updated optimistically.
- **Ingestion needs a reverse index.** The index is a binding invariant, not a
  cache of convenience.
- **One service and the dispatch ledger are unchanged.** ADR 0003 and ADR 0004
  remain in force.
- **Direct and group are isolated by construction.** Separate channels,
  sessions, queues, transcripts, and Work history mean a direct message cannot
  mint group work, and a group mention cannot appear in a direct conversation.

### Follow-up rules

- Do not bind two conversations to one native session.
- Do not bind two agents to one native session.
- Do not select a session by recency, timestamp, or last active agent.
- Do not let a direct message route work into a workspace group.
- Do not update a binding before a move is confirmed.
- Do not rotate a session for an agent behavior change; apply in place per
  ADR 0007.
- Keep binding history append-only; adoption never deletes a session.

## Validation

- The [native host contract](../verification/2026-11-10-native-host-contract.md)
  records prompt/inbox identity, delivery order, and busy-move behavior on
  OpenCode 2.2.6.
- Tickets #214 and #224 provide live acceptance for direct/group separation,
  workspace file access, adoption, and busy moves.
- `npm run verify` passes for this documentation ticket. No product behavior
  changed.

## References

- Parent specification #209 and ticket #211 in `heyimteee/ensemble`
- [ADR 0007: Apply agent behavior changes to the existing native session](0007-apply-agent-behavior-in-place.md)
- [Native host event contract](../verification/2026-11-10-native-host-contract.md)
- [Glossary](../../GLOSSARY.md)
