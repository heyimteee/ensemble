import test from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_SESSION_PICKER_LIMIT,
  defaultSessionPickerScope,
  nextSessionPickerScope,
  normalizeSessionPickerScope,
  sessionInPickerScope,
  sessionMatchesPickerQuery,
  sessionPickerCandidates,
  sessionPickerDirectories,
  sessionPickerEventRefresh,
  sessionPickerListInputs,
  sessionPickerRevisionChanged,
  type NativeSessionListing,
} from "./session-picker.ts"

const project = "/srv/project"
const workspace = "/srv/project/ops"

const context = { projectDirectory: project, workspaceDirectory: workspace, directDirectory: workspace }

function listing(patch: Partial<NativeSessionListing> & { sessionID: string }): NativeSessionListing {
  return { title: `Session ${patch.sessionID}`, directory: project, updatedAt: 1, ...patch }
}

test("a direct target starts in the direct scope and a workspace target in the workspace scope", () => {
  assert.equal(defaultSessionPickerScope({ kind: "direct" }), "direct")
  assert.equal(defaultSessionPickerScope({ kind: "home" }), "direct")
  assert.equal(defaultSessionPickerScope({ kind: "workspace" }), "workspace")
})

test("scopes map to their own directory, and all lists every location", () => {
  assert.deepEqual(sessionPickerDirectories("direct", context), [workspace])
  assert.deepEqual(sessionPickerDirectories("workspace", context), [workspace])
  assert.deepEqual(sessionPickerDirectories("project", context), [project])
  assert.deepEqual(sessionPickerDirectories("all", context), [])
})

test("a missing scope directory yields no requests instead of widening to all", () => {
  assert.deepEqual(sessionPickerListInputs("workspace", { projectDirectory: project }, ""), [])
})

test("list requests are roots-only, unarchived, newest first, and scope-limited", () => {
  const [request] = sessionPickerListInputs("project", context, "  old work  ", 500)
  assert.deepEqual(request, {
    directory: project,
    search: "old work",
    parentID: null,
    archived: false,
    order: "desc",
    limit: 50,
  })
  const [every] = sessionPickerListInputs("all", context, "")
  assert.equal("directory" in every, false, "all asks the host-wide list")
  assert.equal(every.parentID, null)
  assert.equal(every.archived, false)
})

test("search applies only inside the selected scope", () => {
  const rows = [
    listing({ sessionID: "s_direct", title: "alpha direct", directory: workspace, updatedAt: 30 }),
    listing({ sessionID: "s_project", title: "alpha project", directory: project, updatedAt: 20 }),
    listing({ sessionID: "s_other", title: "alpha elsewhere", directory: "/srv/other", updatedAt: 10 }),
  ]
  const direct = sessionPickerCandidates(rows, { scope: "direct", context, query: "alpha" })
  assert.deepEqual(direct.map((row) => row.id), ["s_direct"])
  const workspaceHits = sessionPickerCandidates(rows, { scope: "workspace", context, query: "alpha project" })
  assert.deepEqual(workspaceHits, [], "a project session does not appear in the workspace scope")
  const projectHits = sessionPickerCandidates(rows, { scope: "project", context, query: "alpha" })
  assert.deepEqual(projectHits.map((row) => row.id), ["s_project"])
  const all = sessionPickerCandidates(rows, { scope: "all", context, query: "alpha" })
  assert.deepEqual(all.map((row) => row.id), ["s_direct", "s_project", "s_other"])
})

test("the default list is recent sessions, not storage order", () => {
  const rows = [
    listing({ sessionID: "s_old", updatedAt: 10 }),
    listing({ sessionID: "s_new", updatedAt: 40 }),
    listing({ sessionID: "s_mid", updatedAt: 25 }),
  ]
  assert.deepEqual(
    sessionPickerCandidates(rows, { scope: "project", context }).map((row) => row.id),
    ["s_new", "s_mid", "s_old"],
  )
  assert.equal(sessionPickerCandidates(rows, { scope: "project", context }).length, Math.min(3, DEFAULT_SESSION_PICKER_LIMIT))
})

