# Incident runbook

Use this runbook when Ensemble is not loading, a workspace is stuck or
diverged, an upgrade failed, or data appears lost. It covers the supported
Linux/tmux path first. macOS/Herdr remains unverified until ticket #277 records
a run; do not treat a macOS-only failure as a supported defect without that
evidence. Windows is out of scope.

The runbook is written for operators as well as users. It is deliberately
conservative: preserve evidence before attempting a repair, and never hand-edit
OpenCode storage.

## Severity and first response

| Severity | Examples | Response |
|---|---|---|
| SEV1 | Data loss or corruption, credential exposure, a vulnerability with a plausible exploit, all workspaces unusable | Stop using the affected host, preserve evidence, use the private security route for anything security-related, and escalate to the maintainer immediately |
| SEV2 | One workspace cannot load, work is stuck for all agents, an upgrade broke the install, repeated service restarts | Preserve logs, try the rollback path, and file one issue with the diagnostic bundle |
| SEV3 | One agent or one card misbehaves, cosmetic or recoverable mismatch, unsupported platform behavior | Collect diagnostics, use the workaround, and file a normal issue |

**First response, in order:**

1. Stop creating new work. Do not delete state, storage, logs, or workspace
   files to "reset" the symptom.
2. Record the time, the exact Ensemble version, the OpenCode version, and what
   changed since the last good run.
