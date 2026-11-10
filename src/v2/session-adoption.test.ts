import test from "node:test"
import assert from "node:assert/strict"
import {
  adoptionBlockerCode,
  adoptionConversationName,
  adoptionHeadsUp,
  adoptionTargetDirectory,
  planSessionAdoption,
  resolveAdoptionTarget,
  sessionMoveConfirmed,
  sessionMoveRequired,
  type AdoptionSessionState,
  type AdoptionTarget,
} from "./session-adoption.ts"

function session(patch: Partial<AdoptionSessionState> = {}): AdoptionSessionState {
  return { sessionID: "ses_1", found: true, directory: "/srv/project/ops", ...patch }
}

const workspaceTarget: AdoptionTarget = { kind: "workspace", workspaceID: "w", agentID: "a" }
const directTarget: AdoptionTarget = { kind: "direct", workspaceID: "w", agentID: "a" }
const homeTarget: AdoptionTarget = { kind: "home", agentID: "a" }

test("target resolution names the conversation, never a bare session", () => {
  assert.deepEqual(
    resolveAdoptionTarget({ agentID: "a", workspaceID: "w", workspaceMember: true, conversation: "workspace" }),
    { ok: true, target: workspaceTarget, conversation: { kind: "workspace", workspaceID: "w", agentID: "a" } },
  )
  assert.deepEqual(
    resolveAdoptionTarget({ agentID: "a", workspaceID: "w", workspaceMember: true, conversation: "direct" }),
    { ok: true, target: directTarget, conversation: { kind: "direct", workspaceID: "w", agentID: "a" } },
  )
  assert.deepEqual(
    resolveAdoptionTarget({ agentID: "a", workspaceID: "w", workspaceMember: true }),
    { ok: true, target: directTarget, conversation: { kind: "direct", workspaceID: "w", agentID: "a" } },
    "the direct chat is the default adoption surface",
  )
})

test("a non-member or absent workspace falls back to home direct", () => {
  assert.deepEqual(
    resolveAdoptionTarget({ agentID: "a", workspaceID: "w", workspaceMember: false, conversation: "direct" }),
    { ok: true, target: homeTarget, conversation: { kind: "home", agentID: "a" } },
  )
  assert.deepEqual(
    resolveAdoptionTarget({ agentID: "a", conversation: "home" }),
    { ok: true, target: homeTarget, conversation: { kind: "home", agentID: "a" } },
  )
})

test("a workspace group target requires a workspace and membership", () => {
  assert.equal(
    resolveAdoptionTarget({ agentID: "a", conversation: "workspace" }).ok,
    false,
  )
  const notMember = resolveAdoptionTarget({ agentID: "a", workspaceID: "w", workspaceMember: false, conversation: "workspace" })
  assert.equal(notMember.ok, false)
  assert.equal(!notMember.ok && notMember.code, "agent_not_member")
  assert.equal(resolveAdoptionTarget({ agentID: "", conversation: "home" }).ok, false)
  assert.equal(resolveAdoptionTarget({ agentID: "a", conversation: "unknown" }).ok, false)
})

test("the target directory follows the conversation's file access", () => {
  const directories = { workspaceDirectory: "/srv/project/ops/", homeDirectory: "/home/agent" }
  assert.equal(adoptionTargetDirectory(workspaceTarget, directories), "/srv/project/ops")
  assert.equal(adoptionTargetDirectory(directTarget, directories), "/srv/project/ops")
  assert.equal(adoptionTargetDirectory(homeTarget, directories), "/home/agent")
})

test("a healthy session in the target directory adopts without a confirmation", () => {
  const plan = planSessionAdoption({ target: directTarget, session: session(), targetDirectory: "/srv/project/ops" })
  assert.equal(plan.canAdopt, true)
  assert.equal(plan.moveRequired, false)
  assert.equal(plan.needsReassign, false)
  assert.deepEqual(plan.blockers, [])
  assert.equal(plan.unchanged, false)
})

test("the target conversation's current session is unchanged, not re-adopted", () => {
  const plan = planSessionAdoption({
    target: directTarget,
    session: session(),
    targetDirectory: "/srv/project/ops",
    currentSessionID: "ses_1",
  })
  assert.equal(plan.unchanged, true)
  assert.equal(plan.canAdopt, false)
})

