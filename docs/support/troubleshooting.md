---
title: Troubleshooting
description: Resolve install, plugin, workspace, work, native-turn, and model failures before you file an issue.
version: 0.1.x
---

# Troubleshooting

Start with the symptom you can see. Each section names the likely layer, the
checks that separate one cause from another, and the smallest safe action. Do not
delete state, storage, or logs to reset a symptom.

## Before you start

- You know the exact Ensemble, OpenCode, and Node versions. Run the checks below.
- You have the [support matrix](support-matrix.md) open. An unsupported host or
  platform is a boundary, not a bug to fix by reinstalling.
- You can fully quit every OpenCode TUI client, not only the service. A
  service-only restart does not rebuild the TUI module graph.
- You are ready to redact paths, names, conversation text, and identifiers
  before posting anything publicly.

Run the first checks from a terminal:

```sh
opencode --version
node --version
npm --version
opencode plugin list
```

A healthy install shows one entry:

```text
ensemble.v2  0.1.0  @heyimteee/ensemble@0.1.0
```

Node must be 22.23.4 or newer, and OpenCode must be 2.2.6, 2.2.7, or 2.3.0.
If the versions differ, fix that before you debug the symptom.

## Install fails

**Symptom:** `opencode plugin add` exits with an error, the package is missing
from `opencode plugin list`, or `/ensemble` does not open after a reported
success.

1. Confirm Node. An older Node fails at plugin load and names the supported
   range. Install Node 22.23.4 or newer and reopen the terminal.
2. Pin the exact stable version:

   ```sh
   opencode plugin add @heyimteee/ensemble@0.1.0
   ```

   Do not use a Git spec. On OpenCode 2.2.7, `github:`, `git+https://`, and
   `owner/repo#tag` specs fail upstream during Git dependency preparation.
3. Read the registry error. A network, proxy, or authentication failure is a
   registry problem, not an Ensemble problem. Fix registry access and run the
   same command again.
4. Confirm the host version. An unsupported OpenCode 2.x release still loads the
   plugin but writes a runtime warning; behavior on that release is not
   supported. Move to 2.2.6, 2.2.7, or 2.3.0.
5. Fully quit every OpenCode client and restart. Then run
   `opencode plugin list` and open `/ensemble`.
6. If you installed from a checkout, point `opencode.json` at the repository
   directory and remove any npm entry for the same package. Do not load both.

**Expected result:** one package entry at `0.1.0`, and `ENSEMBLE │ no workspace`
or the selected workspace opens without a plugin failure. If the entry is still
missing, collect the install command, the registry output, and the versions, then
read the [support policy](README.md).

## Duplicate plugin ID

**Symptom:** `opencode plugin list` shows two Ensemble entries, the workspace
fails to open, the plugin reports a duplicate plugin ID, or behavior differs
between windows.

**Cause:** Ensemble is loaded more than once. The usual sources are a local copy
under `.opencode/plugins/` plus the npm package, or two entries in
`opencode.json`.

1. Run `opencode plugin list` and write down every Ensemble entry and its source.
2. Keep one source. Remove the duplicate local plugin directory or the duplicate
   `opencode.json` entry; do not edit the installed package to hide the second
   load.
3. If you previously pointed at a local checkout, remove that entry before you
   add the npm package. A checkout and an npm package are two copies of the same
   plugin.
4. Fully quit every OpenCode TUI client, then restart the service and clients.
   A service-only restart can leave the old module graph in place.
5. Run `opencode plugin list` again and open a scratch workspace before the real
   one.

**Expected result:** exactly one `ensemble.v2` entry, one version, and one
source. A second entry means a second load path is still active; find it before
you create more work.

## No workspace

**Symptom:** the header reads `ENSEMBLE │ no workspace`, the rail has no
workspace, or the workspace wizard does not offer a directory.

This is usually an empty state, not a failure. An agent without a workspace has
a direct chat under **Homeless**; a workspace needs at least one member.

1. Create an agent first. Press `h` for the rail, then `a`, and complete the
   wizard. Repeat for the second agent.
2. Press `h` to return to the rail, then `n` to create a workspace.
3. Choose the current directory, or type the project path. Enter a name. Select
   at least one member with `Space`. Choose a leader from those members. Choose
   whether the leader synthesizes.
4. Confirm the toast `#acme-notes created.` The group chat opens and the header
   shows the workspace.
5. If a workspace exists in `.ensemble/config.json` but the rail does not show
   it, confirm OpenCode was started in that directory, run
   `cat .ensemble/config.json`, and restart every client. A missing config file
   means the directory is not an Ensemble workspace, even if it contains other
   project files.
6. If the plugin list has duplicate entries, fix that first. A duplicate load can
   make the workspace fail to open or behave inconsistently.