test("archived, child, and duplicate rows never become picker candidates", () => {
  const rows = [
    listing({ sessionID: "s_root", updatedAt: 3 }),
    listing({ sessionID: "s_archived", archived: true, updatedAt: 4 }),
    listing({ sessionID: "s_child", parentID: "s_root", updatedAt: 5 }),
    listing({ sessionID: "s_root", updatedAt: 1 }),
  ]
  assert.deepEqual(
    sessionPickerCandidates(rows, { scope: "project", context }).map((row) => row.id),
    ["s_root"],
  )
})

test("search matches the title, id, location basename, and bound conversation", () => {
  const rows = [
    listing({ sessionID: "ses_alpha", title: "Release audit", directory: "/srv/project/ops" }),
    listing({ sessionID: "ses_beta", title: "Scratch", directory: "/srv/project/research" }),
  ]
  assert.equal(sessionMatchesPickerQuery(rows[0], "release"), true)
  assert.equal(sessionMatchesPickerQuery(rows[0], "ses_alpha"), true)
  assert.equal(sessionMatchesPickerQuery(rows[0], "ops"), true)
  assert.equal(sessionMatchesPickerQuery(rows[0], "missing"), false)
  assert.equal(
    sessionMatchesPickerQuery(rows[0], "ops", { conversation: "#Ops group chat", current: false }),
    true,
  )
})

test("candidate detail names binding state without an absolute path", () => {
  const rows = [listing({ sessionID: "s_bound", title: "Bound", directory: "/srv/project/ops", updatedAt: 2 })]
  const [candidate] = sessionPickerCandidates(rows, {
    scope: "workspace",
    context,
    bindings: {
      s_bound: { conversation: "#Ops group chat", current: false },
    },
  })
  assert.equal(candidate.label, "Bound")
  assert.match(candidate.detail, /serves #Ops group chat/)
  assert.match(candidate.detail, /ops/)
  assert.doesNotMatch(candidate.detail, /\/srv\/project/)
  assert.equal(sessionPickerCandidates(rows, { scope: "workspace", context })[0].detail, "available · ops")
})

test("the picker refresh signal every session mutation shape and ignores unrelated events", () => {
  for (const type of [
    "session.created",
    "session.updated",
    "session.deleted",
    "session.moved",
    "session.archived",
    "session.unarchived",
    "session.renamed",
    "session.metadata.updated",
    "session.permissions",
    "session.forked",
  ]) {
    assert.equal(sessionPickerEventRefresh(type), true, type)
  }
  for (const type of ["session.text.delta", "session.execution.succeeded", "config.updated", ""]) {
    assert.equal(sessionPickerEventRefresh(type), false, type)
  }
})

test("scope cycling is total and skips nothing", () => {
  assert.deepEqual(
    ["direct", "workspace", "project", "all", "direct"].map((scope) => nextSessionPickerScope(scope as any)),
    ["workspace", "project", "all", "direct", "workspace"],
  )
  assert.equal(normalizeSessionPickerScope("bogus", "direct"), "direct")
  assert.equal(normalizeSessionPickerScope("project", "direct"), "project")
})

test("refresh revisions only move forward", () => {
  assert.equal(sessionPickerRevisionChanged(undefined, 1), true)
  assert.equal(sessionPickerRevisionChanged(1, 2), true)
  assert.equal(sessionPickerRevisionChanged(2, 2), false)
  assert.equal(sessionPickerRevisionChanged(3, 2), false)
  assert.equal(sessionPickerRevisionChanged(1, "2"), false)
})

test("scope membership normalizes trailing separators", () => {
  assert.equal(sessionInPickerScope({ directory: `${project}/` }, "project", context), true)
  assert.equal(sessionInPickerScope({ directory: undefined }, "project", context), false)
})
