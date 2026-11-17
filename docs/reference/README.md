# Reference

Look-up documentation for the exact surface: tools, commands, keyboard
bindings, configuration, environment, storage, CLI, and supported hosts. Use a
[guide](../guides/README.md) when you want to finish a task and this section
when you need the precise answer.

The generated pages are rendered from the code's registries by
`npm run docs:reference` and checked by `npm run docs:check`. Do not edit a
generated page by hand; change the owning catalog or the reference metadata and
regenerate.

## Generated reference

| Surface | Page |
|---|---|
| Six native tools: caller, gate, inputs, returns, examples, safety | [Native tools](tools.md) |
| Eleven migration/legacy tools, separated from the native path | [Migration and legacy tools](migration-tools.md) |
| All `:` commands and the separate `/` composer catalog | [Command reference](commands.md) |
| Keyboard bindings by context | [Keyboard reference](keyboard.md) |
| Workspace `.ensemble/config.json` and stored settings | [Configuration](configuration.md) |
| Environment variables and state paths | [Environment](environment.md) |
| `.ensemble`, `AGENTS.md`, plugin storage, logs, and edit safety | [Files and storage](files.md) |
| Doctor, data, backup, support bundle, logs, and exit codes | [Operator CLI](cli.md) |
| Supported hosts, Node, and contract constants | [Supported hosts and versions](supported.md) |

## Other reference sources

| Surface | Authoritative page |
|---|---|
| Platform boundary, live-suite prerequisites, and known limitations | [Support matrix](../support/support-matrix.md) |
| Runtime requirements and install commands | [Requirements](../../README.md#requirements) and [Install](../../README.md#install) |
| Backup, restore, and rollback procedures | [Backup and restore](../operations/backup-restore.md) and [Rollback](../operations/rollback.md) |
| Workspace configuration, storage, and retention policy | [Data classes and retention](../privacy/data-and-retention.md) |
| Release history and current npm tags | [Changelog](../../CHANGELOG.md) |
| Domain terms | [Glossary](../../GLOSSARY.md) |

## Historical compatibility

Historical host reports stay public as evidence but are not current support
claims:

- [OpenCode 2.2.1 compatibility report](../compatibility/opencode-2.2.1.md)
- [OpenCode peer compatibility matrix](../verification/2026-11-12-ticket-257.md)
- [Host range evidence](../verification/2026-11-17-ticket-286.md)

## Next

- [Concepts](../concepts/README.md): why the surface is shaped this way.
- [Operations](../operations/README.md): procedures that use these commands.
- [Contributing](../contributing/README.md): where generated reference and its
  contract tests live.