**Expected result:** one workspace in the rail, one group chat, and the members
you selected. The header no longer reads **no workspace**. If the config exists
and the workspace still does not appear, follow the
[incident runbook](incident-runbook.md#symptom-guide) instead of recreating it.

## Stuck or needs-you work

**Symptom:** a card stays in **ACTIVE**, never reaches **HISTORY**, or reads
**NEEDS YOU**.

Status is a signal, not a verdict. Read the word before you act:

| State | Meaning | First action |
|---|---|---|
| **QUEUED** | Waiting to be claimed | Check that the workspace is not paused (`p`) and the agent has a model |
| **WORKING** | A run is live | Open the native session with `o`; a slow model is not a failure |
| **WAITING** | Waiting for child work | Inspect the children; a waiting parent is normal coordination |
| **RETRYING** | A transient failure scheduled a retry | Wait for the retry or inspect `:logs task <id>` |
| **NEEDS YOU** | An approval, interruption, or native permission needs your decision | Press `v` for an attached approval; otherwise restart with `R` or cancel with `x` |
| **STALLED** | Delivery or lease exhaustion without a native error | Press `r` to retry; `R` to restart; `x` to cancel |
| **FAILED** | The native execution or model really errored | Press `o` for the error, fix the cause, then retry |
| **CANCELLED** | You stopped it | It stays in HISTORY; retry only if you need the work |

For **NEEDS YOU**, check for a pending approval. **Resume work** continues an
interrupted run once; **Discard** marks it failed. If no approval is attached,
restart the card with `R` or cancel it with `x`. An approval cannot override a
host tool permission and does not become a permanent grant.

For a stuck queue, open `:logs` and use `:logs failures` or
`:logs task <id>`. The viewer shows the sink paths and counters. Keep content
logging off; do not enable `ENSEMBLE_LOG_CONTENT=1` for a report.

**Expected result:** the card either replies, is cancelled, or moves to a
specific failure you can explain. If it returns to **STALLED** after a retry, or
several agents are stuck at once, stop retrying and use the
[incident runbook](incident-runbook.md#symptom-guide).

## Native turn timeout

**Symptom:** an agent's turn produces no reply for several minutes, the native
session looks idle, and the work item eventually reads **NEEDS YOU**. An
interrupted-work approval may also appear.

**Cause:** the host never delivered a terminal event for the turn, or the session
ended without a final answer. Ensemble re-reads the native transcript at a
bounded interval and does not mark a turn interrupted on elapsed time alone. A
slow model, a long tool call, or a background subagent can all look silent while
still being alive.

1. Press `o` on the card and read the native session. Look for a final assistant
   message, a pending tool call, or a host permission prompt.
2. Return with `F2`. If an interrupted-work approval is attached, press `v` and
   choose **Resume work** or **Discard**. Resume continues the work once;
   discard marks it failed.
3. If the card reads **NEEDS YOU** with no approval, press `R` to restart it from
   a clean stopped state, or `x` to cancel it. Do not restart the service, delete
   state, or resend the prompt while the host may still be running it. A second
   run can duplicate tool side effects.
4. If the turn was already answered in the native transcript, let the recovered
   answer settle the card. A recovered answer supersedes an earlier retry or
   interruption notice.
5. If the same session times out repeatedly, record the host version, the model,
   the last tool activity, and the `:logs task <id>` timeline, then follow the
   [incident runbook](incident-runbook.md).

**Expected result:** either the answer appears and the card moves to **REPLIED**,
or you deliberately restart, resume, discard, or cancel the interrupted work. A
card that still reads **NEEDS YOU** has an interrupted run or an unresolved
approval, not a second timeout.

## Missing model

**Symptom:** the agent wizard says `No models are available`, a model picker
rejects the selected model, a card stays **QUEUED**, or a turn fails with a model
availability error.

1. Confirm a provider and model exist in OpenCode. Ensemble reads the host
   catalog; it does not ship a model or a provider.
2. Reopen the agent wizard or the model picker. The list refreshes from the host.
   If the project reports no models, fix the host provider configuration first.
3. Assign a main model to every workspace member. Open the agent settings with
   `s`, then **Models**, choose a provider and model, and save with `s`.
4. Add a backup model with `a` and reorder the list with `J`/`K`. Ensemble tries
   a backup only when the main model has an availability failure, and announces
   the switch in the transcript.
5. If the transcript says `Model unavailable; switched to ...`, the fallback
   worked. Make the fallback deliberate rather than relying on a single model.
6. Retry a failed card after the model is fixed. A queued card can start once its
   assignee has a usable model.

**Expected result:** the picker lists models, every member has a main model, and
a new turn starts or fails with a specific provider error rather than **QUEUED**.
If the host still reports no models, collect the OpenCode provider configuration
(redacted) and the exact picker message.

## Expected result

You can name the failing layer, the check that confirmed it, and the smallest
action you took. The plugin list has one entry, the workspace is visible, or the
work item has a deliberate outcome instead of an unexplained **ACTIVE** card.

## Next

- [FAQ](faq.md): npm tags, Git installs, Windows, macOS/Herdr, copy-on-select,
  and diagnostics.
- [Operations and support](operations.md): one front door for recovery, support,
  security, and privacy.
- [Support policy](README.md): channels, response targets, and redaction.
- [Incident runbook](incident-runbook.md): broken workspaces, stuck work, and
  data recovery.
- [Support matrix](support-matrix.md): supported hosts, terminals, and known
  limitations.
