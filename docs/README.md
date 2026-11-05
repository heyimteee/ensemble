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
- [Handoff contract](agents/handoff.md): the detailed mandatory completion-handoff, batch-review, loop-guard, and mention rules
- [OpenCode/OpenTUI runtime guide](agents/opencode-tui-runtime.md): host contracts, source navigation, and verification
- [Issue tracker](agents/issue-tracker.md)
- [Labels](agents/triage-labels.md)
- [Domain document conventions](agents/domain.md)
- [Contributing](../CONTRIBUTING.md)
- [Security](../SECURITY.md)

## Verification

- [macOS/Herdr manual checklist](verification/macos-herdr-checklist.md): repeatable, manual, and unexecuted until a run is recorded
- [v5.8 verification](verification/2026-11-05-v58.md): System Agent init and deliberate skill invocation
- [v5.7 verification](verification/2026-11-05-v57.md): persistent modes, native key ownership, and interaction polish

## Architecture status

The developer preview uses a server plugin for state, scheduling, native sessions, RPC, and tools; a TUI plugin for the workspace; and OpenCode plugin storage for durable JSON state. See [Implementation](implementation.md). Add an ADR when a significant, hard-to-reverse trade-off changes this structure.
