# Ensemble agent instructions

Ensemble extends OpenCode's TUI with persistent agent teams. The repository now contains a developer-preview implementation on the integration branch. Keep changes within approved tickets and preserve the extension boundaries below.

## Compatibility boundaries

- Use supported OpenCode extension APIs and native sessions, tools, providers, and permissions.
- Preserve ordinary sessions, built-in agents, unrelated configuration, and other integrations.
- Verify compatibility against the target OpenCode release; distinguish documented behavior from tested behavior.
- Surface unsupported requirements before implementation. Do not silently adopt private APIs, core patches, or weaker Skillbox enforcement.
- Keep credentials, conversation content, and runtime memories out of the repository and public issues.

## Agent skills

### Issue tracker

Track specifications and tickets in GitHub Issues for heyimteee/ensemble. Before reading, publishing, claiming, or completing work, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels alongside issue-type labels. Before labeling or triaging issues, read `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context glossary and ADR conventions. Before exploration, specification, or terminology changes, read `docs/agents/domain.md` and the domain documents it identifies.
