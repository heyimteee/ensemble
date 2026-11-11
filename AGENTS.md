# Ensemble agent instructions

Ensemble extends OpenCode's TUI with persistent agent teams. Keep changes within approved tickets and preserve the extension boundaries below.

## Compatibility boundaries

- Use supported OpenCode extension APIs and native sessions, tools, providers, and permissions.
- Preserve ordinary sessions, built-in agents, unrelated configuration, and other integrations.
- Verify compatibility against the target OpenCode release; distinguish documented behavior from tested behavior.
- Surface unsupported requirements before implementation. Do not silently adopt private APIs, core patches, or weaker Skillbox enforcement.
- Keep credentials, conversation content, and runtime memories out of the repository and public issues.

## Development

- Before changing TUI behavior, diagnosing location divergence, or editing host integration, read [the runtime guide](docs/agents/opencode-tui-runtime.md).
- Before changing the service registry, work recovery, or plugin lifecycle, read [ADR 0003](docs/adr/0003-single-service-and-safe-recovery.md).
- Use patch/direct file edits; for necessary multi-site scripted edits, inspect a temporary script and run it once. See the guide's editing discipline.
- Run `npm run verify` after source changes and before handoff; report live checks separately, including skips.

## End-of-turn completion (server-owned, ticket #238)

This section governs Ensemble runtime agents, not coding agents working in this repository. A non-leader Ensemble agent turn ends by posting its answer as the group message; the server owns completion and decides whether the finished result returns to the leader. Do not claim a teammate replied until their turn is visible, and do not open a second completion loop for a teammate you asked. Explicit `delegate`/`handoff` are migration tools, not the normal chat path. Read the [handoff contract](docs/agents/handoff.md) for delegation content, batched review, loop guards, and mention syntax.

## Agent skills

### Native skills

Native skill execution is authoritative. Ensemble routes exact user text, validates Skillbox ownership, and sends General skills to leader triage; it does not reimplement skill loading, create per-skill tasks, or use prompt attachments or experimental activation. Before changing skill routing or init, read [ADR 0001: Native-skill boundary](docs/adr/0001-native-skill-boundary.md).

### Issue tracker

Track specifications and tickets in GitHub Issues for heyimteee/ensemble. Before reading, publishing, claiming, or completing work, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels alongside issue-type labels. Before labeling or triaging issues, read `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context glossary and ADR conventions. Before exploration, specification, or terminology changes, read `docs/agents/domain.md` and the domain documents it identifies.
