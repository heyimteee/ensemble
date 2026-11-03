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

- Every non-leader agent turn must end with a handoff to another workspace member: explicit via `ensemble_handoff`, or automatic server default to the workspace leader carrying the finished task content. The group shows `Handed to $Recipient`. Leader turns may end normally or hand off voluntarily.
- A handoff is delegation: write the recipient a clear, self-authored instruction in your own words — never a copy of the user's message. `task` stays the short display title; the recipient's work item uses your instruction.
- Answer first: write your own answer in the group chat before handing off. A handoff forwards a completed result or clearly scoped work; it is never a substitute for answering your assignment.
- Multiple pending completion handoffs for one recipient coalesce into one consolidated batch review turn after a short quiet window (~1s) or when the recipient is free. Decide each item with `ensemble_review` (`delegate` | `start` | `end` | `dismiss`); the batch closes only when every item is acted on or dismissed. Non-leader recipients hand the batch onward (default leader); the leader may end it.
- Loop guards apply: maximum handoff chain depth, no immediate back-and-forth to the previous sender, repeated-recipient detection, forced leader or termination fallback at the cap. Mandatory handoff never calls `ensemble_delegate` after a handoff (leader-only; would double-queue) and never queues duplicate work.
- Mention syntax throughout: `$Name` (or `!Name` alias) for agents; `@` is file-only and never addresses an agent.

## Agent skills

### Issue tracker

Track specifications and tickets in GitHub Issues for heyimteee/ensemble. Before reading, publishing, claiming, or completing work, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels alongside issue-type labels. Before labeling or triaging issues, read `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context glossary and ADR conventions. Before exploration, specification, or terminology changes, read `docs/agents/domain.md` and the domain documents it identifies.
