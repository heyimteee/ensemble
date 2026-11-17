# Ensemble threat model

- **Status:** Accepted for the 0.1 release candidate
- **Date:** 2026-11-16
- **Ticket:** #271 (parent spec #268)
- **Owner:** maintainer
- **Companion records:** [permission-model review](permission-model-review.md), [accepted risks](accepted-risks.md), [verification](../verification/2026-11-16-ticket-271.md)
- **Review trigger:** any change to approvals, tool registration, storage keys, workspace file writes, skill permissions, or the release distribution channel

This model describes the security properties of the Ensemble OpenCode plugin as
implemented in this repository. It is evidence-based: every claim points at the
code that enforces it. It is not a claim that OpenCode, the model providers, or
the user's own project are secure.

## System summary

Ensemble is a plugin loaded by an OpenCode host. It runs in the host process and
has the host's filesystem access. It provides:

- a shared, reference-counted service per host realm (`src/v2/shared-service.ts`),
- durable team state in the host plugin storage (`src/v2/store.ts`),
- workspace files under `<workspace>/.ensemble/` and an `AGENTS.md` block
  (`src/v2/workspace-config.ts`, `src/v2/init-block.ts`),
- native OpenCode sessions for agents, driven through the host session APIs
  (`src/v2/service.ts`),
- a native tool surface of six tools and a six-tool legacy migration surface
  (five tools are shared; `dispatch` is native-only)
  (`src/v2/tool-registrar.ts`),
- a TUI that reads and mutates state over the host plugin RPC channel
  (`src/v2/rpc.ts`, `src/v2/tui/app.tsx`).

Ensemble opens no socket, HTTP listener, or remote endpoint. It makes no
outbound network requests in `src/v2/`. Provider credentials belong to OpenCode;
Ensemble stores and reads model identifiers, never credentials.

## Assets

| ID | Asset | Where it lives | Why it matters |
|---|---|---|---|
| A1 | Conversation text (group and direct messages) | Host plugin storage `v2/message/<channel>/<seq>` | May contain private project content |
| A2 | Work instructions, results, handoff briefs | Plugin storage `v2/subtask/<id>`; handoff files under `.ensemble/handoffs/` | Agent-authored plans and code snippets |
| A3 | Memories (project, workspace, global) | Plugin storage; `v2/memory/<id>` | Durable knowledge, may cross projects when global |
| A4 | Approvals and their resolutions | Plugin storage `v2/approval/<id>` | Consent record; a forged approval bypasses the user |
| A5 | Roster name, title, role | Plugin storage; `AGENTS.md` block; `.ensemble/config.json` | Project-visible personal/team data |
| A6 | Attachment bytes | `<workspace>/.ensemble/attachments/` and agent-home attachments | Arbitrary user file content |
| A7 | Native session identity and directory | Plugin storage bindings | Grants access to the agent's native session |
| A8 | Host permissions and skill permissions | Host-owned, mirrored by Ensemble | The agent's authority boundary |
| A9 | Local logs | `$XDG_STATE_HOME/ensemble/logs` (default `~/.local/state/ensemble/logs`) | Operational metadata, no message text by default |

## Actors and trust boundaries

| Actor | Trust | Can do |
|---|---|---|
| User | Trusted; sole authorizer | Everything the TUI and host allow, including approvals |
| Agent (model) | Untrusted output, trusted authority only through host tools and permissions | Call registered tools; read/write per host permissions; cannot approve |
| Native OpenCode host | Trusted platform | Owns sessions, permissions, credentials, storage, and the RPC channel |
| Other local plugins/processes | Same OS user, separate trust domain | Can read files the OS user can read; Ensemble does not defend against a same-user attacker |
| Repository content (files, skills, prompts, tool output) | Untrusted input | Can attempt prompt injection; cannot mint approvals or change permissions |
| npm registry / dependency tree | Supply chain | Can introduce code into the installed package and the dev tree |

The main boundary is **user versus agent**. Ensemble's job is to keep agent
output from becoming agent authority without an explicit user decision, and to
keep its own writes inside the paths it claims to own. The local OS user is the
outer boundary: a process that already runs as that user can read the same data
directly, so file permissions are not a defense against a hostile local
co-tenant.

## Surface 1: storage

