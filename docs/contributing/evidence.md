# Evidence index

Public engineering evidence: architecture decisions, verification records,
implementation notes, assessments, and compatibility reports. This index is for
contributors, maintainers, and reviewers. It is not user guidance; start at the
[docs home](../README.md) or the [contributing hub](README.md) for the user and
contributor paths.

Every verification record dated 2026-11-11 or later must be linked here.
`npm run docs:check` enforces that rule so a current record cannot disappear
from the public evidence set.

## Architecture decisions

The [ADR index](../adr/README.md) lists every accepted decision, its status, and
its tickets.

| ADR | Decision |
|---|---|
| [0001](../adr/0001-native-skill-boundary.md) | Native-skill boundary: native execution is authoritative |
| [0002](../adr/0002-durable-patch-feed.md) | Server-authoritative durable patch feed |
| [0003](../adr/0003-single-service-and-safe-recovery.md) | One Ensemble service per host realm, with lease-safe recovery |
| [0004](../adr/0004-dispatch-budgets-and-continuation.md) | Layered dispatch budgets, continuation groups, and one durable ledger |
| [0005](../adr/0005-work-status-and-delivery-lease-separation.md) | Work status taxonomy and delivery/lease separation |
| [0006](../adr/0006-three-pane-workspace-shell.md) | Three-pane workspace shell |
| [0007](../adr/0007-apply-agent-behavior-in-place.md) | Apply agent behavior changes to the existing native session |
| [0008](../adr/0008-task-level-history-and-rollup.md) | Task-level history and sticky rollup |
| [0009](../adr/0009-conversation-identity-and-sessions.md) | Conversation identity and per-conversation native sessions |
| [0010](../adr/0010-native-turn-ingestion.md) | Native turn ingestion is service-owned and identity-based |
| [0011](../adr/0011-mention-routing-and-budgets.md) | `$Name` routing grammar and server-owned budgets |
| [0012](../adr/0012-terminal-turns-and-root-synthesis.md) | Terminal turns, root-only synthesis, and explicit continuation |

## Verification records

