---
title: Install Ensemble
description: Add the stable 0.1.1 package to OpenCode, verify the plugin list, and open the workspace.
version: 0.1.x
---

# Install Ensemble

Install the stable `0.1.1` package as one OpenCode plugin, confirm that OpenCode
reports it, and open the Ensemble workspace.

## Before you start

- **OpenCode 2.2.6, 2.2.7, or 2.3.0** on Linux with tmux. macOS with Herdr is
  verified on 2.2.7 only. Windows is out of scope.
- **Node 22.23.4 or newer** on your `PATH`. An older Node fails at plugin load
  with the supported range and upgrade guidance.
- Access to the npm registry, or a local checkout of the repository.

Check the [support matrix](../support/support-matrix.md) if your host or
platform is not listed. An unsupported OpenCode release still loads Ensemble,
but it writes a runtime warning and its behavior is not supported.

## Install the plugin

```sh
opencode plugin add @heyimteee/ensemble@0.1.1
```

Pin the exact version. `0.1.1` is the stable release and the npm `latest` tag;
prereleases stay under `next`.

## Verify the plugin list

```sh
opencode plugin list
```

Expected entry:

```text
ensemble.v2  0.1.1  @heyimteee/ensemble@0.1.1
```

The line shows the plugin ID, the installed version, and the package source. If
the entry is missing, restart OpenCode and run `opencode plugin list` again. If
it still does not appear, re-run the install command and check the registry
output for an error.

## Open Ensemble

Restart OpenCode after the install, then run `/ensemble` or the **Open
Ensemble** palette command. Before you create a workspace, the header reads:

```text
ENSEMBLE │ no workspace
```

The rail has no agents or workspaces yet. The [quickstart](quickstart.md) takes
it from here.

## The single-plugin rule

Load Ensemble exactly once. Do not also load the same package from
`.opencode/plugins/` or from a second entry in `opencode.json`. Two copies
create a duplicate plugin ID, and the workspace can fail to open or behave
inconsistently.

If you previously used a local path, remove that entry before you add the npm
package.

## Install from a checkout

For development, point `opencode.json` at the repository directory instead of
the npm package:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/home/you/dev/ensemble"]
}
```

Run `opencode reload`, or restart the OpenCode service, if the plugin was already
loaded before you updated the checkout. Do not combine the checkout entry with
the npm entry.

## Upgrade

To move from a prerelease or to pin a later stable release, follow
[Upgrade](upgrade.md). The short version is to install the exact target version,
restart OpenCode, and confirm the `opencode plugin list` entry before you open a
workspace.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `opencode plugin add` fails | Check registry access, then run the command again with the exact version. Do not use a Git spec. |
| The plugin list has two Ensemble entries | Remove the local copy or the duplicate entry in `opencode.json`, then restart OpenCode. |
| `/ensemble` does not open | Confirm the host version is in the supported range and that `opencode plugin list` shows the package. Restart the host. |
| The plugin loads with an unsupported-host warning | The host release is outside the tested range. Move to 2.2.6, 2.2.7, or 2.3.0. |
| The agent wizard reports no models | Configure a provider and model in OpenCode, then reopen the wizard. The model list refreshes from the host. |
| A Git install fails during dependency preparation | Git specs (`github:`, `git+https://`, `owner/repo#tag`) fail upstream on OpenCode 2.2.7. Use the npm package or a loopback registry. |

For anything else, read the [support policy](../support/README.md) and include
the host version, Node version, the exact command, and redacted output.

## Next

- [Quickstart](quickstart.md): create a workspace, two agents, and a first
  message.
- [What is Ensemble?](what-is-ensemble.md): the three-pane model and the terms
  used here.
