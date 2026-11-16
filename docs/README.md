# Documentation

## Product

- [Project overview](../README.md)
- [Domain glossary](../GLOSSARY.md)
- [Implementation and acceptance notes](implementation.md)
- [Scale, soak, and local diagnostics](operations/scale-and-monitoring.md): operating envelope, soak/leak harness, support bundle, and no-telemetry policy
- [v2 product specification #17](https://github.com/heyimteee/ensemble/issues/17): workspace group chat, subtasks, leader routing, and native-session drill-down
- [v2 implementation tickets #18–#29](https://github.com/heyimteee/ensemble/issues): independently verifiable slices with blockers
- [Historical v1 specification #1](https://github.com/heyimteee/ensemble/issues/1)
- [OpenCode host support range](compatibility/opencode-host-range.md): supported CLI releases, peer range, runtime warning, and CLI-to-API mapping
- [OpenCode 2.2.1 compatibility report](compatibility/opencode-2.2.1.md): historical extension behavior, constraints, and gaps

GitHub Issues are the authoritative location for the specification and tickets; avoid maintaining a competing copy of acceptance criteria here. Publishing the plan does not authorize implementation. Start with compatibility ticket #2 and only begin a ticket when its blockers are complete.

## Working agreements

- [ADR index](adr/README.md): every accepted architecture decision
- [ADR 0001: Native-skill boundary](adr/0001-native-skill-boundary.md): why Ensemble routes native skills instead of executing them
- [ADR 0009: Conversation identity and sessions](adr/0009-conversation-identity-and-sessions.md): one native session per agent per conversation, adoption, and isolation
- [ADR 0010: Native turn ingestion](adr/0010-native-turn-ingestion.md): service-owned, identity-based messages and Work
- [ADR 0011: Mention routing and budgets](adr/0011-mention-routing-and-budgets.md): `$Name` grammar, sanitization, server-owned budgets, and the v7 roster contract
- [Agent instructions](../AGENTS.md)
- [Handoff contract](agents/handoff.md): server-owned completion, migration handoff, batch-review, loop-guard, and mention rules
- [OpenCode/OpenTUI runtime guide](agents/opencode-tui-runtime.md): host contracts, source navigation, and verification
- [Issue tracker](agents/issue-tracker.md)
- [Labels](agents/triage-labels.md)
- [Review workflow](agents/review-workflow.md)
- [Reviewer standards](agents/review-standards.md): judgement calls only; mechanical rules stay in automated checks
- [Domain document conventions](agents/domain.md)
- [Contributing](../CONTRIBUTING.md)
- [Security policy](../SECURITY.md)
- [Threat model](security/threat-model.md): storage, filesystem/shell, tools, cross-workspace access, skills, approvals, model fallback, and logs, with code evidence
- [Permission-model review](security/permission-model-review.md): approvals, outside-roster contact, external directories, self-approval, and native permission preservation
- [Accepted risks](security/accepted-risks.md): dependency advisories and residual risks with review dates
- [Data classes, retention, export, and delete](privacy/data-and-retention.md): what Ensemble stores, the 24-hour Work and 7-day log retention, the `ensemble.data-export` format, the scoped delete path, and the v7 `AGENTS.md` roster disclosure guidance and manual opt-out

## Support

- [Support policy](support/README.md): channel, response expectations, evidence, and redaction rules
- [Incident runbook](support/incident-runbook.md): symptoms, diagnostics, package rollback, escalation, and data recovery
- [Support matrix and known limitations](support/support-matrix.md): Linux/tmux, macOS/Herdr, Windows, OpenCode/Node ranges, and live-suite prerequisites

## Operations

- [Backup and restore](operations/backup-restore.md): the durable-state document, RPC actions, the operator CLI, the automatic rollback slot, and failure recovery
- [Upgrade from the pre-release](operations/upgrade.md): native-first defaults, AGENTS v7, the native-state refactor, and additive durable-state migrations
- [Package rollback](operations/rollback.md): package-only and state rollback, plus the rehearsed failure path

## Verification

- [Operations runbook, support intake, and templates](verification/2026-11-16-ticket-274.md): the support channel and response targets, diagnostics and rollback runbook, support matrix, issue/PR forms with redaction rules, and the docs-check support assertions
- [MIT license and npm package identity](verification/2026-11-16-ticket-269.md): the MIT license and scoped package metadata, the runtime-only contents allowlist (119 modules), the pack-content guard, and the passing verify/docs/pack dry run
- [Clean-install release candidate](verification/2026-11-16-ticket-270.md): the loopback-registry `opencode plugin add` proof, the installed server tools and package source, and the exact TUI source-package load failure deferred to #279
- [Security and privacy audit](verification/2026-11-16-ticket-271.md): threat model and permission review, the handoff symlink containment fix, `npm audit` baseline and accepted risks, Dependabot configuration, and the passing verify/docs gates
- [Backup/restore and upgrade/rollback](verification/2026-11-16-ticket-273.md): the versioned backup document, the service RPC and operator CLI, the automatic rollback slot, the injected-failure recovery rehearsal, restored-state doctor compatibility, and the upgrade/rollback guides
- [Scale/soak and local diagnostics](verification/2026-11-16-ticket-276.md): the fake soak harness and smoke record, the tested operating envelope, the redacted support bundle, the no-telemetry policy, and the settled native-session cap fix
- [Production-readiness partials full E2E](verification/2026-11-16-prod-partials-e2e.md): the 17-suite matrix on OpenCode 2.2.7, the 2.2.6/2.2.7 compatibility runs, the Node 22/24/26 unit matrix, the latency smoke and reference profiles, and zero retries across the fake suites
- [CI stabilization after the first PR run](verification/2026-11-16-ticket-267.md): the linked E2E record, the settle-aware skill-validation probe, the Ensemble-scoped reduced-motion still frame, and the passing verify/docs/fake matrix
- [Production-readiness partials review fixes](verification/2026-11-16-ticket-255-review-fixes.md): the runtime-seam removal, pure matrix decision, header-scoped live assertion, compatibility artifacts, real card geometry, and the passing verify/latency/fake matrix
- [Full deterministic E2E in CI](verification/2026-11-16-ticket-261.md): cost-split PR jobs, nightly latency and opt-in real-model jobs, failure artifacts, the OpenCode 2.2.7 pin, the job-graph checker, and the passing deterministic matrix
- [Documentation freshness](verification/2026-11-12-ticket-262.md): canonical contract/host/Node constants, the docs index, ADR 0011 at contract v7, and the `docs:check` CI gate
- [Data retention, export, delete, and roster disclosure](verification/2026-11-16-ticket-272.md): the `data.export`/`data.delete` RPC actions and CLI, the documented retention and export format, post-delete workspace health, log deletion, and the v7 `AGENTS.md` title/role disclosure guidance
- [Live harness flake policy](verification/flake-policy.md): timing-only retry, flake budget, failure artifacts, and the issue/owner quarantine rule
- [Live harness flake policy verification](verification/2026-11-12-ticket-256.md): readiness-based wizard alignment, classified timing retry, artifact preservation, and the passing deterministic matrix
- [Latency budget and SLO](verification/latency-budget.md): split rail/patch-card/first-token metrics, reference and smoke profiles, the deterministic patch-card fixture, and the deliberate regression gate
- [Latency budget verification](verification/2026-11-16-ticket-260.md): baseline samples, reference-host gate, regression evidence, and the verify/latency results
- [Node support policy and CI matrix](verification/2026-11-12-node-matrix.md): `npm run verify` on Node 22.23.4, 24.22.1, and 26.12.1, the `>=22.23.4` engine floor, the load-time version gate, and the separate Node matrix workflow
- [Accessibility audit](verification/2026-11-12-ticket-259.md): contrast matrix for dark/light/custom themes, non-color Work status, keyboard-only reachability, reduced-motion/`NO_COLOR`/ASCII fallbacks, and the ASCII glyph fix
- [Terminal accessibility checklist](verification/terminal-accessibility-checklist.md): manual screen-reader, high-contrast, font-scaling, reduced-motion, ASCII, keyboard-only, and host-limit checks
- [OpenCode peer compatibility matrix](verification/2026-11-12-ticket-257.md): supported 2.2.6/2.2.7 hosts, peer range, runtime warning, and local verify/probe evidence
- [Vera regression and cutover verification](verification/2026-11-11-ticket-241.md): unset-store default-on restart, one leader turn with explicit delegation plus multi-mention routing without duplicates, no completion bounce, exact generated roster table, one-card-per-row size matrix, rollback/restore durability, and the measured AGENTS block delta
- [Native-first default on and rollback](verification/2026-11-11-ticket-240.md): persisted default, explicit off/shadow, tool-surface rollback, global commands, restart requirement, and the passing live matrix
- [Contract v6 and team roster](verification/2026-11-11-ticket-238.md): native-first rules, generated roster table, content-aware reconciliation, refresh triggers, and the measured prompt delta
- [Contract v7 terminal-turn workflow](verification/2026-11-12-ticket-253.md): root-only synthesis, terminal-turn references, `ensemble_dispatch` continuation, regenerated repository block, and the passing Vera regression
- [Native-first full E2E](verification/2026-11-12-e2e.md): all 12 unit/live suites passing on OpenCode 2.2.7, including the real TUI acceptance
- [Native ingestion state and AGENTS v7 full E2E](verification/2026-11-12-native-ingestion-v7-e2e.md): the 13-suite matrix on OpenCode 2.2.7 covering native ingestion, the v7 terminal-turn contract, Vera, accessibility sizes, and the real TUI
- [One native ingestion state value](verification/2026-11-12-ticket-231.md): one `NativeSessionState` per session, event order, steering, retry, interruption, adoption, and restart
- [Terminal turns and root-only synthesis E2E](verification/2026-11-11-terminal-turns-e2e.md): root synthesis, intermediate relay, terminal-turn references, dispatch continuation, and the passing full live matrix
- [Native probe version set and stale live harness](verification/2026-11-11-ticket-233-234.md): 2.2.6/2.2.7 contract set, Native mirror settings row, and Work interaction before HISTORY
- [Native-first review fixes](verification/2026-11-11-review-fixes.md): privacy toggle, recovered attachment chips, adoption race guard, kill-switch tool path, shadow delta, parallel ingestion, delegated prompt context, and standards cleanup
- [Native-first cutover verification](verification/2026-11-11-native-first.md): passing live matrix for direct/workspace turns, mention routing, attachments, adoption, retry/interruption, restart/reconnect, Work history, rollback, shadow comparison, latency, and tokens
- [Native shadow mode](verification/2026-11-11-ticket-230.md): invisible shadow ingestion, content-free comparison rows, no visible writes or routes, and the passing 65/65 + 16/16 live matrix
- [Native prompt attachment size](verification/2026-11-11-ticket-228.md): host `data` payload derives a bounded positive chip size; live attachment check passes
- [Native-first child-ticket evidence index](verification/2026-11-11-native-first-children.md): where each #210–#230 verification lives
- [Retry and interruption for native turns](verification/2026-11-11-ticket-217.md): one durable turn and Work card across retry, interruption, and settlement
- [Native reconciliation and support surface](verification/2026-11-11-ticket-218.md): reconciliation triggers, context reads, and support-surface limits
- [Legacy direct-message transcript contract](verification/2026-11-11-ticket-226.md): one conversation-channel store for direct messages and the retired per-binding branch
- [Compact synthesis context](verification/2026-11-11-ticket-249.md): root synthesis without the bounded group transcript
- [Multi-ticket and token verification](verification/2026-11-11-ticket-251.md): multi-ticket roots, command-cap refusal, prompt/schema token counts, and the Vera regression
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