- [Documentation visuals and accessibility](../verification/2026-11-17-ticket-309.md): the synthetic terminal replay and screenshots, rendered Mermaid diagrams with accessible titles/descriptions, manifest and alt/caption checks, keyboard/heading/contrast/reduced-motion measurements, and the remaining unrun browser and install limits
- [Public release readiness — parent #268](../verification/2026-11-17-ticket-268.md): the released `0.1.0-rc.2` state, every child ticket result including #277 macOS verification and #281–#287, the final-tip install/fake/soak evidence, green required CI at `a7f1eb3`, the full macOS checklist including 1.7, the public-registry smoke on 2.2.7/2.3.0, npm `latest`/`next` behavior, and the remaining announcement decision
- [Live TUI readiness after opening Ensemble](../verification/2026-11-17-ticket-287.md): statusline-gated `live_open_ensemble`, a header-only guard test, the deterministic command-line retype ordering, and passing 2.3.0/2.2.7 fake suites
- [Four-hour enforced soak — 0.1.0-rc.2 final tip](../verification/2026-11-17-soak.md): PASS on both supported hosts, OpenCode 2.2.7 and 2.3.0, with 240 samples over 14,439 s each, 0 failures, settled queue/native state, and growth within both gates
- [Release workflow, branch protection, and publish provenance](../verification/2026-11-16-ticket-275.md): the applied `main` ruleset with the real check contexts, the tag/dry-run workflow, the token boundary and provenance, the CycloneDX SBOM, the changelog-based release, the sign-off checklist, and the local dry-run evidence
- [OpenCode 2.3.0 compatibility](../verification/2026-11-17-ticket-286.md): the host-range expansion, the 2.3.0 and 2.2.7 fake E2E runs, the passing host probe, the high-contrast focus-tone harness fix, the size matrix, and the loopback install proof
- [Operations runbook, support intake, and templates](../verification/2026-11-16-ticket-274.md): the support channel and response targets, diagnostics and rollback runbook, support matrix, issue/PR forms with redaction rules, and the docs-check support assertions
- [MIT license and npm package identity](../verification/2026-11-16-ticket-269.md): the MIT license and scoped package metadata, the runtime-only contents allowlist (119 modules), the pack-content guard, and the passing verify/docs/pack dry run
- [Clean-install release candidate](../verification/2026-11-16-ticket-270.md): the loopback-registry `opencode plugin add` proof, the installed server tools and package source, and the exact TUI source-package load failure deferred to #279
- [Built package for the installed TUI plugin](../verification/2026-11-16-ticket-279.md): the Solid-compiled `dist` build, runtime dependency resolution in the plugin cache, the passing `0.1.0-rc.2` TUI route and `/ensemble` command, and the runtime-only pack guard
- [macOS/Herdr verification via SSH](../verification/2026-11-16-ticket-277.md): the macOS `0.1.0-rc.2` install and six server tools, the installed TUI route in Herdr/Ghostty, the full checklist including 1.7 pane-bounded Shift+drag with explicit copy, the macOS fake E2E, and the Git-spec/Herdr-prefix findings
- [Security and privacy audit](../verification/2026-11-16-ticket-271.md): threat model and permission review, the handoff symlink containment fix, `npm audit` baseline and accepted risks, Dependabot configuration, and the passing verify/docs gates
- [Backup/restore and upgrade/rollback](../verification/2026-11-16-ticket-273.md): the versioned backup document, the service RPC and operator CLI, the automatic rollback slot, the injected-failure recovery rehearsal, restored-state doctor compatibility, and the upgrade/rollback guides
- [Scale/soak and local diagnostics](../verification/2026-11-16-ticket-276.md): the fake soak harness, the tested operating envelope, the redacted support bundle, the no-telemetry policy, and the settled native-session cap fix; the final-tip 4-hour result is in the [soak record](../verification/2026-11-17-soak.md)
- [Production-readiness partials full E2E](../verification/2026-11-16-prod-partials-e2e.md): the 17-suite matrix on OpenCode 2.2.7, the 2.2.6/2.2.7 compatibility runs, the Node 22/24/26 unit matrix, the latency smoke and reference profiles, and zero retries across the fake suites
- [CI stabilization after the first PR run](../verification/2026-11-16-ticket-267.md): the linked E2E record, the settle-aware skill-validation probe, the Ensemble-scoped reduced-motion still frame, and the passing verify/docs/fake matrix
- [Production-readiness partials review fixes](../verification/2026-11-16-ticket-255-review-fixes.md): the runtime-seam removal, pure matrix decision, header-scoped live assertion, compatibility artifacts, real card geometry, and the passing verify/latency/fake matrix
- [Full deterministic E2E in CI](../verification/2026-11-16-ticket-261.md): cost-split PR jobs, nightly latency and opt-in real-model jobs, failure artifacts, the OpenCode 2.2.7 pin, the job-graph checker, and the passing deterministic matrix
- [Documentation freshness](../verification/2026-11-12-ticket-262.md): canonical contract/host/Node constants, the docs index, ADR 0011 at contract v7, and the `docs:check` CI gate
- [Data retention, export, delete, and roster disclosure](../verification/2026-11-16-ticket-272.md): the `data.export`/`data.delete` RPC actions and CLI, the documented retention and export format, post-delete workspace health, log deletion, and the v7 `AGENTS.md` title/role disclosure guidance
- [Live harness flake policy](../verification/flake-policy.md): timing-only retry, flake budget, failure artifacts, and the issue/owner quarantine rule
- [Live harness flake policy verification](../verification/2026-11-12-ticket-256.md): readiness-based wizard alignment, classified timing retry, artifact preservation, and the passing deterministic matrix
- [Latency budget and SLO](../verification/latency-budget.md): split rail/patch-card/first-token metrics, reference and smoke profiles, the deterministic patch-card fixture, and the deliberate regression gate
- [Latency budget verification](../verification/2026-11-16-ticket-260.md): baseline samples, reference-host gate, regression evidence, and the verify/latency results
- [Node support policy and CI matrix](../verification/2026-11-12-node-matrix.md): `npm run verify` on Node 22.23.4, 24.22.1, and 26.12.1, the `>=22.23.4` engine floor, the load-time version gate, and the separate Node matrix workflow
- [Accessibility audit](../verification/2026-11-12-ticket-259.md): contrast matrix for dark/light/custom themes, non-color Work status, keyboard-only reachability, reduced-motion/`NO_COLOR`/ASCII fallbacks, and the ASCII glyph fix
- [Terminal accessibility checklist](../verification/terminal-accessibility-checklist.md): manual screen-reader, high-contrast, font-scaling, reduced-motion, ASCII, keyboard-only, and host-limit checks
- [OpenCode peer compatibility matrix](../verification/2026-11-12-ticket-257.md): supported 2.2.6/2.2.7 hosts, peer range, runtime warning, and local verify/probe evidence
- [Vera regression and cutover verification](../verification/2026-11-11-ticket-241.md): unset-store default-on restart, one leader turn with explicit delegation plus multi-mention routing without duplicates, no completion bounce, exact generated roster table, one-card-per-row size matrix, rollback/restore durability, and the measured AGENTS block delta
- [Native-first default on and rollback](../verification/2026-11-11-ticket-240.md): persisted default, explicit off/shadow, tool-surface rollback, global commands, restart requirement, and the passing live matrix
- [Contract v6 and team roster](../verification/2026-11-11-ticket-238.md): native-first rules, generated roster table, content-aware reconciliation, refresh triggers, and the measured prompt delta
- [Contract v7 terminal-turn workflow](../verification/2026-11-12-ticket-253.md): root-only synthesis, terminal-turn references, `ensemble_dispatch` continuation, regenerated repository block, and the passing Vera regression
- [Native-first full E2E](../verification/2026-11-12-e2e.md): all 12 unit/live suites passing on OpenCode 2.2.7, including the real TUI acceptance
- [Native ingestion state and AGENTS v7 full E2E](../verification/2026-11-12-native-ingestion-v7-e2e.md): the 13-suite matrix on OpenCode 2.2.7 covering native ingestion, the v7 terminal-turn contract, Vera, accessibility sizes, and the real TUI
- [One native ingestion state value](../verification/2026-11-12-ticket-231.md): one `NativeSessionState` per session, event order, steering, retry, interruption, adoption, and restart
- [Terminal turns and root-only synthesis E2E](../verification/2026-11-11-terminal-turns-e2e.md): root synthesis, intermediate relay, terminal-turn references, dispatch continuation, and the passing full live matrix
- [Native probe version set and stale live harness](../verification/2026-11-11-ticket-233-234.md): 2.2.6/2.2.7 contract set, Native mirror settings row, and Work interaction before HISTORY
- [Native-first review fixes](../verification/2026-11-11-review-fixes.md): privacy toggle, recovered attachment chips, adoption race guard, kill-switch tool path, shadow delta, parallel ingestion, delegated prompt context, and standards cleanup
- [Native-first cutover verification](../verification/2026-11-11-native-first.md): passing live matrix for direct/workspace turns, mention routing, attachments, adoption, retry/interruption, restart/reconnect, Work history, rollback, shadow comparison, latency, and tokens
- [Native shadow mode](../verification/2026-11-11-ticket-230.md): invisible shadow ingestion, content-free comparison rows, no visible writes or routes, and the passing 65/65 + 16/16 live matrix
- [Native prompt attachment size](../verification/2026-11-11-ticket-228.md): host `data` payload derives a bounded positive chip size; live attachment check passes
- [Native-first child-ticket evidence index](../verification/2026-11-11-native-first-children.md): where each #210–#230 verification lives
- [Retry and interruption for native turns](../verification/2026-11-11-ticket-217.md): one durable turn and Work card across retry, interruption, and settlement
- [Native reconciliation and support surface](../verification/2026-11-11-ticket-218.md): reconciliation triggers, context reads, and support-surface limits
- [Legacy direct-message transcript contract](../verification/2026-11-11-ticket-226.md): one conversation-channel store for direct messages and the retired per-binding branch
- [Compact synthesis context](../verification/2026-11-11-ticket-249.md): root synthesis without the bounded group transcript
- [Multi-ticket and token verification](../verification/2026-11-11-ticket-251.md): multi-ticket roots, command-cap refusal, prompt/schema token counts, and the Vera regression
- [Native host event contract](../verification/2026-11-10-native-host-contract.md): measured OpenCode 2.2.6 order, identities, retry, interruption, background subagent, and move behavior
- [Composer attachments](../verification/2026-11-10-ticket-223.md): path and clipboard-image paste, bounded store, prompt files, transcript chips, cleanup, and terminal limits
- [Direct native turn ingestion](../verification/2026-11-10-ticket-215.md): direct durable messages, exact settlement, Work card, restart recovery, and the nativeFirst rollback
- [Workspace native turn ingestion](../verification/2026-11-11-ticket-216.md): workspace group messages, implicit addressee, subagent children, isolation, bounded stream checkpoints, and the #215 review fixes
- [Immediate prompt after adoption](../verification/2026-11-11-ticket-229.md): steered multi-turn executions settle each participating turn with its own exact row
- [Tool retirement and contract shrink](../verification/2026-11-11-ticket-225.md): native vs legacy tool surfaces, per-turn context injection, measured prompt/schema reduction, and the one-release rollback
- [Real live workspace-wizard timeout](../verification/2026-11-11-ticket-232.md): pane-selection harness sequence, viewport-independent real assertions, and a passing `npm run test:live`
- [macOS/Herdr manual checklist](../verification/macos-herdr-checklist.md): repeatable, manual, and unexecuted until a run is recorded
- [v6 verification](../verification/2026-11-07-v6.md): nine-scene motion parity, Work-card size matrix, load probe, reduced motion, and `NO_COLOR`
- [v5.9 verification](../verification/2026-11-06-v59.md): live-matrix guardrails, CI, reviewer standards, unused checks, and tracker hygiene
- [v5.8 verification](../verification/2026-11-05-v58.md): System Agent init and deliberate skill invocation
- [v5.7 verification](../verification/2026-11-05-v57.md): persistent modes, native key ownership, and interaction polish
- [v5.6 verification](../verification/2026-11-05-v56.md): modal interactions, composer editing, mouse copy, and statusline

### Earlier verification records

These older records predate the current evidence index. They are retained
unchanged and linked here so the published site keeps every record reachable
from the contributing hub.

- [Ensemble v2 verification — 2026-10-30](../verification/2026-10-30.md)
- [Ensemble v5 acceptance — 2026-11-01](../verification/2026-11-01.md)
- [Ensemble v5.1 wizard verification — 2026-11-02](../verification/2026-11-02.md)
- [Ticket #67 verification — chat surfaces](../verification/2026-11-03-ticket-67.md)
- [Ticket #68 verification — approvals reflect reality](../verification/2026-11-03-ticket-68.md)
- [Ticket #69 verification — settings stylization](../verification/2026-11-03-ticket-69.md)
- [Ticket #70 verification — truthful activity states](../verification/2026-11-03-ticket-70.md)
- [Ticket #71 verification — completion handoff and review](../verification/2026-11-03-ticket-71.md)
- [Ticket #72 verification — bubble rendering](../verification/2026-11-03-ticket-72.md)
- [Ticket #73 verification — handoff instructions and review framing](../verification/2026-11-03-ticket-73.md)
- [Ticket #74 verification — streaming settlement](../verification/2026-11-03-ticket-74.md)
- [Ticket #75 verification — conversation blockers](../verification/2026-11-03-ticket-75.md)
- [Ticket #76 verification — state truth](../verification/2026-11-03-ticket-76.md)
- [Ticket #77 verification — conversation surfaces](../verification/2026-11-04-ticket-77.md)
- [v5.9 T2 verification — CI fake-live guardrail](../verification/2026-11-05-v59-t2.md)
- [v5.9 T7 verification — tracker and agent-doc hygiene](../verification/2026-11-05-v59-t7.md)
- [Single service per host and safe recovery (#151)](../verification/2026-11-08-single-service.md)
- [Host-realm tools, events, activity, and alignment (#157)](../verification/2026-11-09-host-realm.md)
- [Pane interaction verification (#186)](../verification/2026-11-09-pane-interaction.md)

## Implementation and assessments

- [Implementation and acceptance notes](../implementation.md): service, TUI,
  storage, native tools, and the architecture status.
- [OpenTUI assessment](../assessments/opentui.md): historical host-evaluation
  evidence.

## Compatibility evidence

- [OpenCode host support range](../compatibility/opencode-host-range.md):
  supported CLI releases, peer range, runtime warning, and CLI-to-API mapping.
- [OpenCode 2.2.1 compatibility report](../compatibility/opencode-2.2.1.md):
  historical extension behavior, constraints, and gaps.

## Contributor context

- [Contributing hub](README.md): code and docs workflow.
- [Documentation style guide](../style-guide.md): page and terminology rules.
- [Redirect map](../redirects.md): where old docs-index entries moved.
- [Handoff contract](../agents/handoff.md): server-owned completion and review
  rules.
- [Issue tracker](../agents/issue-tracker.md), [triage labels](../agents/triage-labels.md),
  and [domain document conventions](../agents/domain.md).
