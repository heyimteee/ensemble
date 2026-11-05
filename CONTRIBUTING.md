# Contributing to Ensemble

Ensemble is in developer preview. The server and TUI parts load directly from TypeScript; there is no build step. Install locked dependencies with `npm ci` and run `npm run verify` before handoff. See [implementation notes](docs/implementation.md) for local loading.

## Before starting

1. Read [AGENTS.md](AGENTS.md), the [glossary](GLOSSARY.md), and the relevant specification and issue comments.
2. Follow the [issue tracker workflow](docs/agents/issue-tracker.md). Choose an approved ticket whose blockers are complete.
3. Keep changes within the ticket's acceptance criteria. Raise compatibility gaps and changes of scope before implementing them.
4. For TUI or host integration work and location-divergence diagnosis, read the [runtime guide](docs/agents/opencode-tui-runtime.md), including verification scope and editing discipline.

## Changes and verification

- Make narrow, demoable changes with evidence of observable behavior.
- Preserve OpenCode's native experience and permissions.
- Preserve the [native-skill boundary](docs/adr/0001-native-skill-boundary.md) when changing skill routing or init.
- Test the highest practical public boundary rather than internal implementation details.
- Apply the [reviewer standards](docs/agents/review-standards.md) to judgement calls; keep mechanical rules in automated checks. The [review workflow](docs/agents/review-workflow.md) describes the two-axis review.
- State what was verified, the OpenCode version used, and any remaining uncertainty.
- Include regression checks for ordinary OpenCode sessions when changing integration behavior.
- CI runs `npm run verify` plus the deterministic fake and empty live suite on push and pull request, with pinned host tools and `ENSEMBLE_LIVE_REQUIRE=1` so a missing tool fails instead of skipping. Real-model live checks remain local; see [the live harness instructions](scripts/README.md#ci).
- Update documentation when externally visible behavior changes.
- Reference the implementation ticket in a pull request; completing it must not close its parent specification.

## Reporting issues

Use GitHub Issues for bugs, feature requests, documentation, research, and questions. Include reproduction steps and expected versus actual behavior where relevant. Apply an appropriate type label and triage state; see the [label guide](docs/agents/triage-labels.md).

Security-sensitive reports belong in the private process described in [SECURITY.md](SECURITY.md).