**What is stored.** Team state is a set of host plugin-storage entries:
`v2/agent/<id>`, `v2/workspace/<id>`, `v2/message/<channel>/<seq>`,
`v2/subtask/<id>`, `v2/dispatchgroup/<id>`, `v2/approval/<id>`,
`v2/memory/<id>`, `v2/binding/<id>`, `v2/dmqueue/<id>`, `v2/init/<id>`,
`v2/native-subagent/<id>`, `v2/dm/<workspace>/` rows, and `v2/meta`
(`src/v2/store.ts`). The pre-v2 `ensemble.state` blob is read on startup for an
agent-only migration and removed by reset (`service.ts` `migrateV1`,
`resetEnsemble`). Storage is the host's plugin
namespace; Ensemble does not add its own encryption or access control.

**Project files.** `<workspace>/.ensemble/config.json` holds the workspace name,
leader, members, synthesis flag, paused flag, and id
(`workspace-config.ts` `writeWorkspaceConfig`). `.ensemble/init.json` holds the
contract version and install time. `.ensemble/handoffs/` holds agent-authored
handoff files. Attachments live under `.ensemble/attachments/<conversation>/`
with `0600` files (`attachments.ts` `storeAttachment`). Ensemble appends
`.ensemble/` to the workspace `.gitignore` on first use
(`workspace-config.ts` `ensureEnsembleDirectory`), so these files are not
committed by default. `AGENTS.md` is a project file and may be committed; its
Ensemble block contains the roster table (name, title, role) and the contract
text, which is a deliberate disclosure owned by #272.

**Agent-home files.** An agent without a workspace directory gets a native
session in `~/.ensemble/agents/<id>` or its configured `homeDirectory`
(`service.ts` `createHomeBinding`). Direct conversations in that home are
outside any project directory; they are subject to the same host permissions.

**Threats and controls.**

| Threat | Control | Evidence |
|---|---|---|
| A forged or corrupted foreign state copy overwrites newer state | One shared service per realm, version-guarded writes, targeted entity saves | `shared-service.ts`, `store.ts` save paths |
| A deleted workspace leaves message or attachment data behind | `pruneWorkspace` removes entity rows; `cleanupWorkspaceAttachments` removes attachment directories | `store.ts` `pruneWorkspace`, `service.ts` `deleteWorkspace` |
| An agent reads another workspace's durable rows directly | Tools resolve the caller's session binding and use only that workspace; cross-workspace posts and shares need approvals | `service.ts` `requireToolSession`, `toolSendMessage`, `toolShare` |
| Storage disclosure by another local process | Host storage location and OS permissions are host-owned; the local OS user is the outer boundary | Not defensible inside the plugin |
| Reset leaves data behind | `resetEnsemble` removes `v2/` keys, `ensemble.state`, workspace config, init metadata, attachment directories, and optionally handoff files; it requires the literal `RESET` confirmation | `service.ts` `resetEnsemble` |

**Retention decisions** (implementation of export/delete is #272; see
"Data handling" below): team state and attachments persist until the user
deletes the workspace or resets Ensemble; memories persist until deleted; logs
expire after 7 days or 5 files per sink; approvals persist as consent records
until their workspace is deleted or Ensemble is reset. `AGENTS.md` is not
deleted by workspace deletion, because the project owns the file and the block
may be intentional; #272 must document and offer that removal.

## Surface 2: filesystem and shell

Ensemble does not provide its own shell or file-read/write tool to agents.
Agents use the host's native tools under the host's own permission prompts,
within the session's `location.directory` (the workspace or agent home). The
plugin's own filesystem operations are limited to:

- state files under `<workspace>/.ensemble/` and `AGENTS.md`
  (`workspace-config.ts`, `service.ts` init job),
- attachment copies under `.ensemble/attachments/` (`attachments.ts`),
- log files under the state directory (`logging.ts`),
- two read-only external commands in the TUI: `git -C <directory> status
  --porcelain=v1 --branch` with a 1.5 s timeout and ignored stdin
  (`src/v2/tui/git.ts`), and `fd` with a bounded timeout and output buffer
  (`src/v2/tui/file-index.ts`).

**Path containment controls.**

- Workspace directories are canonicalized with `realpathSync`; a path must be
  an existing directory (`paths.ts` `canonicalDirectory`).
- `@file` references resolve against the canonical workspace root and are
  rejected unless the canonical target stays under it (`paths.ts`
  `workspaceFileReferences`).
