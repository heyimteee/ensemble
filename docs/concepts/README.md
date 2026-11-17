# Concepts

Short explanations of the mental models behind Ensemble. Read this section when
you need to know who receives a message, why work is waiting, or what a budget
refusal means. The user-visible behavior comes first; architecture decisions are
linked at the end as optional depth.

The [domain glossary](../../GLOSSARY.md) is authoritative for definitions. The
[documentation style guide](../style-guide.md#canonical-terms) fixes the
user-facing term for each concept.

## Core concepts

| Concept | User-facing summary | Read now |
|---|---|---|
| Agent and roster | A named teammate with lasting instructions, model settings, memory, and skills. The roster is your reusable collection. | [Glossary: Agent](../../GLOSSARY.md), [root README](../../README.md#what-it-does) |
| Workspace | A directory-bound project room with a group chat, members, and exactly one leader. | [Glossary: Workspace](../../GLOSSARY.md), [support matrix](../support/support-matrix.md) |
| Leader | The member who receives unaddressed messages and can answer or delegate. Leadership adds no permissions. | [Glossary: Leader](../../GLOSSARY.md), [root README](../../README.md#what-it-does) |
| Group chat and direct chat | The workspace transcript versus a private conversation with one agent. Routing and Work history are scoped to one conversation. | [Glossary: Group chat](../../GLOSSARY.md), [Glossary: Direct conversation](../../GLOSSARY.md) |
| `$Name` and `@path` | `$Name` sends work to a teammate in a group chat; `@path` is only a workspace file reference. | [ADR 0011](../adr/0011-mention-routing-and-budgets.md) |
| Turn and terminal turn | One prompt-and-execution cycle. Only a command root synthesizes; intermediate hops relay their child's result. | [Glossary: Native turn](../../GLOSSARY.md), [ADR 0012](../adr/0012-terminal-turns-and-root-synthesis.md) |
| Work item and Work status | The visible unit in the Work pane and its derived lifecycle: pending, working, waiting, retrying, needs you, replied, failed, stalled, or cancelled. | [Glossary: Work status](../../GLOSSARY.md), [ADR 0005](../adr/0005-work-status-and-delivery-lease-separation.md) |
| Dispatch budget | The layered ceiling on delegation: command budget, group budget, per-call task budget, and depth. Exhaustion is a controlled stop. | [Glossary: Command budget](../../GLOSSARY.md), [ADR 0004](../adr/0004-dispatch-budgets-and-continuation.md) |
| Native session | The OpenCode session where an agent executes and its tool activity can be inspected. Each agent has one per conversation. | [Glossary: Native session](../../GLOSSARY.md), [ADR 0009](../adr/0009-conversation-identity-and-sessions.md) |
| Skill and Skillbox | Reusable guidance loaded through OpenCode; the Skillbox decides which optional skills an agent may use. A skill is not a tool permission. | [Glossary: Skill](../../GLOSSARY.md), [ADR 0001](../adr/0001-native-skill-boundary.md) |
| Memory and approval | Agent or workspace knowledge with provenance, and an explicit user decision before dependent work continues. An approval cannot override OpenCode tool permissions. | [Glossary: Approval](../../GLOSSARY.md), [privacy](../privacy/data-and-retention.md) |
| Architecture | The server plugin owns state, scheduling, native sessions, RPC, and tools; the TUI plugin renders the workspace. | [Implementation notes](../implementation.md) |

## Reading order

Use the table as the intended order. The glossary is authoritative for each
definition, and the linked ADR carries the full decision when you need the
engineering rationale. Dedicated concept pages will add a worked example and a
diagram for each row without replacing those sources.

## Go deeper

- [ADR index](../adr/README.md): every accepted architecture decision.
- [Implementation notes](../implementation.md): service, TUI, storage, and
  native-tool boundaries.
- [Evidence index](../contributing/evidence.md): verification records for the
  behavior described here.

## Next

- [Guides](../guides/README.md): apply these concepts to a task.
- [Reference](../reference/README.md): look up exact commands and settings.
