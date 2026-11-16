# Data classes, retention, export, and delete

This page is the user-facing data policy for Ensemble (ticket #272, parent #268).
It covers what Ensemble stores, how long it keeps it, how to export it, and how
to delete it. It also documents the v7 roster disclosure in workspace
`AGENTS.md`.

Ensemble has **no telemetry**. Operational diagnostics stay on the local machine
(OpenCode plugin storage and local JSONL logs); nothing is sent to the Ensemble
project. Credentials are never stored in Ensemble rows, exported, or printed by
the data commands.

## Data classes and retention

| Data class | Where it lives | What it contains | Retention | Export | Delete |
|---|---|---|---|---|---|
| Conversations and messages | OpenCode plugin storage (`v2/message/…`) | Group and direct message text, author, sequence, timestamps, attachment **metadata** | Until you delete the workspace data, delete the workspace, or reset Ensemble. No automatic message expiry. | Yes | Yes |
| Work | OpenCode plugin storage (`v2/subtask/…`, `v2/dispatchgroup/…`, `v2/init/…`, `v2/native-subagent/…`) | Task titles, instructions, constraints, expected result, state, assignee, structured failure cause, dispatch budgets | Terminal Work rows (including finished native-subagent rows) are purged **24 hours** after they finish (`FINISHED_RETENTION_MS`). Live, waiting, and stalled rows stay until they finish or are deleted. Init jobs stay until workspace delete or reset. | Yes (live rows; the export reads current state) | Yes |
| Memories | OpenCode plugin storage (`v2/memory/…`) | Memory text, scope, origin, source, edit history | Until deleted. `memory.delete` marks a row deleted; the row (and its text) is removed by workspace delete, workspace data delete, or reset. | Yes, for memories attributed to this workspace | Yes, for memories attributed to this workspace |
| Approvals and queued direct sends | OpenCode plugin storage (`v2/approval/…`, `v2/dmqueue/…`) | Approval title/detail, resolution, queued direct text | Until resolved and then workspace data delete or reset; queued rows leave the queue when sent | Approvals: no. Queue text: no. | Yes |
| Native session bindings | OpenCode plugin storage (`v2/binding/…`) | Host session ids, retired-session history, binding directory | Until the binding is reassigned, the agent/workspace is deleted, or workspace data is deleted | No (host identity and private paths are excluded) | Yes, for this workspace; home bindings are kept |
| Host native sessions | OpenCode (the host owns them) | The host's own conversation transcript and tool history | Owned by OpenCode, not Ensemble; visible and removable in the host | No | Only with `--delete-native-sessions`, and the host may still keep its own copies |
| Attachments | `<workspace>/.ensemble/attachments/` (gitignored) | File and image bytes | Until the conversation is deleted or the workspace is deleted/reset | Metadata only (name, MIME type, size, kind); never bytes or paths | Yes, all attachments under the workspace |
| Workspace config | `<workspace>/.ensemble/config.json` (gitignored) | Workspace name, leader, member names, synthesis/paused flags | Until the workspace is archived/deleted or reset | Membership only (names/titles/roles), not the path or file | Kept, so the workspace keeps working |
| Generated `AGENTS.md` roster block | `<workspace>/AGENTS.md` (project file, often committed) | Team contract plus leader/member names, titles, and roles | Until you edit or remove the block, or Ensemble refreshes it on config reconciliation | No (not stored as Ensemble data) | Not touched; see the disclosure section |
| Logs | `$XDG_STATE_HOME/ensemble/logs/` (default) or `ENSEMBLE_LOG_DIR` | Structured JSONL operational events. Metadata and IDs by default; free text only when `ENSEMBLE_LOG_CONTENT=1` is explicitly set. Credentials and common token shapes are redacted. | **7 days**, at most **5 rotated files per role/prefix**, and **10 MiB per file** by default | No | `data delete --logs` (all workspaces) or remove the files manually |
| Settings and UI state | OpenCode plugin storage (`v2/meta`) | Budget defaults, native-first mode, pane/rail history, active selection | Until changed or reset | No | Reset only (`ensemble.reset`) |

Notes:

- **Terminal Work retention is 24 hours.** This bounds replay/idempotency data;
  it is not a conversation archive. Conversation rows are kept until you delete
  them.
- **Agent-global memories are not workspace data.** A memory created without a
  workspace (for example from the agent wizard) travels with the agent across
  workspaces, so a per-workspace export or delete leaves it alone. Manage it from
  the agent's memory settings.
- **Reset is broader than a data delete.** `ensemble.reset` (confirmation
  `RESET`) removes every Ensemble row, workspace config, attachment directory,
  and bound native session for every workspace. `data delete` is scoped to one
  workspace and keeps the team usable.

## Export

Export is served by the existing `ensemble.v2` RPC through the `data.export`
action. The operator entry point is a doctor-style CLI over the same service
descriptor. Like `npm run doctor`, it runs from an Ensemble source checkout;
installed-package integrations call the RPC actions directly.

```sh
# Write the export to a file (recommended: exports contain conversation text)
npm run data -- export /path/to/project --out ensemble-export.json

# Or stream JSON to stdout
npm run data -- --help
npm run data -- export /path/to/project
```

The command resolves the OpenCode service exactly like `doctor`: the default
descriptor is `$XDG_STATE_HOME/opencode/service.json` (or
`~/.local/state/opencode/service.json`), `--service-file` overrides it,
`--server` overrides the URL, and `OPENCODE_PASSWORD` overrides the descriptor
password. Credentials are never printed. A newly created export file is written
with mode `0600`.

Installed integrations can call the same action through the service RPC:
`POST /api/rpc/ensemble.v2/invoke?location%5Bdirectory%5D=<directory>` with
`{"input":{"directory":"<directory>","action":"data.export","payload":{}}}`.
Use the service's configured credentials; never paste them into shell history.

### Export format

`format: "ensemble.data-export"`, `formatVersion: 1`. The document is JSON:

```json
{
  "format": "ensemble.data-export",
  "formatVersion": 1,
  "generatedAt": "2026-11-16T12:00:00.000Z",
  "workspace": {
    "id": "…",
    "name": "site",
    "leaderID": "…",
    "synthesis": true,
    "paused": false,
    "members": [{ "id": "…", "name": "Nova", "title": "Engineer", "role": "…", "archived": false }]
  },
  "conversations": [
    {
      "channel": "…",
      "kind": "group",
      "messages": [
        {
          "id": "…",
          "seq": 1,
          "author": "user",
          "kind": "text",
          "text": "Hello team",
          "createdAt": 1763294400000,
          "attachments": [{ "name": "diagram.png", "mime": "image/png", "size": 42, "kind": "image" }]
        }
      ]
    }
  ],
  "work": [
    {
      "id": "…",
      "title": "…",
      "instruction": "…",
      "mode": "research",
      "state": "replied",
      "outcome": "succeeded",
      "interrupted": false,
      "createdAt": 1763294400000
    }
  ],
  "memories": [
    {
      "id": "…",
      "scope": "workspace",
      "text": "Ship on Fridays",
      "origin": "manual",
      "source": "user",
      "createdAt": 1763294400000,
      "updatedAt": 1763294400000,
      "history": [{ "at": 1763294400000, "action": "created", "by": "user" }]
    }
  ],
  "excluded": [
    "bindings",
    "host-session-identifiers",
    "workspace-directory-paths",
    "model-configuration",
    "settings",
    "operational-logs",
    "agent-global-memories"
  ],
  "logs": { "included": false, "retentionDays": 7, "maxFiles": 5, "maxBytes": 10485760 },
  "counts": { "conversations": 1, "messages": 1, "work": 1, "memories": 1, "attachments": 1 }
}
```

`work[].failure` carries the structured cause only (`kind`, optional `reason
code`), not free-form error text. `conversations[].kind` is `group` or `direct`;
direct conversations also carry `agentID` and `agentName`. Attachment entries
carry display metadata only. The export never includes:

- native session ids or binding rows;
- workspace directories, agent home directories, or other absolute paths;
- model provider/model configuration or credentials;
- Ensemble settings and UI state;
- operational logs (they are local JSONL and can be deleted with `--logs`);
- agent-global memories or other workspaces' data.

## Delete

Delete is the `data.delete` action, exposed by the same CLI:

```sh
# Delete this workspace's Ensemble data. DELETE is required.
npm run data -- delete /path/to/project --confirm DELETE

# Also delete the local Ensemble log files (all workspaces)
npm run data -- delete /path/to/project --confirm DELETE --logs

# Also ask the host to remove the bound native sessions
npm run data -- delete /path/to/project --confirm DELETE --delete-native-sessions
```

Delete stops active init runs and Work for the workspace, interrupts live runs,
and then removes, for this workspace only:

- group and direct conversations with their messages;
- Work rows, dispatch groups, init jobs, and native-subagent rows;
- workspace-attributed memories;
- approvals, and queued direct sends;
- workspace and direct native-session bindings;
- attachment bytes under `<workspace>/.ensemble/attachments/`.

It keeps the workspace row, the roster, and `.ensemble/config.json`, so the
workspace is immediately usable: the next turn starts a fresh native session in
the same team. The response reports counts and what was retained. After the
command, `data.export` still returns the workspace with empty conversations,
Work, and memories, and `doctor` sees the same workspace and roster.

Delete does **not** edit `AGENTS.md`, `.ensemble/config.json`, or the project's
own files. It does not erase a host-owned native session unless you pass
`--delete-native-sessions`; removing the binding is what prevents Ensemble from
re-ingesting the deleted transcript on the next reconcile.

`ensemble.reset` remains the separate, all-or-nothing reset. `data delete` is
the scoped action; see the reset confirmation and the TUI settings for the
broader operation.

## `AGENTS.md` roster disclosure (v7)

### What is written

The v7 team contract includes a generated **Team roster** table:

```markdown
## Team roster

Every active workspace member. Title and role are stored values.

| Member | Title | Role |
|---|---|---|
| **Nova** (leader) | Engineer | Builds the product |
| Sage | Reviewer | Reviews changes |
```

The table is written into the workspace's `AGENTS.md` between
`<!-- ensemble:start v7 -->` and `<!-- ensemble:end -->`. The source is
`ensembleBlock()` / `teamRosterTable()` in `src/v2/init-block.ts`.

### When it is written

- `workspace.init` (the `I` key, `:init`, or `/init`) writes the block
  deterministically after the native init run.
- Workspace config reconciliation refreshes the block when the contract
  version, the roster, or the generated text differs (`reconcileWorkspaceInstructions`).
- The per-session identity prompt stays generic and does not carry the table.

### The risk

`AGENTS.md` is a project file. If the repository is public or shared, the
generated block publishes every active member's **name, title, and role**. Titles
and roles can reveal internal structure, project names, seniority, or other
information you did not intend to publish. Names are already used for routing,
so the table's extra disclosure is the title and role column.

### Guidance

- Review `AGENTS.md` before the first commit that includes the block.
- Keep `title` and `role` non-sensitive, or leave them empty, before running
  workspace init or before the first config reconciliation. Empty values render
  as empty cells; names remain because routing needs them.
- Treat the whole generated block as public repository content. Do not put
  secrets, credentials, private paths, or conversation text in an agent's title
  or role.
- A release note, PR, or archive action does not remove the block; it is project
  content.

### Opt-out

There is no config switch in this release. The supported manual opt-out is:

1. Remove the entire generated block, from `<!-- ensemble:start v7 -->` through
   `<!-- ensemble:end -->`, from `AGENTS.md`.
2. Remove `.ensemble/init.json` (local and gitignored) so Ensemble no longer
   treats the directory as initialized. Reconciliation leaves an uninitialized
   directory alone.
3. Do not run workspace init (`I`, `:init`, `/init`) again for that workspace;
   init writes the block back.

Deleting only the roster table or only the block marker is not stable:
reconciliation compares the generated block with the file and rewrites it. A
future release may add a narrow opt-out; this page will document it if it does.
