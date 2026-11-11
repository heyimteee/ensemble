# Architecture decisions

Accepted records for decisions that are significant, hard to reverse, and have
a genuine trade-off. An ADR states the decision and its consequences; it is not
an implementation tutorial. Superseded decisions stay listed with their
replacement.

| ADR | Decision | Status | Tickets |
|---|---|---|---|
| [0001](0001-native-skill-boundary.md) | Native-skill boundary: native execution is authoritative | Accepted | #110 |
| [0002](0002-durable-patch-feed.md) | Server-authoritative durable patch feed | Accepted | #130, #138–#143 |
| [0003](0003-single-service-and-safe-recovery.md) | One Ensemble service per host realm, with lease-safe recovery | Accepted | spec #146, #147–#151 |
| [0004](0004-dispatch-budgets-and-continuation.md) | Layered dispatch budgets, continuation groups, and one durable ledger | Accepted | #159–#164 |
| [0005](0005-work-status-and-delivery-lease-separation.md) | Work status taxonomy and delivery/lease separation | Accepted | #165, #168, #170 |
| [0006](0006-three-pane-workspace-shell.md) | Three-pane workspace shell | Accepted | #166, #171–#174 |
| [0007](0007-apply-agent-behavior-in-place.md) | Apply agent behavior changes to the existing native session | Accepted | #189 |
| [0008](0008-task-level-history-and-rollup.md) | Task-level history and sticky rollup | Accepted | #178, #184, #187 |
| [0009](0009-conversation-identity-and-sessions.md) | Conversation identity and per-conversation native sessions | Accepted | #209, #211 |
| [0010](0010-native-turn-ingestion.md) | Native turn ingestion is service-owned and identity-based | Accepted | #209, #211 |
| [0011](0011-mention-routing-and-budgets.md) | `$Name` routing grammar and server-owned budgets | Accepted | #209, #211 |
| [0012](0012-terminal-turns-and-root-synthesis.md) | Terminal turns, root-only synthesis, and explicit continuation | Accepted | spec #245, #246–#251 |

## Related evidence

- [Native host event contract](../verification/2026-11-10-native-host-contract.md):
  measured OpenCode 2.2.6 order, identities, retry, interruption, background
  subagent, and move behavior for ADR 0009 and ADR 0010.
- [Domain glossary](../../GLOSSARY.md): agreed product terms used by these
  records.
