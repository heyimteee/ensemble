# Permission-model review

- **Status:** Accepted for the 0.1 release candidate
- **Date:** 2026-11-16
- **Ticket:** #271 (parent spec #268)
- **Companions:** [threat model](threat-model.md), [accepted risks](accepted-risks.md)

This review tests the product security boundaries in `SECURITY.md` against the
code. It covers approvals, outside-roster contact, external directories,
self-approval, and native permission preservation. Findings are evidence-based;
the one fix in #271 is called out separately.

## Invariants

| ID | Invariant | Verdict |
|---|---|---|
| I1 | Only the user can approve or reject an action. | Holds; no agent-facing resolve path |
| I2 | Assigned skills and leader status do not grant permissions. | Holds; the Skillbox only writes `skill` rules |
| I3 | Contact outside the workspace roster needs user consent. | Holds; `outside_roster` approval before contact |
| I4 | Cross-project knowledge and transcript disclosure need user consent. | Holds; `cross_project`/`promote_memory` approvals |
| I5 | Ensemble preserves OpenCode's native permission handling. | Holds; event-driven mirror, no auto-reply, `once`/`reject` only |
| I6 | A tool cannot act as another session, workspace, or agent. | Holds; caller identity is the host-provided session binding |

## Review matrix

### Approvals

| Check | Result | Evidence |
|---|---|---|
| Agents cannot resolve an approval | Pass | The native surface has `task_status`, `review`, `dispatch`, `ask_person`, `remember`, `share`; the legacy surface adds roster reads, `send_message`, `handoff`, `delegate`. None resolves an approval (`tool-registrar.ts`). The only `approval.resolve` caller is the TUI (`src/v2/tui/app.tsx`). |
| No automatic approval branch | Pass | No code path sets an approval to `approved` except a user decision: the TUI resolve or a host `permission.replied` event for a native mirror (`service.ts` `handlePermissionEvent`). A grep for `approve: true` and `status = "approved"` finds no non-test occurrence; the only approved transitions are those two user-driven paths. |
| Every resolution is recorded | Pass | `resolveApproval` writes status, `resolvedAt`, and `resolution` before applying effects; a conflicting second decision fails with `already_resolved`. |
| Stale approvals cannot restart dead work | Pass | Pending approvals tied to a replied/absent subtask resolve `rejected`; cancellation and workspace deletion settle linked approvals (`service.ts` `settleLinkedApprovals`, `cancelSubtasks`). |
| Native mirrors are not settled by Ensemble's terminal paths | Pass | Terminal settlement excludes `native`; only the host event or an explicit user decision settles them (`settleLinkedApprovals` callers pass a `native` exclusion). |
| Approval effects are idempotent | Pass | Work keys and correlation ids dedupe approved turns and hops (`service.ts` `findWorkByKey`, handoff idempotency). |

### Outside-roster contact

| Check | Result | Evidence |
|---|---|---|
| Group mention of a non-member needs approval | Pass | One `outside_roster` approval per recipient; the approved turn runs once through the queue (`service.ts` `toolSendMessage`). |
| Duplicate contact in one turn does not duplicate the approval | Pass | The native turn contact ledger records recipient ids; `anchorAlreadyContacted` suppresses a second row (`service.ts` `recordNativeContact`, `anchorAlreadyContacted`). |
| A direct message to a non-member needs approval | Pass | `outside_roster` with the message payload; the approval sends it once (`service.ts` `toolSendMessage`, `resolveApproval`). |
| Delegate/handoff to a non-member needs approval | Pass | Both create `outside_roster` approvals and revalidate budgets at resolution (`service.ts` `toolDelegate`, `toolHandoff`). |
| A user group post naming an outside agent fails loudly instead of silently routing | Pass | User messages do not use the agent approval path; the refusal is visible and no leader fallback runs (`service.ts` `sendMessage`; `docs/implementation.md` "Outside-roster rule"). |
| An archived agent cannot be contacted | Pass | Send/handoff/delegate refuse archived recipients. |

### External directories

| Check | Result | Evidence |
|---|---|---|
| A workspace directory is an existing canonical directory | Pass | `paths.ts` `canonicalDirectory` (`statSync`, `realpathSync`). |
| `@file` references stay inside the workspace | Pass | `paths.ts` `workspaceFileReferences` canonicalizes the target and rejects targets outside the canonical root. |
| Handoff files stay inside `.ensemble/handoffs/` | **Fixed in #271** | Lexical check plus canonical root/target containment in `service.ts` `toolHandoff`; regression test in `handoff-service.test.ts`. A symlink under `handoffs/` previously read an outside file. |
| Attachments are bounded and stored under `.ensemble/attachments/` | Pass | 10 MB per file, 8 files/25 MB per message, 250 MB per conversation; `0600` files; safe display/file names (`attachments.ts`). |
| Attachment source paths are user-selected, not agent-selected | Pass | Only the TUI composer adds attachments; no agent tool exposes `attachment.add`. |
| Agent home directories are explicit, not arbitrary | Pass | Written at agent creation (`service.ts` `createAgent`); default `~/.ensemble/agents/<id>`; the native session is created at that location. |
| TUI external commands cannot write or hang | Pass | `git status` is read-only with a 1.5 s timeout and ignored stdin; `fd` has a timeout and output cap (`src/v2/tui/git.ts`, `src/v2/tui/file-index.ts`). |

**Residual risk.** Project control files (`AGENTS.md`, `.gitignore`, the
`.ensemble/` directory) are opened by path, so a repository that ships them as
symlinks can redirect Ensemble's automatic writes outside the workspace. This
requires opening a hostile repository as a workspace; it is recorded as
`AR-271-03`, with a follow-up containment recommendation.

