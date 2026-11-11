# ADR 0011: `$Name` routing grammar and server-owned budgets

- **Status:** Accepted
- **Date:** 2026-11-10
- **Updated:** 2026-11-11 (contract v6 and roster, #238)
- **Tickets:** spec #209, tickets #211, #238 in `heyimteee/ensemble`
- **Supersedes:** none
- **Related:** [ADR 0001](0001-native-skill-boundary.md), [ADR 0003](0003-single-service-and-safe-recovery.md), [ADR 0004](0004-dispatch-budgets-and-continuation.md), [ADR 0009](0009-conversation-identity-and-sessions.md), [ADR 0010](0010-native-turn-ingestion.md)

## Context

Agents currently choose and call an Ensemble tool to talk to the team, hand off
work, or report completion. They forget, call the wrong tool, pass the wrong
budget, and spend context on tool schemas and extra round-trips. The native
session is where the agent actually writes, so coordination should read like
normal prose there.

The current mention parser also matches inside fenced code, inline code, URLs,
and file paths. A bare roster name is not distinguished from a routed mention.
That is tolerable when a composer message is validated before send; it is not
tolerable when the native session is the primary surface and an agent writes
technical prose.

ADR 0001 keeps native skill execution authoritative and makes `@` file-only.
ADR 0004 owns the dispatch ledger and its layered budgets. Both remain in force.

## Decision

### 1. One router grammar

| Form | Meaning |
|---|---|
| `$Name` | Dispatch a peer turn to that roster agent in a workspace group |
| `!Name` | Accepted alias of `$Name`, retained for compatibility |
| bare name | A reference only; creates no work |
| `@path` | A workspace file reference; never an agent or a skill |
| `\$` | A literal dollar sign, not a routing operator |

Names match roster names case-insensitively and exactly. A native message is
already sent, so an invalid reference cannot reject it atomically the way a
composer message can. The message posts, no work is created for that reference,
and a visible transcript notice names the problem and the next action. The
composer keeps its atomic validation per ADR 0001.

### 2. Sanitized prose is the only routing input

Routing parses a sanitized prose projection, never raw text. Fenced code blocks,
inline code, URLs, and file paths are excluded. The message keeps its original
text; sanitization decides only where an operator is live.

A name inside a code sample, a URL, or a path is never a route. A name outside
those spans is a route only when the operator is present. There is no "looks
like a mention" fallback.

### 3. Addressees and scope

- **Workspace group.** A native message implicitly addresses the session's
  agent; that agent runs the turn and answers. Other `$Name` recipients get
  normal peer turns in the same dispatch group. The implicit addressee is not a
  self-route and does not consume a recipient slot.
- **Direct conversation.** The direct agent is addressed; no mention routes. A
  `$Name` creates no work and produces a visible notice that direct
  conversations stay one-to-one. A direct message can never mint a workspace
  turn.
- **Group composer.** `$Name` keeps the same meaning as native group prose:
  same recipients, same sanitization, same refusals. One grammar serves both
  surfaces.

Self-mentions, duplicate recipients, and the implicit addressee are suppressed
without a duplicate card. They are not errors and need no notice.

### 4. The server owns budgets

On the native routing path, agents do not author `maxHops`. The server derives
every budget that path can consume:

- A native turn opens a normal root dispatch group for its conversation. A
  workspace group or workspace direct turn captures the workspace command,
  group, and depth ceilings through the ADR 0004 ledger. A home direct turn has
  no workspace ledger and cannot route mentions, so it creates no consumable
  dispatch budget.
- A `$Name` route is a peer turn, not an agent-created delegation. Per ADR 0004
  it consumes no hop and carries no task budget.
- Any delegation or handoff a native turn or peer turn causes consumes a hop
  and receives a server-derived task budget inside the group remaining. The
  server never grants more than the ledger has left, and no agent path can raise
  a command, group, depth, or continuation ceiling. A task budget is not a
  reservation: the serialized group and command caps decide which child actually
  spends.
- The refusal order, ledger atomicity, and controlled-stop semantics stay those
  of ADR 0004. A refusal is a visible transcript notice and, where relevant, a
  controlled Work state. It is never silent.

The explicit `delegate` and `handoff` tools keep their required `maxHops`
argument while they remain available during migration. Native routing must not
create a parallel budget counter or ledger.

This changes who authors the task budget on the normal native path, not what
bounds it. ADR 0004's ledger, four layers, refusal order, continuation rules,
and atomic admission remain in force; the explicit tool path keeps its existing
trust model until it retires.

### 5. Fan-out and loop guards

- Duplicate recipients collapse to one peer turn; self and implicit addressees
  are suppressed.
- A per-message recipient cap reuses the existing per-run fan-out cap. Receipts
  beyond the cap are refused visibly, not queued silently.
- A routed peer turn does not create an immediate reverse turn to its sender by
  mentioning the sender. The child's final text is its answer and returns
  through the existing relay. A deliberate reverse request needs the explicit
  handoff path or a new user command.
- A route that would close a cycle in the same dispatch group is refused
  visibly. The ADR 0004 depth ceiling remains the structural backstop, because
  each peer turn is a child in the group.
- A workspace kill switch turns native mention routing off. The message still
  posts, `$Name` becomes a reference, and a visible notice says routing is off.
  The switch does not disable the explicit tool path. It is user/operator-owned,
  not agent-writable.

The migration feature flag (`off`, `shadow`, `on`) is separate from the kill
switch. `nativeFirst` defaults to `on` for new and existing stores; the first
service start persists that default once, so an explicit `off` or `shadow` is
never overwritten by a later default change. `off` restores the explicit-tool
path; `shadow` ingests and compares without changing the visible path.
Operators change the mode with `:native-first on|off|shadow` and the tool
surface with `:tools native|legacy`; the service logs the effective mode and
migration outcome without content. A host restart is required once after
upgrading so the new plugin code and the `AGENTS.md` contract load.

### 6. Refusals and deduplication

Unknown, archived, non-member, outside-roster, over-budget, over-fan-out, and
cycle refusals create no work for the affected recipient and append a visible
notice. One refused recipient does not abort the others. A refusal names the
agent and the blocking layer or rule.

A tool post and a final-text mention about the same turn deduplicate through the
turn's delivery record and work key. One turn cannot create two cards for the
same recipient.

### 7. The tool surface follows the grammar

The normal native path is prose. The server injects a compact roster,
conversation, and budget context each turn instead of requiring read-only tool
calls. Chat-routing tools leave the default surface: send-message,
workspace-info, list-workspaces, and list-agents.

Tools remain for decisions the server cannot infer safely: ask-person, batch
review, memory, share, and task status. Explicit delegate and handoff stay
behind a flag until native routing has live loop and budget evidence, then
retire under the migration plan. ADR 0001's skill grammar and exact-text rule
are unchanged.

### 8. The workspace contract states the grammar and the roster

The versioned `AGENTS.md` block is the durable statement of this ADR. Contract
v6 says the final native text is the group message; `$Name` routes work while a
bare name is only a reference; `@path` is file-only; code, URLs, and paths never
route; direct conversations are one-to-one; and the server owns routing,
budgets, and completion. It requires an agent not to claim a teammate replied
until that member's turn is visible, and not to open a second completion loop
for a teammate it asked. The old rule that every non-leader turn must end with
a handoff is removed; explicit `delegate` and `handoff` are migration and
rollback tools, not the normal chat path.

The block also carries one generated `Team roster` table. Active members only:
the leader first and marked, then the remaining members in `memberIDs` order,
with columns `Member`, `Title`, and `Role`. Title and role are the stored
strings exactly as authored; only `|` and newlines are escaped for table
syntax. Archived members are excluded. The table lives once in the workspace
`AGENTS.md`; the per-turn `ensemble_turn` block keeps compact names and budget,
so the table is not duplicated into every prompt.

Reconciliation compares the desired block content as well as the version, so a
roster change rewrites the block even at the same version. Workspace membership
and leader changes, and agent name, title, role, archive, and delete changes,
refresh the block immediately; project-owned content outside the Ensemble
markers is preserved, and a newer recorded version is never downgraded.

## Rejected alternatives

- **Use `@Name` for agents.** Rejected: ADR 0001 reserves `@` for workspace
  files. Overloading it makes file references and recipients ambiguous.
- **Route every bare roster name.** Rejected: status prose and quoted names
  would create work, which is exactly the misfire native routing must avoid.
- **Let agents choose `maxHops` on the native path.** Rejected by ADR 0004's
  trust model: a runaway agent could raise its own spend and latency bound.
- **Unbounded mentions or no loop guard.** Rejected: a group can fan out faster
  than a human can read, and two agents can ping-pong.
- **Silently drop invalid or over-cap recipients.** Rejected: work disappears
  without a trace, and the user cannot correct the reference.
- **Route mentions from a direct conversation.** Rejected: it breaks one-to-one
  privacy and lets a direct message create workspace work.
- **Parse raw text with the existing regex.** Rejected: code, URLs, and paths
  are common in native technical prose and would create false work.
- **Keep a second routing-tool budget.** Rejected: it duplicates the ADR 0004
  ledger and breaks the one-service, one-writer invariant.

## Consequences

### Accepted trade-offs

- **Agents write prose, not routing calls.** This reduces tool schemas and
  round-trips, but the agent loses the explicit per-call budget.
- **Peer turns do not consume hops.** Mention fan-out is bounded by the
  per-message cap, the depth ceiling, and the cycle guard, not by the command
  ledger. Agent-created delegation and handoff inside those turns still spend
  hops.
- **A native invalid reference is a notice, not a rejection.** The message is
  already in the transcript, so correction is conversational.
- **Direct conversations cannot route.** Team work must happen in a workspace
  group; this is intentional.
- **The kill switch changes behavior by workspace.** Operators can compare and
  disable routing without removing the explicit tools.
- **The roster table costs prompt bytes.** The workspace block grows with the
  roster (about +125 chars for an empty 12-member table and +1.4k chars for a
  representative filled one); the table is written once per workspace file, not
  per turn.
- **One service and the dispatch ledger are unchanged.** ADR 0003 and ADR 0004
  remain in force.

### Follow-up rules

- Do not add an agent-writable budget argument to the native routing path.
- Do not parse mentions outside sanitized prose.
- Do not make a bare name route work.
- Do not let a direct conversation create a workspace turn.
- Do not drop an over-cap or invalid recipient silently.
- Do not add a second budget counter or ledger for native routes.
- Keep the `!` alias and `@` file-only semantics aligned with ADR 0001.

## Validation

- Ticket #219 covers the sanitizer and router as pure functions; #220 and #221
  cover user and agent mentions at the service seam; #225 covers tool
  retirement. #238 covers contract v6, roster rendering and escaping,
  content-aware reconciliation, and the refresh triggers
  (`src/v2/init-block.test.ts`, `src/v2/workspace-config.test.ts`,
  `src/v2/service.test.ts`).
- The [native host contract](../verification/2026-11-10-native-host-contract.md)
  supplies the turn and delivery identities routing depends on.
- `npm run verify` passes for this documentation ticket. No product behavior
  changed.

## References

- Parent specification #209 and ticket #211 in `heyimteee/ensemble`
- [ADR 0004: Layered dispatch budgets and continuation](0004-dispatch-budgets-and-continuation.md)
- [ADR 0001: Native-skill boundary](0001-native-skill-boundary.md)
- [ADR 0009: Conversation identity and sessions](0009-conversation-identity-and-sessions.md)
- [Glossary](../../GLOSSARY.md)