- Handoff files must live under `.ensemble/handoffs/`; both the root and the
  file are canonicalized before the containment check, so a symlink cannot
  redirect the read outside the workspace (ticket #271 fix; test
  "a handoff path cannot escape .ensemble/handoffs/ through a symlink").
- The init job writes only `AGENTS.md` and `.ensemble/init.json`, keeps the
  previous `AGENTS.md` and restores it on failure, cancellation, or restart
  (`service.ts` init job).

**Residual risk: repository-controlled symlinks.** A hostile repository can
contain `AGENTS.md`, `.gitignore`, or `.ensemble/` as a symlink pointing outside
the workspace. Ensemble's project-file writers follow the symlink, so an
automatic reconciliation or init could write the Ensemble block or config
outside the workspace. This requires the user to open and add a hostile
repository as a workspace, and a hostile repository can already run arbitrary
code through its own build scripts under the host's permission prompts. It is
recorded as an accepted risk (`AR-271-03`) with a follow-up hardening
recommendation rather than fixed by a late, broad change in this ticket.

**User-selected attachment paths.** The composer accepts an absolute file path
or a clipboard image and copies it into `.ensemble/attachments/`
(`attachments.ts` `resolveAttachmentPath`, `storeAttachment`). This is an
explicit user action on their own machine, not an agent-driven read; it is
documented behavior, not a vulnerability.

## Surface 3: tools

The native tool surface is `ensemble_task_status`, `ensemble_review`,
`ensemble_dispatch`, `ensemble_ask_person`, `ensemble_remember`, and
`ensemble_share`. The legacy surface adds `ensemble_workspace_info`,
`ensemble_list_workspaces`, `ensemble_list_agents`, `ensemble_send_message`,
`ensemble_handoff`, and `ensemble_delegate` (`tool-registrar.ts`). All tools are
`codemode: false`, have closed JSON schemas (`additionalProperties: false`), and
resolve the caller from the host-provided `context.sessionID`; a tool call
cannot name a different session or workspace as its identity (`service.ts`
`requireToolSession`).

**What tools can and cannot do.**

- No tool approves anything. `ask_person`, `remember` (global), and `share`
  create pending approvals; they never resolve them.
- `review` can only decide items in a batch assigned to the calling reviewer,
  and `delegate` inside a review stays leader-only (`service.ts` `toolReview`,
  `applyReviewDecision`).
- `dispatch` is leader-only and validated against group, command, and depth
  budgets before any work is created (`service.ts` dispatch preflight).
- `remember` with `scope: "global"` stores the memory at project scope and
  opens a `promote_memory` approval; only the resolution promotes it
  (`service.ts` `toolRemember`, `resolveApproval`).
- `share` opens a `cross_project` approval; only the resolution creates
  shared knowledge (`service.ts` `toolShare`).

**Threat: prompt injection drives a destructive or disclosure tool.** The
blast radius is the tools plus the host's native permissions. The tools cannot
escalate budgets, approve, or read another workspace. A hostile repository can
still influence what the model asks for; the user's native permission prompts
and the approval inbox remain the authority. Tool results are the only path for
the model to act, and every result is derived from the caller's binding.

## Surface 4: cross-workspace access

All locations in one host realm share one service (`shared-service.ts`), so the
service can see every workspace in the realm. Two different access paths exist:

- **Agent tools** are session-bound. A workspace post to a different workspace
  is refused with "Cross-workspace posts require ensemble_share approval"
  (`service.ts` `toolSendMessage`). A direct message or delegate/handoff to a
  non-member creates an `outside_roster` approval instead of contacting the
  agent (`service.ts` `toolSendMessage`, `toolDelegate`, `toolHandoff`). A
  global memory promotion needs `promote_memory`; a cross-project disclosure
  needs `cross_project`.
- **TUI RPC** is ID-based. The client sees all workspaces; the approval inbox
  filters to the active workspace (`src/v2/tui/app.tsx` `approvalWorkspaceID`,
  `approvalsForWorkspace`). The server does not re-check the caller's workspace
  when resolving an approval by id, because the RPC channel is the local host's
  plugin channel and does not carry a per-workspace identity. This is a
  local-client trust assumption, recorded as `AR-271-02`; it becomes a real
  finding only if the RPC is exposed to a different security principal or over
  a network transport (neither is true here: no listener, no socket).

**Realm-level isolation is not a multi-tenant boundary.** Ensemble assumes one
OS user per host realm. Running two untrusted users against the same host
storage is outside the model.

## Surface 5: skills

