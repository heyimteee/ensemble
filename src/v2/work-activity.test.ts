import test from "node:test"
import assert from "node:assert/strict"
import { EnsembleV2Rpc } from "./rpc.ts"
import {
  WORK_ACTIVITY_LABEL_MAX,
  applyWorkActivity,
  boundedToolName,
  clearWorkActivitiesForSession,
  isWorkActivity,
  limitToolInput,
  pruneWorkActivities,
  toolActivityLabel,
  workActivityLabel,
  writingReplyLabel,
  type WorkActivity,
} from "./work-activity.ts"

const event = (patch: Partial<WorkActivity> = {}): WorkActivity => ({
  epoch: 7,
  workspaceID: "w",
  taskID: "t",
  sessionID: "s",
  label: "thinking…",
  status: "thinking",
  updatedAt: 1_000,
  ...patch,
})

test("ticket155: tool labels name the action without exposing content", () => {
  assert.equal(toolActivityLabel("bash", { command: "npm test -- --watch" }), "running npm test -- --watch…")
  assert.equal(toolActivityLabel("shell", { command: "git status" }), "running git status…")
  assert.equal(toolActivityLabel("read", { filePath: "/home/tristan/dev/ensemble/src/auth.ts" }), "reading auth.ts…")
  assert.equal(toolActivityLabel("grep", { pattern: "handleLogin" }), "searching handleLogin…")
  assert.equal(toolActivityLabel("glob", { pattern: "src/**/*.ts" }), "searching src/**/*.ts…")
  assert.equal(toolActivityLabel("edit", { filePath: "docs/readme.md" }), "editing readme.md…")
  assert.equal(toolActivityLabel("write", { filePath: "/tmp/out.json" }), "editing out.json…")
  assert.equal(toolActivityLabel("patch", { filePath: "src/v2/service.ts" }), "editing service.ts…")
  assert.equal(toolActivityLabel("mcp__some_server__tool"), "using mcp__some_server__tool…")
  assert.equal(toolActivityLabel(undefined), "thinking…")
  assert.equal(toolActivityLabel(""), "thinking…")
  assert.equal(writingReplyLabel(), "writing reply…")
})

test("ticket155: Ensemble tool labels name the handoff target or the status check", () => {
  assert.equal(toolActivityLabel("ensemble_handoff", { to: "Nova" }), "handing off to $Nova…")
  assert.equal(toolActivityLabel("ensemble.handoff", { to: "$Sage" }), "handing off to $Sage…")
  assert.equal(toolActivityLabel("ensemble_delegate", { assignee: "Sage" }), "delegating to $Sage…")
  assert.equal(toolActivityLabel("ensemble_task_status"), "checking task status…")
  assert.equal(toolActivityLabel("ensemble_handoff"), "handing off…")
  assert.equal(toolActivityLabel("ensemble_delegate"), "delegating…")
})

test("ticket155: labels truncate command heads and never leak file contents", () => {
  const command = `npm run verify ${"x".repeat(400)}\nrm -rf /`
  const label = toolActivityLabel("bash", { command })
  assert.ok(label.length <= WORK_ACTIVITY_LABEL_MAX, "labels stay bounded")
  assert.ok(label.startsWith("running npm run verify"), "the command head is the only command detail")
  assert.ok(!label.includes("\n"), "multiline commands collapse to one line")
  assert.ok(!label.includes("rm -rf"), "only the first command line is visible")

  const content = "TOP SECRET FILE CONTENT"
  assert.ok(!toolActivityLabel("write", { filePath: "notes.md", content }).includes(content))
  assert.ok(!toolActivityLabel("edit", { filePath: "notes.md", oldString: content, newString: content }).includes(content))
  assert.ok(!toolActivityLabel("patch", { patchText: `+${content}` }).includes(content))
  assert.equal(toolActivityLabel("read", { filePath: "C:\\Users\\tristan\\secret\\auth.ts" }), "reading auth.ts…")
})

