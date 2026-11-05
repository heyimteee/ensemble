# ADR 0001: Native-skill boundary

- **Status:** Accepted
- **Date:** 2026-11-05
- **Ticket:** #110 (v5.9 T5)
- **Supersedes:** none

## Context

Ensemble is a workspace layer over native OpenCode sessions. OpenCode owns the skill catalog, skill files, the native skill tool, and per-agent `skill` permissions. Ensemble's Skillbox decides which catalog skills belong to an agent; it must not weaken the host's authority to enforce that assignment.

v5.8 planning re-litigated this boundary and briefly designed per-skill bodies, per-skill tasks, and prompt attachment machinery before discarding them. The compatibility record also showed that, in OpenCode 2.2.1, prompt `skills` attachments and the experimental session skill endpoint attach skill content without a permission check. Reintroducing either would bypass the Skillbox.

This ADR fixes the boundary so later work extends routing and validation, not skill execution.

## Decision

1. **Native execution is authoritative.** Ensemble stores no skill bodies, implements no skill loader, and synthesizes no skill context. Agents load skills through OpenCode's native skill tool. The host catalog and per-agent `skill` permissions decide availability and loading.
2. **Routing uses exact user text.** The shared planner parses `$Agent`/`!Agent` anchors and `/skill` tokens only to decide recipients and validate assignments. The prompt body is the exact user text; Ensemble adds routing directives, context, and file references outside it. One composer message creates at most one prompt per unique addressed agent, multiple `/skill` tokens for that agent are grouped, and separate messages stay separate queue items. There are no per-skill bodies, per-skill tasks, or per-skill child tasks.
3. **Assigned skills stay with their owner.** A message-start skill owned by the leader runs on the leader; one owned elsewhere opens an owner picker. `$Owner /skill` runs on that owner, and a mention of a non-owner is rejected. An owner must be a workspace member.
4. **General skills go to leader triage.** A catalog skill with no workspace owner routes to the leader, even with no anchor. The leader receives a one-run native `skill` permission allow for exactly the requested General skills plus a directive to read them with the native skill tool, then use or delegate them; the Skillbox permission baseline is restored after the turn. A delegatee receives the leader's self-authored instruction and no host grant. A General skill under a non-leader mention is rejected. Direct conversations reject General skills with a pointer to the workspace group chat, while the DM agent's own assigned skills pass through.
5. **No attachment or experimental bypass.** Ensemble does not use prompt `skills` attachments, the experimental skill-activation endpoint, or any other host path that attaches skill content without the native permission check. It does not create a parallel catalog or permission grant. An unknown skill, wrong owner, invalid agent or workspace, or cap overflow rejects the whole message atomically before any transcript line, task, or prompt exists.
6. **Prefixes are deliberate.** `/` at message start, or after `$Agent`, is the skill and command prefix. `$` and `!` address agents. `@` is workspace file-reference only: never a skill attachment and never an agent address. Arbitrary native slash commands are not proxied into the group chat.
7. **Init is the one deliberate internal native call.** The built-in `/init` is displayed as General but executes a System Agent init job, not a host skill. The job creates a temporary native session in the workspace, calls the native `init` command through `session.command` with the full `initInstructions()` text, streams progress through the System Agent row, writes the versioned block and `.ensemble/init.json` only on success, restores the prior `AGENTS.md` on failure, cancellation, or restart, and removes the temporary session. The composer never forwards `/init` to native OpenCode; native `/init` outside Ensemble is unchanged. Init is workspace-only, solo-only, and not assignable in a Skillbox.

## Consequences

### Accepted trade-offs

- **No per-skill prompt shaping.** Exact text preserves user intent, but Ensemble cannot tailor a prompt per skill or guarantee a skill body or version; the recipient must read the skill from the host catalog. Multiple skills share one prompt, so their order and precedence are emergent rather than scripted.
- **Triage latency and leader load.** General skills need an extra hop through the leader, making the leader a bottleneck. The one-run permission grant temporarily broadens the session permission set and must be restored on every exit path, including failures.
- **Owner-only routing.** It is predictable and permission-aligned, but the owner must be a workspace member, outside owners require a picker, and another workspace's skill cannot be invoked.
- **No bypass means no ad-hoc attachment.** Unassigned content cannot be attached for convenience; it must exist in the native catalog and route through triage. This is intentional.
- **Strict prefixes.** `/` keeping native slash commands out of the group chat is a known limitation. `@` as file-only avoids mention/skill ambiguity but may surprise users who expect `@agent`.
- **Init is host-coupled.** It depends on native init semantics and `session.command`, and its temporary-session lifecycle must handle cancellation, restart, archive, and delete without losing the previous `AGENTS.md`. Failure-path tests compensate.
- **One prompt per agent** keeps grouped skills together but limits per-skill isolation and within-message parallelism. Sequencing requires separate messages.

### Follow-up rules

- Do not add per-skill tasks, skill-body storage, prompt attachments, or experimental activation to work around a routing limitation; surface the gap instead.
- New skill routing must use the shared planner, and the server must remain authoritative for validation.
- Keep `/init` internal to the System Agent; do not shadow native `/init` globally.

## References

- [Implementation notes](../implementation.md#skill-invocation-and-leader-triage)
- [OpenCode 2.2.1 compatibility record](../compatibility/opencode-2.2.1.md)
- [v5.8 verification record](../verification/2026-11-05-v58.md)
- [Shared skill planner](../../src/v2/skill-invocation.ts), [service routing](../../src/v2/service.ts), [System Agent](../../src/v2/system-agent.ts), [init instructions](../../src/v2/init-block.ts)
- Specification #105 and ticket #110 in `heyimteee/ensemble`