### Self-approval

| Check | Result | Evidence |
|---|---|---|
| An agent cannot approve its own `ask_person` | Pass | No tool resolves approvals; `ask_person` only creates the row (`service.ts` `toolAsk`). |
| An agent cannot approve its own native permission request | Pass | The host blocks the live session; Ensemble mirrors the request. Resolving replies `once`/`reject`, never `always` (`service.ts` `resolveApproval`, `replyNativePermission`). |
| An agent cannot approve its own outside-roster contact | Pass | Only the user inbox can resolve `outside_roster`. |
| An agent cannot approve a global memory or share | Pass | `remember`/`share` only create rows; promotion happens in `resolveApproval`. |
| Leader status does not grant approval authority | Pass | `dispatch` and review delegations are budget- and role-checked; they still cannot resolve an approval. |
| An agent cannot resolve another agent's approval | Pass | Same as above; the tool surface has no resolve action and no approval id argument. |

**Residual risk.** The RPC handler `approval.resolve` accepts an approval id from
the local TUI client and does not verify a workspace identity. The inbox filters
by the active workspace, so a normal user cannot see another workspace's rows,
but a same-user local client could call the RPC with an id it obtained from the
state snapshot. This is accepted under the local-client trust model
(`AR-271-02`); it becomes a real finding if the RPC is exposed to a different
principal or over a network transport.

### Native permission preservation

| Check | Result | Evidence |
|---|---|---|
| Ensemble does not answer native permission requests itself | Pass | No `permission.reply` call outside `replyNativePermission`, which is called only from `resolveApproval` and only with the user's decision. `settleNativeForSession` marks rows rejected without replying to the host. |
| The mirror is event-driven, not polled | Pass | `permission.asked`/`permission.replied` are the only inputs; a restart cannot resurrect an answered request (`service.ts` `handlePermissionEvent`). |
| A native approval reply uses least privilege | Pass | `once` on approve, `reject` on deny; no `always` (`service.ts` `resolveApproval` comment and call). |
| Ensemble adds no allow rule for shell, edit, network, or other non-skill actions | Pass | `execution.ts` `skillPermissions` emits only `action: "skill"` rules. |
| Skill grants are one-run and restored | Pass | `task.skillGrants` are added before the prompt and the baseline is restored in the `finally` path (`service.ts` managed run / native turn). ADR 0001 is the authority. |
| Ensemble does not bypass native skill checks | Pass | No prompt `skills` attachment, no experimental activation; ADR 0001. |
| The host's own retry policy is respected | Pass | Ensemble disables host auto-retry only for provider availability failures (`service.ts` `installRetryHook`); other failures keep the host policy. |

**Known host-API limit.** The session permission array is written as the
Skillbox baseline; Ensemble does not merge unrelated session rules that another
actor may have added during a run. The rules Ensemble writes are all `skill`
rules, so this cannot widen shell/edit/network authority, but a manual session
permission edit could be replaced by a skill-baseline restore.

## Findings

| ID | Finding | Severity | Action |
|---|---|---|---|
| P1 | `toolHandoff` accepted a symlink under `.ensemble/handoffs/` and read the target outside the workspace. The preview was then queued as a handoff, so arbitrary local file content could enter the model context. | Moderate (legacy/migration surface, agent-initiated) | **Fixed**: canonical root and target containment; regression test. |
| P2 | Approval resolve is filtered by workspace in the TUI but not by the server. | Low | Accepted, `AR-271-02`; revisit if the RPC becomes remote/multi-principal. |
| P3 | Repository-controlled symlinks can redirect automatic project-file writes. | Moderate | Accepted, `AR-271-03`; follow-up containment hardening. |
| P4 | `share` scope `private_transcript` is persisted as a global memory after approval, although the title reads as a one-time disclosure. | Low | Accepted for now; #272 must make the consent copy state the effect or make it transient. |
| P5 | An agent can open unlimited `ask_person` rows, which can flood the approval inbox. | Low | Accepted; the inbox is user-paced and rows are cheap. Consider a per-turn cap if it is abused. |
| P6 | A `skillbox` list can contain `*`, which would allow every skill. Only the local TUI client can set it; it is a user choice, not an escalation. | Informational | No change; documented as a local-client trust property. |

## How this was checked

- Read `src/v2/tool-registrar.ts`, `src/v2/service.ts` (`toolHandoff`,
  `toolSendMessage`, `toolDelegate`, `toolAsk`, `toolRemember`, `toolShare`,
  `resolveApproval`, `handlePermissionEvent`, `settleLinkedApprovals`),
  `src/v2/execution.ts` (`skillPermissions`), `src/v2/paths.ts`, and the TUI
  call site for `approval.resolve`.
- Grepped non-test sources for automatic approval (`status = "approved"`,
  `approve: true`, `permission.reply`) and for a listener/socket; none exist.
- Wrote and ran the handoff symlink regression test (red before the fix, green
  after).
- Ran `npm run verify` and `npm audit --omit=dev` (see the verification record).

## What would invalidate this review

- Exposing the plugin RPC to a remote transport or a different OS user.
- Adding a tool that resolves approvals, auto-approves, or replies to native
  permissions.
- Adding a non-`skill` permission rule to `skillPermissions`.
- Storing credentials, conversation content, or attachment bytes in logs or in
  exported diagnostics.
- Removing the canonical containment checks in `paths.ts` or `toolHandoff`.