Skill execution is native and authoritative (ADR 0001). Ensemble stores no
skill bodies, implements no loader, and never uses prompt `skills` attachments
or the experimental activation endpoint. The Skillbox is enforced by writing a
session permission ruleset: `deny skill *` plus one `allow` per assigned skill
(`execution.ts` `skillPermissions`). The ruleset contains only `skill` actions,
so it cannot grant shell, edit, or network authority.

A General skill gets a one-run leader grant: `task.skillGrants` are added to the
session ruleset before the prompt, and the Skillbox baseline is restored after
the turn (`service.ts` managed run and native turn paths). The grant is not
persisted to the agent and is not carried to a delegatee.

Residual risk: the session ruleset is the host's per-session permission array.
Ensemble writes only the skill entries it owns; it does not read or merge
unrelated session rules that another actor may have added. In a host realm
where a user manually edits session permissions during a run, that edit can be
replaced by the skill-baseline update. This is a host-API integration limit, not
a privilege escalation: the replaced rules are skill rules only.

## Surface 6: approvals

Approvals are the user-consent mechanism. The server-side model is:

- Pending kinds: `ask_person`, `outside_roster`, `promote_memory`,
  `cross_project`, `interrupted`, and the `native` mirror (`types.ts`
  `ApprovalKind`).
- Only the TUI calls `approval.resolve` over RPC (`src/v2/tui/app.tsx`). No
  registered tool exposes a resolve action, so an agent cannot approve its own
  request, another agent's request, or a native permission.
- There is no automatic-approval branch: no code path sets an approval to
  `approved` except a user decision — the TUI's `approval.resolve` or the host
  `permission.replied` event for a native mirror (`service.ts`
  `handlePermissionEvent`).
- Resolving a native mirror replies `once` on approve and `reject` on deny;
  Ensemble never sends `always`, so a user approval does not persist into the
  host's permission configuration (`service.ts` `resolveApproval`,
  `replyNativePermission`).
- Stale approvals are settled `rejected` when their subtask is no longer
  waiting, when the workspace is deleted, or when the linked work is cancelled
  (`service.ts` `settleLinkedApprovals`, `cancelSubtasks`). Native mirrors are
  excluded from terminal settlement because the host request may still be live;
  they resolve only from the host event or an explicit user decision.
- Resolution is idempotent for the same decision and refuses a conflicting
  second decision (`service.ts` `resolveApproval`).

Residual risks: the approval inbox is a UI filter, not a server-side workspace
check (`AR-271-02`); and the `resolution` field is user-entered text that is
appended to the task instruction and stored in the approval row, so users must
not paste secrets into an answer. Both are documented in the permission review.

## Surface 7: model fallback

A run uses the agent's main model and ordered backup models. Before each
fallback it switches the model, clears the live stream, writes a visible system
message, and logs the switch (`service.ts` managed run loop). The loop stops
without switching when:

- the failure is not a provider availability failure
  (`execution.ts` `availabilityFailure`), or
- any tool call has happened since the attempt started
  (`execution.ts` `anyToolCall`), or
- the last backup model has been tried.

The host's own retry hook is also disabled for availability failures, so the
host does not blindly retry either (`service.ts` `installRetryHook`). A failed
run after a tool call is parked or failed with "A tool outcome is uncertain",
never replayed automatically. This satisfies the product requirement that model
fallback must not repeat actions with an uncertain outcome.

## Surface 8: logs

Structured logs are local and content-minimized:

- Default location `$ENSEMBLE_LOG_DIR` or
  `$XDG_STATE_HOME/ensemble/logs` (default `~/.local/state/ensemble/logs`);
  directory `0700`, files `0600` (`logging.ts`).
- Message rows log `chars`, ids, kind, and author, never text
  (`log-events.ts` `messageFields`).
- Dispatch rows log ids, counts, limits, and reason codes, never titles,
  instructions, handoff paths, or file content (`log-events.ts`).
- Task titles are conversation content: native turn titles are omitted from
  lifecycle rows (`log-events.ts`), and the failure sink stores metadata only.
- Failure records include the last messages as metadata; message text and task
  instruction/constraints/expected are included only when the user sets
  `ENSEMBLE_LOG_CONTENT=1` (`failure-record.ts` `messageMetadata`,
  `buildFailureRecord`).
- Credential-shaped strings are redacted (`logging.ts` `redactText`,
  `redactValue`): bearer/basic headers, URL userinfo, `sk-` keys, GitHub tokens,
  and key/value secrets.
