# Domain docs

Ensemble uses a **single-context** domain vocabulary.

## Before exploration or writing

1. Read the root `GLOSSARY.md`. If a future `GLOSSARY-MAP.md` exists, follow it to the relevant glossary instead.
2. Read relevant ADRs under `docs/adr/` if present.
3. Use glossary terms consistently in specifications, issue titles, tests, and documentation.
4. Surface conflicts with an existing ADR before proposing a conflicting change.

Missing domain documents do not block exploration. Create them only when there are resolved concepts or decisions to record.

## Maintaining the model

Keep the glossary limited to concise domain definitions, not implementation details or acceptance criteria. Resolve ambiguous terminology before introducing competing synonyms.

Record an ADR only for a significant, hard-to-reverse decision with a genuine trade-off that would otherwise surprise a future contributor. No implementation ADR is selected by this documentation scaffold.
