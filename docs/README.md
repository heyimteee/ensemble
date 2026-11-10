# Documentation

## Product

- [Project overview](../README.md)
- [Domain glossary](../GLOSSARY.md)
- [Implementation and acceptance notes](implementation.md)
- [v2 product specification #17](https://github.com/heyimteee/ensemble/issues/17): workspace group chat, subtasks, leader routing, and native-session drill-down
- [v2 implementation tickets #18–#29](https://github.com/heyimteee/ensemble/issues): independently verifiable slices with blockers
- [Historical v1 specification #1](https://github.com/heyimteee/ensemble/issues/1)
- [OpenCode 2.2.1 compatibility report](compatibility/opencode-2.2.1.md): verified extension behavior, constraints, and gaps

GitHub Issues are the authoritative location for the specification and tickets; avoid maintaining a competing copy of acceptance criteria here. Publishing the plan does not authorize implementation. Start with compatibility ticket #2 and only begin a ticket when its blockers are complete.

## Working agreements

- [ADR index](adr/README.md): every accepted architecture decision
- [ADR 0001: Native-skill boundary](adr/0001-native-skill-boundary.md): why Ensemble routes native skills instead of executing them
- [ADR 0009: Conversation identity and sessions](adr/0009-conversation-identity-and-sessions.md): one native session per agent per conversation, adoption, and isolation
- [ADR 0010: Native turn ingestion](adr/0010-native-turn-ingestion.md): service-owned, identity-based messages and Work
- [ADR 0011: Mention routing and budgets](adr/0011-mention-routing-and-budgets.md): `$Name` grammar, sanitization, and server-owned budgets
- [Agent instructions](../AGENTS.md)
- [Handoff contract](agents/handoff.md): the detailed mandatory completion-handoff, batch-review, loop-guard, and mention rules
- [OpenCode/OpenTUI runtime guide](agents/opencode-tui-runtime.md): host contracts, source navigation, and verification
- [Issue tracker](agents/issue-tracker.md)
- [Labels](agents/triage-labels.md)
- [Review workflow](agents/review-workflow.md)
- [Reviewer standards](agents/review-standards.md): judgement calls only; mechanical rules stay in automated checks
- [Domain document conventions](agents/domain.md)
- [Contributing](../CONTRIBUTING.md)
- [Security](../SECURITY.md)

## Verification

- [Native-first review fixes](verification/2026-11-11-review-fixes.md): privacy toggle, recovered attachment chips, adoption race guard, kill-switch tool path, shadow delta, parallel ingestion, delegated prompt context, and standards cleanup
- [Native-first cutover verification](verification/2026-11-11-native-first.md): passing live matrix for direct/workspace turns, mention routing, attachments, adoption, retry/interruption, restart/reconnect, Work history, rollback, shadow comparison, latency, and tokens
- [Native shadow mode](verification/2026-11-11-ticket-230.md): invisible shadow ingestion, content-free comparison rows, no visible writes or routes, and the passing 65/65 + 16/16 live matrix
- [Native prompt attachment size](verification/2026-11-11-ticket-228.md): host `data` payload derives a bounded positive chip size; live attachment check passes
- [Native-first child-ticket evidence index](verification/2026-11-11-native-first-children.md): where each #210–#230 verification lives
- [Native host event contract](verification/2026-11-10-native-host-contract.md): measured OpenCode 2.2.6 order, identities, retry, interruption, background subagent, and move behavior
- [Composer attachments](verification/2026-11-10-ticket-223.md): path and clipboard-image paste, bounded store, prompt files, transcript chips, cleanup, and terminal limits
- [Direct native turn ingestion](verification/2026-11-10-ticket-215.md): direct durable messages, exact settlement, Work card, restart recovery, and the nativeFirst rollback
- [Workspace native turn ingestion](verification/2026-11-11-ticket-216.md): workspace group messages, implicit addressee, subagent children, isolation, bounded stream checkpoints, and the #215 review fixes
- [Immediate prompt after adoption](verification/2026-11-11-ticket-229.md): steered multi-turn executions settle each participating turn with its own exact row
- [Tool retirement and contract shrink](verification/2026-11-11-ticket-225.md): native vs legacy tool surfaces, per-turn context injection, measured prompt/schema reduction, and the one-release rollback
- [Real live workspace-wizard timeout](verification/2026-11-11-ticket-232.md): pane-selection harness sequence, viewport-independent real assertions, and a passing `npm run test:live`
- [macOS/Herdr manual checklist](verification/macos-herdr-checklist.md): repeatable, manual, and unexecuted until a run is recorded
- [v6 verification](verification/2026-11-07-v6.md): nine-scene motion parity, Work-card size matrix, load probe, reduced motion, and `NO_COLOR`
- [v5.9 verification](verification/2026-11-06-v59.md): live-matrix guardrails, CI, reviewer standards, unused checks, and tracker hygiene
- [v5.8 verification](verification/2026-11-05-v58.md): System Agent init and deliberate skill invocation
- [v5.7 verification](verification/2026-11-05-v57.md): persistent modes, native key ownership, and interaction polish
- [v5.6 verification](verification/2026-11-05-v56.md): modal interactions, composer editing, mouse copy, and statusline

## Architecture status

The developer preview uses a server plugin for state, scheduling, native sessions, RPC, and tools; a TUI plugin for the workspace; and OpenCode plugin storage for durable JSON state. See [Implementation](implementation.md). Add an ADR when a significant, hard-to-reverse trade-off changes this structure.
