# Issue labels

Type describes the work; triage describes its readiness. Use both where applicable. Labels do not start agents, and `ready-for-agent` does not mean dependencies have been completed.

## Canonical triage mapping

| Skill role | GitHub label | Meaning |
| --- | --- | --- |
| needs-triage | `needs-triage` | Needs initial evaluation |
| needs-info | `needs-info` | Waiting for clarification or missing information |
| ready-for-agent | `ready-for-agent` | Approved and specified for agent implementation, subject to blockers |
| ready-for-human | `ready-for-human` | Requires human judgment or manual work |
| wontfix | `wontfix` | Intentionally will not be implemented |

Use one current triage state. Replace it when readiness changes. Parent specifications also use `ready-for-agent` once approved, but are not single implementation assignments.

## General labels

| Label | Meaning |
| --- | --- |
| `bug` | Something is broken |
| `fix` | Work that corrects a defect |
| `feature` | New capability |
| `enhancement` | Improvement to an existing capability |
| `docs` | Documentation |
| `question` | Help or clarification |
| `maintenance` | Repository upkeep and dependencies |
| `research` | Investigation or compatibility checks |
| `testing` | Test coverage and verification |
| `security` | Security-related work |
| `general` | Discussion that does not fit another type |
| `duplicate` | Already tracked elsewhere; link the canonical issue |
| `invalid` | Not an actionable issue |

Apply the most specific appropriate type labels. For example, `bug` + `ready-for-agent`, `feature` + `needs-info`, or `research` + `testing` + `ready-for-agent`.