- Rotation: 10 MB per file, 5 files per sink, 7-day retention by default
  (`logging.ts` `rotateIfNeeded`, `prune`). Logging can be disabled with
  `ENSEMBLE_LOG=0`; the in-memory ring remains available for diagnostics.
- `service.location` records the workspace directory path once per service
  instance. That is local operational context, not message content; it is a
  private path in a local log file, not in any published artifact.

Residual risk: redaction is pattern-based and cannot catch every secret form.
Users who enable `ENSEMBLE_LOG_CONTENT=1` opt into conversation text in a local
file. This is documented in `SECURITY.md`.

## Data handling

The security requirements for retention, export, and delete are decided here;
the implementation and user-facing policy are owned by #272. Ensemble must meet
these requirements:

| Data class | Retention | Export | Delete |
|---|---|---|---|
| Conversations, Work, approvals, memories, bindings | Until workspace delete or Ensemble reset; no time-based expiry | Included, in the #272 format | Covered by workspace delete/reset and the #272 delete action |
| Attachments | Until message/conversation/workspace delete or reset | Included for the exported conversation | Removed with the conversation/workspace |
| Logs | 7 days / 5 files / 10 MB per sink by default | Explicit local file copy; not part of the workspace export | Pruned automatically; `ENSEMBLE_LOG_DIR` can be removed by the user |
| `.ensemble/config.json`, `init.json` | Until workspace delete or reset | Workspace metadata in the export | Removed by workspace delete/reset |
| `.ensemble/handoffs/` | Until the user deletes the file or resets with handoff deletion | Not durable team state; user-managed files | Reset with the handoff-deletion option |
| `AGENTS.md` block | Project-owned; lasts as long as the file | #272 may include the block text in the export | #272 must offer block removal and document that workspace delete leaves the project file alone |

**Roster disclosure.** The v7 contract writes the team roster table (member
name, title, role) into the workspace `AGENTS.md` (`init-block.ts`
`teamRosterTable`). This is visible to everyone who can read the repository and
may be committed. #272 owns the guidance or opt-out. Until then, the security
guidance is: do not put secrets or sensitive personal data in an agent name,
title, or role, and review `AGENTS.md` before committing a workspace.

**No telemetry.** Ensemble makes no outbound network request in `src/v2/`, has
no analytics, crash-reporting, or update check, and ships no telemetry
dependency. All diagnostics are local logs and the `doctor`/`logs:summary`
commands.

## Findings summary

| ID | Surface | Severity | Status |
|---|---|---|---|
| F1 | Handoff path symlink read escape (legacy surface) | Moderate | **Fixed** in #271 with a regression test |
| F2 | Repository-controlled symlink can redirect Ensemble's automatic project-file writes | Moderate | Accepted, `AR-271-03`; follow-up hardening recommended |
| F3 | Approval resolve is UI-workspace-scoped, not server-scoped | Low | Accepted, `AR-271-02`; local-client trust |
| F4 | User-selected attachment paths may be outside the workspace | Low | Accepted behavior; explicit user action |
| F5 | `private_transcript` share is persisted as a global memory after approval | Low | Accepted for now; #272 must state the effect in the consent copy or make it transient |
| F6 | Pattern-based log redaction can miss unusual secret shapes | Low | Accepted; content logging is opt-in and local |
| D1 | 24 dev/peer dependency advisories (0 critical) | See `accepted-risks.md` | `AR-271-01` resolved by #296; `AR-271-04` accepted; `npm audit --omit=dev` is clean |

## Out of scope

- OpenCode's permission engine, session isolation, storage implementation, and
  credential handling. Report those through OpenCode's own security process.
- Model providers and prompt/response handling.
- MCP servers, host plugins, and other tools the user installs.
- The user's project code, build scripts, and repository content.
- npm registry compromise and the integrity of the publishing account; release
  provenance is #275.
- A hostile local OS user or a compromised machine.

## Review procedure

1. Read the surface sections and confirm each evidence reference still exists.
2. Run `npm audit --omit=dev` (must stay clean) and `npm audit` (document any
   new advisory in `accepted-risks.md`).
3. Run the permission-model review checklist in
   [permission-model-review.md](permission-model-review.md).
4. Re-run `npm run verify` and the handoff symlink regression test.
5. Update this file, the accepted-risk records, and the verification record in
   the same change that alters a control.
