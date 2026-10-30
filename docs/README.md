# Documentation

## Product

- [Project overview](../README.md)
- [Domain glossary](../GLOSSARY.md)
- [Implementation and acceptance notes](implementation.md)
- [v2 product specification #17](https://github.com/heyimteee/ensemble/issues/17): workspace group chat, subtasks, leader routing, and native-session drill-down
- [v2 implementation tickets #18–#29](https://github.com/heyimteee/ensemble/issues): independently verifiable slices with blockers
- [Historical v1 specification #1](https://github.com/heyimteee/ensemble/issues/1)
- [OpenCode 2.2.1 compatibility report](compatibility/opencode-2.2.1.md): verified extension behavior, constraints, and gaps

GitHub Issues are the authoritative location for the specification and tickets; avoid maintaining a competing copy of acceptance criteria here. Publishing the plan does not authorize implementation. Start with compatibility ticket #2 and only begin a ticket when its blockers are complete.

## Working agreements

- [Agent instructions](../AGENTS.md)
- [Issue tracker](agents/issue-tracker.md)
- [Labels](agents/triage-labels.md)
- [Domain document conventions](agents/domain.md)
- [Contributing](../CONTRIBUTING.md)
- [Security](../SECURITY.md)

## Architecture status

The developer preview uses a server plugin for state, scheduling, native sessions, RPC, and tools; a TUI plugin for the workspace; and OpenCode plugin storage for durable JSON state. See [Implementation](implementation.md). Add an ADR when a significant, hard-to-reverse trade-off changes this structure.
