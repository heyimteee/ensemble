# Reference

Look-up documentation for the exact surface: tools, commands, keyboard
bindings, configuration, environment, storage, CLI, and supported hosts. Use a
[guide](../guides/README.md) when you want to finish a task and this section
when you need the precise answer.

Reference pages will be generated from the code's registries so they cannot
drift. Until then, these existing pages are authoritative; do not hand-copy a
list from the source unless the page you are editing owns that list.

## Current reference sources

| Surface | Authoritative page |
|---|---|
| Supported OpenCode hosts, peer range, runtime warning, and CLI-to-API mapping | [OpenCode host support range](../compatibility/opencode-host-range.md) |
| Platform boundary, live-suite prerequisites, and known limitations | [Support matrix](../support/support-matrix.md) |
| Keyboard bindings, modes, composer, settings, wizard, and dispatch limits | [Keyboard reference](../../README.md#keyboard) |
| Runtime requirements and install commands | [Requirements](../../README.md#requirements) and [Install](../../README.md#install) |
| Doctor, data export, and data delete commands | [Runtime diagnosis](../../README.md#runtime-diagnosis) |
| Backup, restore, and rollback commands | [Backup and restore](../operations/backup-restore.md) and [Rollback](../operations/rollback.md) |
| Workspace configuration, storage, and retention | [Data classes and retention](../privacy/data-and-retention.md) |
| Native tool surface and implementation boundaries | [Implementation notes](../implementation.md#native-tools) |
| Release history and current npm tags | [Changelog](../../CHANGELOG.md) |
| Domain terms | [Glossary](../../GLOSSARY.md) |

## Planned generated reference

The next docs update generates these pages from the code's own registries so they
cannot drift:

- Native tools and migration/legacy tools.
- `:` commands and their arguments.
- Keyboard bindings by context.
- Workspace configuration fields and environment variables.
- File and storage layout.
- Operator CLI commands and exit codes.
- Supported hosts and support ranges.

A contract test will compare the generated output with the tool registrar,
command list, keybinding definitions, configuration types, and support
constants.

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
