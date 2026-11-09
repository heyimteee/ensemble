# ADR 0007: Apply agent behavior changes to the existing native session

- **Status:** Accepted
- **Date:** 2026-11-09
- **Tickets:** #189 in `heyimteee/ensemble`
- **Supersedes:** none
- **Related:** [ADR 0003](0003-single-service-and-safe-recovery.md), [runtime guide](../agents/opencode-tui-runtime.md), [implementation notes](../implementation.md#agents)

## Context

Saving a behavioral agent setting (role, main or backup model, or Skillbox)
bumps `Agent.version`. The workspace task path treated a version difference as
a reason to create a native session, so `ensureBinding` called
`createWorkspaceBinding`, appended the old session to `binding.history`, and
left the tool waiting on a brand-new conversation. A direct session that had
been moved into the workspace was especially exposed: the first rotation
retired `Clark · direct`, so it stopped receiving workspace work even though it
still held the user's context.

The version is a settings marker, not a session identity. Rotating the session
also made the change feel sudden: direct chat did not check the version, so it
kept working until the next task dispatch.

A second defect reused a pre-claim `Agent` snapshot. `runTask` captured the
agent, `ensureBinding` cleared `pendingSettings` on a fresh row, and a stale
`saveAgent(agent)` later wrote the flag back. The same write could overwrite a
concurrent settings save with older role, model, or Skillbox values.

## Decision

### 1. Binding identity is workspace/agent, not version

`ensureBinding` reuses an existing workspace/agent binding regardless of
`agentVersion`. It normalizes `kind` and `directory`, then applies the current
behavior to that native session. The version only says whether the settings
still need to be applied. `binding.history` is appended only when the bound
native session is gone.

### 2. The host already has the safe in-place surfaces

The apply step uses the same APIs the runtime already depends on:

- `session.instructions.entry.put({ sessionID, key: "ensemble.v2.identity" })`
  replaces the persona instruction.
- `session.switchModel({ sessionID, model })` sets the main
  `providerID`/`id`/`variant`, exactly as `runTask` does before a prompt.
- `session.update({ sessionID, permissions })` applies the Skillbox baseline
  through the same permission helper used at session creation and by one-run
  skill grants.

No host mutation, private API, or context merge is involved. Native context
cannot be merged; keeping it is the point.

### 3. Apply on the next task and the next direct message

Both `runTask`/`ensureBinding` and the DM path (`ensureChatSession`) call the
same refresh helper. After the calls, the binding records
`agentVersion = agent.version` and a new `updatedAt`; no history entry is
added. This covers a workspace binding and the `home` direct binding.

The identity-version cache is updated on a successful identity write so the
DM poll does not repeat it.

### 4. Missing-session fallback

A native session can still disappear outside Ensemble (user deletion,
workspace cleanup, profile loss). Before treating a binding as live, the
service asks `session.get({ sessionID })`. A not-found result falls through to
the existing creation path: create a session, save the binding with the old ID
appended to `history`, settle any native permission mirror for the old session,
and write the current identity. Contexts that do not expose `session.get`
cannot prove absence, so the binding is kept rather than rotating a
conversation on an unavailable API.

### 5. `pendingSettings` is notification, not ownership

`pendingSettings` means "the next message applies these settings". It is
cleared with a fresh store clone after the in-place apply, never from a run's
pre-claim snapshot. `runTask` no longer saves its captured `Agent` row; other
writers re-read or clone the current row. A concurrent settings save therefore
survives a run that started before it.

### 6. Audit and maintenance rebind

`agent.update` logs `agent.updated` with `{ agentID, version, changed }`.
`changed` is a list of field names only. Role text, skill names, and model
values are never logged.

`agent.rebindSession` is the explicit escape hatch when a user wants a
different session than the current binding: payload
`{ agentID, workspaceID?, sessionID }`, with omitted `workspaceID` meaning
`home`. The target must be the current session or a member of
`binding.history`; a foreign or stale id is rejected. Asking for the current
session is a no-op: no behavior apply, history mutation, or audit row. A
history target must still exist natively (`session.get`); if it is gone, the
action rejects with `invalid_session` before mutating anything. The action
rejects while the current session has an active run or is direct-busy. On
success it applies the current behavior to the target, prepends the previous
current session to `history` (removing the target from that list), sets
`agentVersion` and `updatedAt`, saves, and logs `agent.session.rebound` with
IDs only.

The one-run General-skill grant flow is unchanged: the baseline is applied
before the prompt, the grant extends it, and `finally` restores the baseline.

## Rejected alternatives

- **Keep rotating on every version bump.** Rejected: it retires a working
  conversation for a settings edit, loses the moved direct session, and leaves
  new tabs for every save.
- **Fork or merge native contexts.** Rejected: the host cannot merge context,
  and a fork would still split the conversation. In-place apply preserves it.
- **Apply only the persona instruction.** Rejected: the next prompt would
  still use the old model and Skillbox, which is the visible behavior the
  settings edit changed.
- **Update `agentVersion` without proving the session exists.** Rejected: a
  stale binding would pass the next prompt to a missing session.
- **Log the changed values.** Rejected: role text and skill/model choices are
  user content and do not belong in operational logs.
- **Automatically rebind or merge sessions.** Rejected: selecting an old
  context is a user decision. The rebind action keeps it explicit.
- **Treat `pendingSettings` as a lock held by the run.** Rejected: it turned a
  notification into a stale-write source and blocked concurrent edits.

## Consequences

### Accepted trade-offs

- Every reuse checks `session.get`. This is one host call on a task or DM
  refresh; it replaces the previous unconditional prompt into a possibly
  missing session.
- A context without `session.get` keeps a binding even if the session vanished;
  the next prompt fails visibly instead of silently rotating. The supported
  host exposes the call.
- Rebind does not merge native context. It restores one existing session and
  applies the current behavior to it.
- `agent.updated` records field names, not before/after values. Diagnosing a
  value change needs the settings surface or a user report.

### Follow-up rules

- Do not create a native session because `agentVersion` differs.
- Do not append `binding.history` on an in-place apply.
- Do not save a run's pre-claim `Agent` snapshot.
- Keep `agent.updated` and `agent.session.rebound` free of role, skill, model,
  and message content; IDs, versions, and field names only.
- Keep the one-run skill grant order: baseline, grant, baseline restore.
- Keep direct and workspace bindings separate, including the move-home path.

## Validation

- Service tests cover workspace and DM session reuse with `switchModel`,
  `session.update({ permissions })`, and identity assertions; unchanged
  history; `pendingSettings` cleared after apply and not resurrected by a
  concurrent update; the missing-session fallback and history append; the
  audit's changed-field list with no role/skill/model content; and rebind
  history ordering, unknown targets, busy rejection, and the home binding.
- `npm run verify` is run in the implementation worktree.
- No live host verification is claimed here unless a dated verification record
  is added.

## References

- Issue #189
- [Runtime guide](../agents/opencode-tui-runtime.md)
- [Implementation notes](../implementation.md#agents)
- `src/v2/service.ts`, `src/v2/service.test.ts`, `src/v2/tui/settings.ts`
- [ADR 0003: one service per host realm](0003-single-service-and-safe-recovery.md)
