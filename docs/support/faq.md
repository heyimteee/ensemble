---
title: FAQ
description: Short answers on npm tags, Git installs, Windows, macOS with Herdr, copy-on-select, and no-telemetry diagnostics.
version: 0.1.x
---

# FAQ

These are the boundary questions that come up before an install and after a
failure. Each answer points to the page that owns the detail.

## Before you start

- You know the stable package version: `0.1.1`.
- You have the [support matrix](support-matrix.md) open for platform and host
  claims. A combination outside it is unsupported, not a promised fix.
- Support is best effort through GitHub Issues, as described in the
  [support policy](README.md). There is no private inbox or contractual SLA.

## Which npm tag should I install?

Install `0.1.1` on the `latest` tag and pin the exact version:

```sh
opencode plugin add @heyimteee/ensemble@0.1.1
```

npm dist-tags for this release are `latest: 0.1.1` and `next: 0.1.0-rc.3`. The
`next` tag is prerelease history; do not use it for a deliberate stable install.
Do not write a floating `latest` in a shared instruction: pin the version so a
later publish cannot change what a teammate installs.

Verify the registry state if you need to:

```sh
npm view @heyimteee/ensemble dist-tags
```

`latest` should name `0.1.1`. If it does not, stop and read the
[release notes](../operations/release-notes-0.1.1.md) before installing.

## Do Git installs work?

Use the npm package for a normal install. On OpenCode 2.2.7, Git specs such as
`github:`, `git+https://`, and `owner/repo#tag` fail upstream during Git
dependency preparation, before Ensemble can load.

For development, install from a local checkout instead:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/home/you/dev/ensemble"]
}
```

Run `opencode reload`, or restart the service, after you update the checkout. Do
not combine the checkout entry with the npm entry: two copies create a duplicate
plugin ID. A loopback registry is the supported alternative when you need to test
a packed release without npm.

## Is Windows supported?

No. Native Windows is out of scope for `0.1.x`. It is not tested, and WSL is not
a substitute for Linux/tmux evidence. Do not assume PowerShell, a Windows
terminal, or a WSL distribution behaves like the supported Linux path.

Supported platforms are Linux with tmux, and macOS with Herdr on the installed
path for OpenCode 2.2.7 only. The [support matrix](support-matrix.md) is the
complete boundary.

## What is verified on macOS with Herdr?

The installed path is verified on **OpenCode 2.2.7** with Herdr in Ghostty: the
package installs, the six server tools are present, the TUI route opens, and the
full manual checklist passes. OpenCode 2.3.0 on macOS is not claimed. Linux is
the primary live-tested platform.

Two macOS details matter:

- Automatic copy-on-release is not claimed. The verified path is a pane-bounded
  Shift+drag and an explicit copy.
- Herdr prefix ownership is inconclusive host evidence. It is not a checklist
  failure, and it is not a support claim.

Read the [support matrix](support-matrix.md) for the boundary.

## Why does copy-on-select not copy?

Copy-on-select is a terminal or host preference, not an Ensemble setting. The
host can own the mouse gesture before Ensemble sees it.

In Ensemble, dragging selects text in the pane where the drag starts, and
releasing copies the selection and shows a clipboard toast. If the host
intercepts the gesture, release does nothing visible. On macOS/Herdr the
verified path is Shift+drag inside the pane and an explicit copy; Cmd+C and
Cmd+V also passed. Ghostty `copy-on-select` is off, so a drag alone does not
copy. Automatic copy-on-release is therefore not claimed.

If dragging does not copy:

1. Check the terminal's copy-on-select setting. Turn it on only if that is how
   you want the host to behave.
2. Use the host's explicit copy shortcut after selecting.
3. Use `y` or `yy` to yank to the system clipboard in supported text surfaces.

## What does no-telemetry mean for diagnostics?

Ensemble has no telemetry: no analytics, crash reporting, usage counter, update
ping, or automatic diagnostic upload. The plugin's network traffic is your
OpenCode host and the model provider you configured.

Diagnostics are local and user-initiated:

- `:logs` reads the local structured logs. Content logging is off by default;
  `ENSEMBLE_LOG_CONTENT=1` is an explicit opt-in and includes task and message
  text.
- `npm run doctor -- --json <directory>` reads the service diagnostic snapshot.
  It ships in a source checkout; a package-only install uses `:logs` and the host
  log.
- `npm run support:bundle -- --out /tmp/ensemble-support` writes a local bundle
  and never uploads it. It redacts credentials, conversation keys, and private
  paths, but you must still review it before attaching it to an issue.
- `npm run logs:summary -- --json` summarizes counts and failures without
  printing conversation content.

Nothing is sent to the maintainers unless you attach a reviewed excerpt to an
issue. Keep raw logs, service descriptors, backups, and conversation content
private.

## Expected result

You can choose the exact install tag, recognize whether a Git or Windows install
is in scope, state the macOS boundary, explain a failed copy-on-select, and
collect diagnostics without uploading anything. Each answer ends at the page
that owns the full procedure.

## Next

- [Troubleshooting](troubleshooting.md): install, plugin, workspace, work,
  timeout, and model symptoms.
- [Operations and support](operations.md): the recovery, security, privacy, and
  support front door.
- [Support matrix](support-matrix.md): platforms, versions, terminals, and known
  limitations.
- [Install](../getting-started/install.md): the stable install path and expected
  plugin entry.
- [Upgrade](../getting-started/upgrade.md): move from a prerelease or pin a later
  stable release.

## Go deeper

- [macOS/Herdr manual checklist](../verification/macos-herdr-checklist.md): the
  repeatable procedure behind the macOS support boundary.
- [Scale, soak, and local diagnostics](../operations/scale-and-monitoring.md):
  the no-telemetry policy and the local support bundle.