test("archived, child, missing, and busy sessions are refused outright", () => {
  const cases: Array<[Partial<AdoptionSessionState>, string]> = [
    [{ found: false }, "session_not_found"],
    [{ archived: true }, "session_archived"],
    [{ parentID: "ses_parent" }, "session_child"],
    [{ busy: true }, "session_busy"],
  ]
  for (const [patch, code] of cases) {
    const plan = planSessionAdoption({ target: directTarget, session: session(patch), targetDirectory: "/srv/project/ops" })
    assert.equal(plan.rejected, true, code)
    assert.equal(plan.canAdopt, false, code)
    assert.equal(adoptionBlockerCode(plan), code)
  }
})

test("a session bound to another conversation needs explicit reassignment", () => {
  const bound = { agentID: "b", conversation: { kind: "workspace" as const, workspaceID: "w2", agentID: "b" } }
  const refused = planSessionAdoption({ target: directTarget, session: session(), targetDirectory: "/srv/project/ops", boundElsewhere: bound })
  assert.equal(refused.needsReassign, true)
  assert.equal(refused.canAdopt, false)
  assert.ok(refused.blockers.includes("bound_elsewhere"))
  assert.equal(adoptionBlockerCode(refused), "session_already_bound")

  const accepted = planSessionAdoption({
    target: directTarget,
    session: session(),
    targetDirectory: "/srv/project/ops",
    boundElsewhere: bound,
    reassign: true,
  })
  assert.equal(accepted.canAdopt, true)
  assert.equal(accepted.needsReassign, true)
  assert.deepEqual(accepted.blockers, [])
})

test("a directory move requires confirmation before any binding write", () => {
  const plan = planSessionAdoption({ target: directTarget, session: session({ directory: "/home/agent" }), targetDirectory: "/srv/project/ops" })
  assert.equal(plan.moveRequired, true)
  assert.equal(plan.canAdopt, false)
  assert.ok(plan.blockers.includes("move_confirmation"))
  assert.equal(adoptionBlockerCode(plan), "move_confirmation_required")
  const confirmed = planSessionAdoption({
    target: directTarget,
    session: session({ directory: "/home/agent" }),
    targetDirectory: "/srv/project/ops",
    confirmMove: true,
  })
  assert.equal(confirmed.canAdopt, true)
})

test("a busy session is refused even when its directory already matches", () => {
  const plan = planSessionAdoption({ target: directTarget, session: session({ busy: true }), targetDirectory: "/srv/project/ops", confirmMove: true })
  assert.equal(plan.moveRequired, false)
  assert.equal(plan.rejected, true)
  assert.equal(plan.canAdopt, false)
})

test("move confirmation reads the reported location, and a queued move does not count", () => {
  assert.equal(sessionMoveRequired("/home/agent", "/srv/project/ops"), true)
  assert.equal(sessionMoveRequired("/srv/project/ops/", "/srv/project/ops"), false)
  assert.equal(sessionMoveRequired(undefined, "/srv/project/ops"), true)
  assert.equal(sessionMoveConfirmed("/srv/project/ops/", "/srv/project/ops"), true)
  assert.equal(sessionMoveConfirmed("/home/agent", "/srv/project/ops"), false)
  assert.equal(sessionMoveConfirmed(undefined, "/srv/project/ops"), false)
})

test("the heads-up names the Ensemble conversation and never a path", () => {
  assert.equal(
    adoptionConversationName(directTarget, { agentName: "Ada", workspaceName: "Ops" }),
    "#Ops direct conversation with Ada",
  )
  assert.equal(adoptionConversationName(workspaceTarget, { agentName: "Ada", workspaceName: "Ops" }), "#Ops group chat")
  assert.equal(adoptionConversationName(homeTarget, { agentName: "Ada" }), "home direct conversation with Ada")
  const headsUp = adoptionHeadsUp(directTarget, { agentName: "Ada", workspaceName: "Ops" })
  assert.match(headsUp, /#Ops direct conversation with Ada/)
  assert.doesNotMatch(headsUp, /\/srv|\/home/)
})