test("ticket155: activity entries apply, clear, ignore duplicates, and expire as leaks", () => {
  const first = applyWorkActivity(new Map(), event({ label: "reading auth.ts…", status: "progress" }), 1_000)
  assert.equal(workActivityLabel(first, "t", 1_000), "reading auth.ts…")

  const duplicate = applyWorkActivity(first, event({ label: "reading auth.ts…", status: "progress" }), 1_000)
  assert.equal(duplicate, first, "an identical duplicate keeps the existing map identity")

  const replay = applyWorkActivity(first, event({ label: "running stale…", status: "called", updatedAt: 900 }), 1_000)
  assert.equal(replay, first, "a replayed older event never replaces newer activity")

  const cleared = applyWorkActivity(first, event({ label: "", status: "idle" }), 1_100)
  assert.equal(cleared.size, 0, "idle clears the task activity")
  assert.equal(workActivityLabel(cleared, "t", 1_100), undefined)

  const terminal = applyWorkActivity(first, event({ label: "", status: "terminal" }), 1_200)
  assert.equal(terminal.size, 0, "terminal clears the task activity")

  assert.equal(workActivityLabel(first, "t", 1_000 + 10 * 60_000 + 1), undefined, "stale entries never pose as live")
})

test("ticket155: activity is keyed per task and clears only the matching session", () => {
  let entries = applyWorkActivity(new Map(), event({ taskID: "a", sessionID: "s1", label: "running tests…" }), 1_000)
  entries = applyWorkActivity(entries, event({ taskID: "b", sessionID: "s2", label: "reading notes.md…" }), 1_000)
  const cleared = clearWorkActivitiesForSession(entries, "s1")
  assert.equal(cleared.has("a"), false)
  assert.equal(cleared.has("b"), true)
  assert.equal(clearWorkActivitiesForSession(cleared, "missing"), cleared, "an unmatched session keeps identity")
})

test("ticket155: terminal or needs-you tasks prune their activity without repainting clean maps", () => {
  let entries = applyWorkActivity(new Map(), event({ taskID: "terminal", label: "running tests…" }), 1_000)
  entries = applyWorkActivity(entries, event({ taskID: "blocked", label: "reading auth.ts…" }), 1_000)
  entries = applyWorkActivity(entries, event({ taskID: "working", label: "writing reply…" }), 1_000)
  const pruned = pruneWorkActivities(entries, (entry) => entry.taskID !== "working")
  assert.deepEqual([...pruned.keys()], ["working"])
  assert.equal(pruneWorkActivities(pruned, () => false), pruned, "a clean prune keeps the map identity")
})

test("ticket155: TUI validation rejects malformed activity without touching the map", () => {
  assert.equal(isWorkActivity(event()), true)
  assert.equal(isWorkActivity({ ...event(), epoch: "7" }), false)
  assert.equal(isWorkActivity({ ...event(), taskID: "" }), false)
  assert.equal(isWorkActivity({ ...event(), tool: 7 }), false)
  assert.equal(isWorkActivity(null), false)
})

test("ticket155: the bridge retains only display-safe input heads and a bounded tool name", () => {
  const limited = limitToolInput({
    filePath: "/home/tristan/dev/ensemble/.env.local",
    content: "SECRET",
    oldString: "SECRET",
    newString: "SECRET",
    patchText: "SECRET",
    command: "npm test\nSECRET",
    pattern: "SECRET_PATTERN",
  })
  assert.deepEqual(limited, {
    command: "npm test",
    filePath: ".env.local",
    pattern: "SECRET_PATTERN",
  })
  assert.ok(!JSON.stringify(limited).includes('"SECRET"'), "file contents never enter the retained input")
  assert.equal(toolActivityLabel("write", limited), "editing .env.local…")
  assert.equal(boundedToolName(`tool_${"x".repeat(100)}`), `tool_${"x".repeat(35)}`)
  assert.equal(boundedToolName("   "), undefined)
})

test("ticket155: work.activity is a declared version-neutral RPC event", () => {
  const schema = (EnsembleV2Rpc as any).events?.["work.activity"]?.schema
  assert.ok(schema, "the event is declared beside the durable feed")
  assert.deepEqual([...(schema.required ?? [])].sort(), [
    "epoch",
    "label",
    "sessionID",
    "status",
    "taskID",
    "updatedAt",
    "workspaceID",
  ])
  assert.equal(schema.properties.epoch.type, "number")
  assert.equal(schema.properties.updatedAt.type, "number")
  assert.equal("content" in schema.properties, false)
  assert.equal("text" in schema.properties, false)
})
