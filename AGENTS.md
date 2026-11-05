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
- Use patch/direct file edits; for necessary multi-site scripted edits, inspect a temporary script and run it once. See the guide's editing discipline.
- Run `npm run verify` after source changes and before handoff; report live checks separately, including skips.

## End-of-turn handoff (mandatory, ticket #71)

Every non-leader agent turn must end with a handoff to another workspace member before the turn closes. Read the [handoff contract](docs/agents/handoff.md) for delegation content, batched review, loop guards, and mention syntax.

## Agent skills

### Native skills

Native skill execution is authoritative. Ensemble routes exact user text, validates Skillbox ownership, and sends General skills to leader triage; it does not reimplement skill loading, create per-skill tasks, or use prompt attachments or experimental activation. Before changing skill routing or init, read [ADR 0001: Native-skill boundary](docs/adr/0001-native-skill-boundary.md).

### Issue tracker

Track specifications and tickets in GitHub Issues for heyimteee/ensemble. Before reading, publishing, claiming, or completing work, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels alongside issue-type labels. Before labeling or triaging issues, read `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context glossary and ADR conventions. Before exploration, specification, or terminology changes, read `docs/agents/domain.md` and the domain documents it identifies.