3. Copy the diagnostic evidence described in [Diagnostics](#diagnostics).
4. Choose the smallest reversible action: retry the card, restart the client,
   downgrade the package, or restore a backup. Do not combine actions in one
   step; a failed repair destroys the evidence for the next attempt.
5. Decide whether the incident is security-related. If it is, stop and follow
   [SECURITY.md](../../SECURITY.md) instead of a public issue.

## Symptom guide

| Symptom | Likely layer | First checks | Safe action |
|---|---|---|---|
| `/ensemble` is missing, the route does not open, or `plugin operation failed` appears | Install, host, or stale TUI module graph | `opencode plugin list`; full client version output; host log for the plugin ID; duplicate plugin entries | Fully quit every OpenCode TUI client, not only the service, then restart; reinstall the same version if the entry is missing |
| Unsupported-version warning at load | Host or Node outside the tested range | `opencode --version`, `node --version`, [support matrix](support-matrix.md) | Move to a supported version; do not disable the warning as a fix |
| Roster, members, or leader disagree between locations | Workspace config, storage reconciliation, or stale client | `doctor --json` for each directory; compare `.ensemble/config.json` with the stored workspace | Keep config authoritative, reopen the workspace so reconciliation runs, and restart stale clients; do not hand-edit storage |
| Work is stuck in `working`, `waiting`, or `stalled` | Service, lease, provider, or approval | `:logs task <id>`, `:logs failures`, service descriptor, provider status | Retry once; if the task is parked on an approval, resolve the approval; restart the service only after collecting logs |
| Messages stream stale, duplicate, or out of order | Feed or client connection | `:logs` for `feed.gap` and `feed.reset`; timestamps for the last good patch | Restart the client; if the service restarted, note it in the report and let the client reconnect before forcing a reload |
| An approval cannot be found or resolved | Host permissions or approval lifecycle | Approvals pane (`v`), `:logs` approval events, OpenCode permission prompt | Resolve through the host; never bypass or self-approve. Restarting does not grant a missing permission |
| Init failed, or `AGENTS.md` / `.ensemble/init.json` look wrong | Init job, file permissions, or a failed write | Init report, `.ensemble/init.json`, the generated block in `AGENTS.md`, `:logs` init events | Restore `AGENTS.md` from version control or backup, fix the write failure, and rerun init |
| All panes are slow or the terminal appears frozen | Render latency, host load, or oversized state | Terminal size, host CPU, `:logs` drop counters, latency samples | Reduce pane width or close the Work pane as a diagnostic; record timings before restarting |
| Logs or storage fill the disk | Retention, rotation, or a write loop | Log directory size, `:logs` sink paths, free space | Archive or remove old log files only; never delete active state as a space fix |
| The host crashes or the service restarts | Host or process lifecycle | Last log line, service descriptor, reconnection result | Restart in order: service, then clients; inspect interrupted Work and run the doctor |
| A security issue is suspected | Security | Private reporting only | Stop, preserve evidence, and use `SECURITY.md`; do not post details publicly |

## Diagnostics

Collect the smallest set that explains the failure. Keep the raw bundle local;
post only redacted excerpts.

### Versions and install

```sh
opencode --version
node --version
npm --version
opencode plugin list
```

Record the Ensemble version shown by the plugin list, the install method (npm
version, Git spec, or local checkout), the operating system and terminal host,
and the terminal size.

### In-app logs

Open `:logs` in Ensemble. Use `:logs failures` for failure records and
`:logs task <id>` for one task timeline. The viewer shows the current sink
paths, ring/drop counters, and whether content logging is enabled. `r` refreshes,
`j`/`k` scroll, and `Esc` closes.

Content logging is off by default. Do not enable `ENSEMBLE_LOG_CONTENT=1` for a
support report; it includes task and message text.

### Doctor

The doctor is read-only and compares rosters, workspaces, member IDs, leaders,
session bindings, and `.ensemble/config.json`. It also validates dispatch
ledger invariants. Run it from a checkout of the same Ensemble version:

```sh
npm run doctor -- /path/to/project /path/to/another-project
npm run doctor -- --json --service-file /path/to/service.json /path/to/project
npm run doctor -- --server http://127.0.0.1:4096 /path/to/project
```

Exit `0` means agreement, `1` means divergence, and `2` means a usage,
connection, snapshot, or config-read failure. Use `npm run --silent doctor --
--json …` for a clean JSON stream. Paste the exit code, the mismatch codes, and
the report shape. Remove absolute private paths, workspace names, agent names,
and any task identifiers that identify a customer.

The doctor is snapshot-only: it does not call `invoke`, write files, repair
data, or change service lifecycle. OpenCode may reconcile and persist workspace
state while answering the snapshot. Bindings are created lazily and retained
for former members, so a missing or retained binding alone is not a defect.

If Ensemble was installed from npm and no matching checkout is available, use
the in-app `:logs` viewer and the host log. A doctor bundle requires the
repository at the same version.

### Log summary

From a checkout:

```sh
npm run logs:summary
npm run logs:summary -- --since 2026-11-16T00:00:00Z --level warn
npm run logs:summary -- --task <id> --json
```

The summary reports counts, roles, levels, events, warnings, failures, dropped
lines, feed resets/gaps, dispatch counts, and failure classes. Prefer this
summary over raw JSONL.

### Files and paths

Use the paths printed by `:logs` and the host rather than guessing:

| Item | Default location |
|---|---|
| Ensemble logs | `$XDG_STATE_HOME/ensemble/logs`, or `~/.local/state/ensemble/logs` |
| OpenCode service descriptor | `$XDG_STATE_HOME/opencode/service.json`, or `~/.local/state/opencode/service.json` |
| Workspace config | `<workspace>/.ensemble/config.json` |
| Init metadata | `<workspace>/.ensemble/init.json` |
| Generated instructions | `<workspace>/AGENTS.md` |
| Host log | OpenCode's data directory, normally `${XDG_DATA_HOME:-$HOME/.local/share}/opencode/log/opencode.log` |

The service descriptor may contain a password. Do not attach or paste it.
`OPENCODE_PASSWORD` overrides its password; `--server` bypasses the descriptor
and uses only `OPENCODE_PASSWORD`, and must not receive an unrelated local
password.

### Evidence bundle

Create a private directory and record a short `manifest.txt` with the time,
versions, install method, commands, exit codes, and steps already tried. Add:

- doctor JSON output with private paths and names removed;
- log-summary JSON, or the field-level excerpts that explain the failure;
- the relevant host-log lines, redacted;
- screenshots or text captures that show the symptom without conversation
  content;
- the exact steps to reproduce, including the workspace shape (number of
  agents and members, not their private names).

Do not add raw logs, OpenCode storage, the service descriptor, conversation
transcripts, memories, attachments, database files, or a zip of the workspace.
Attach evidence only after reading it; GitHub issues are public.

## Rollback

Rollback the package first. Restore data only if the package rollback is not
enough, because restoring data is destructive and can discard newer state. The
detailed procedures are in
[upgrade](../operations/upgrade.md) and
[package rollback](../operations/rollback.md).

### Package rollback

1. Record the failing version and the last known-good version.
2. Pin the previous version:

   ```sh
   opencode plugin add @heyimteee/ensemble@<last-known-good>
   ```

   The exact `plugin` subcommands vary by OpenCode release; confirm them with
   `opencode plugin --help` and use the equivalent exact-version install.
3. Confirm the entry with `opencode plugin list`.
4. Fully quit every OpenCode TUI client attached to the host, then restart the
   service and clients. A service-only restart does not rebuild the TUI module
   graph.
5. Open a scratch workspace and confirm the route, `/ensemble`, and one group
   message before reopening the real workspace.
6. Run the doctor against the affected workspace.

A package downgrade does not delete state. If the older package cannot read
state written by the newer one, stop. Do not downgrade repeatedly or edit
storage to force compatibility; preserve the state and restore a backup
instead.

### Disable without uninstalling

If the host must keep running and Ensemble is blocking it, remove the Ensemble
plugin entry from the OpenCode configuration and restart the clients. Record
the previous entry first so it can be restored. Disabling the plugin is a
containment step, not a fix; the underlying state is unchanged.

### Operator-side release rollback

For a bad published release, the maintainer should deprecate the affected
version, publish a fixed patch, and update the support matrix and release notes.
Do not instruct users to unpublish, delete storage, or downgrade across an
incompatible state change.

## Data recovery

Ensemble state has three distinct owners. Recover them in this order.

### 1. Stop and snapshot

Stop every OpenCode TUI client, then the service. Copy the entire Ensemble log
directory, the workspace `.ensemble` directory, `AGENTS.md`, and any host
backup to a private location. Do not move the originals. Record the copy time.

### 2. Restore workspace-owned files

`.ensemble/config.json` is authoritative for the workspace name, leader,
members, synthesis, and pause state. It is human-editable and may be restored
from version control or a backup. Keep `version` and the member names
consistent; do not invent duplicate members.

`AGENTS.md` is user-owned. Restore it from version control or a backup. The
Ensemble block is versioned and can be regenerated by rerunning init after the
file is writable. `.ensemble/init.json` records the block version; restore it
with the same backup when possible.

### 3. Restore host-owned state

Conversations, messages, Work, approvals, memories, and bindings live in
OpenCode plugin storage. There is no supported hand-edit path. Use the ticket
#273 recovery path when an `ensemble.backup` file exists:

```sh
npm run backup -- status /path/to/project
npm run backup -- restore --in ./ensemble-backup.json --confirm RESTORE /path/to/project
npm run backup -- rollback --confirm ROLLBACK /path/to/project
```

Restore validates the document, refuses while work is running, keeps one
pre-restore rollback slot, and restores state plus the workspace config. It
contains conversation content: keep it private and never attach it to an
issue. If no Ensemble backup exists, restore the whole host data directory
with the host's own procedure, with all clients and the service stopped, then
start the service and run the doctor before opening a workspace.

If no backup exists, do not reconstruct history by editing storage. Preserve
what remains, run the doctor, and report the symptom with identifiers and
timestamps only. Ensemble cannot recover conversation or memory text that the
host no longer has.

### 4. Verify

- The doctor exits `0` for every affected directory.
- `.ensemble/config.json` and the stored workspace agree on name, leader,
  members, synthesis, and paused state.
- The group chat, one direct chat, and the Work pane load without a stale
  binding.
- A scratch message reaches its intended recipient.
- Init can write and restore `AGENTS.md` in a scratch workspace.

Record the restore source, versions, commands, and verification result in the
incident issue. Do not attach the backup.

## Escalation

| Trigger | Escalate to | Route |
|---|---|---|
| Suspected vulnerability, credential exposure, or exploit | Security owner / maintainer | Private advisory per [SECURITY.md](../../SECURITY.md); no public details |
| Data loss or corruption that survives rollback and backup restore | Maintainer, SEV1 | Private advisory if security-related; otherwise a public issue with identifiers only |
| Install or upgrade failure that blocks all users | Release manager / maintainer | Issue tagged `bug` with the release version and rollback result |
| Supported-configuration defect with a clean reproduction | Maintainer | Public bug report using the issue template |
| Unsupported platform or version | No escalation | Document as out of scope; see the [support matrix](support-matrix.md) |

Escalation is complete when a maintainer owns the issue, the severity is
recorded, the evidence bundle location is stated privately, and the next action
and owner are named. Never include credentials, conversation content, file
bytes, or private paths in the escalation itself.

## After the incident

1. Record the timeline, versions, commands, rollback or restore action, and
   verification result.
2. File one follow-up issue for the root cause and one for any missing
   diagnostic or template field the incident exposed.
3. If the support matrix or this runbook was wrong or incomplete, update it in
   the same follow-up.
4. Keep the private evidence bundle only as long as needed; delete it after the
   follow-up is closed.
