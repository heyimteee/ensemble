# Ensemble

**Your persistent agent team, inside OpenCode.**

Ensemble is a planned TUI extension for OpenCode: named teammates with roles, models, memories, and assigned skills, working together in project channels.

> **Status: documentation-only scaffold.** No plugin is implemented or installable yet. Compatibility with the installed OpenCode release must be verified before implementation. No runtime, package manager, storage design, or code architecture has been selected.

## The experience

- Maintain a personal roster of named agents, reusable across projects.
- Configure each agent through General, Models, Memories, and Skillbox tabs.
- Choose a main model, supported reasoning effort, and ordered backup models.
- Assign an exclusive Skillbox from skills already available in OpenCode.
- Chat privately with agents or bring them into project channels.
- Address agents with `!mentions`; send unaddressed messages to the channel's assigned leader.
- Follow visible messages, handoffs, queues, and approvals.
- Keep work running through OpenCode's native background server after closing the TUI.

## Extend, never replace

OpenCode remains responsible for native sessions, model execution, tools, and permission handling. Ensemble must preserve ordinary sessions, built-in agents, configuration, and existing integrations. Unsupported requirements must be surfaced, not hidden behind core patches or private APIs.

Skills are instructions, not permissions. Memories are saved knowledge, not unlimited model context. A channel leader coordinates work but cannot approve actions on your behalf.

## Scope

The first release targets the terminal UI only. Scheduled routines, external event triggers, proactive task monitoring, remote hosting, and browser/computer automation are excluded. Work explicitly requested by the user can continue in the native background server.

## Project documentation

- [Documentation index](docs/README.md)
- [Glossary](GLOSSARY.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [GitHub Issues](https://github.com/heyimteee/ensemble/issues): specifications, acceptance criteria, and implementation tickets

## License

A license has not been selected. Public repository visibility does not grant an open-source license.
