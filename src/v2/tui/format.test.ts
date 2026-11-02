import test from "node:test"
import assert from "node:assert/strict"
import { ageLabel, agentColor, answerHeader, askingLine, assignmentLine, fuzzyMatch, headerQueuedSuffix, isAssignmentEvent, markdownText, missingSkills, queuedRemovable, queuedSuffix, relayTaskForMessage, renderMarkdownLines, renderVerbatimLines, resultForTask, short, systemLine, transcriptRole, unreadCount, wrapText, workspaceGroupLabel } from "./format.ts"
import type { Agent, Message, SnapshotState, Subtask, Workspace } from "../types.ts"

const agent = (patch: Partial<Agent> = {}): Agent => ({
  id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "p", modelID: "m" },
  backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1, ...patch,
})
const workspace = (patch: Partial<Workspace> = {}): Workspace => ({
  id: "w", name: "site", directory: "/repo", leaderID: "a", memberIDs: ["a"], synthesis: true,
  archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 10, ...patch,
})
const message = (patch: Partial<Message> = {}): Message => ({
  id: "m", workspaceID: "w", seq: 1, author: "agent", agentID: "a", text: "hello", kind: "text", createdAt: 20, ...patch,
})
const subtask = (patch: Partial<Subtask> = {}): Subtask => ({
  id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "task", instruction: "do",
  mode: "research", state: "replied", stage: "initial", outcome: "succeeded", interrupted: false,
  awaitingChildren: false, attempts: 1, createdAt: 1, ...patch,
})

test("wrapText wraps words and caps long messages", () => {
  assert.deepEqual(wrapText("one two three", 7), ["one two", "three"])
  const lines = wrapText("word ".repeat(30), 10, 3)
  assert.equal(lines.length, 3)
  assert.ok(lines[2].endsWith("…"))
})

test("markdownText strips markers that terminal text cannot render", () => {
  assert.equal(markdownText("# Title\n- item\n**bold** `code` [link](https://example.com)"), "Title\n• item\nbold code link")
  assert.equal(markdownText("```ts\nconst x = 1\n```"), "\nconst x = 1\n\n")
})

test("fuzzy matching accepts subsequences and rejects misses", () => {
  assert.equal(fuzzyMatch("nt", "notes.txt"), true)
  assert.equal(fuzzyMatch("xyz", "notes.txt"), false)
  assert.equal(fuzzyMatch("", "anything"), true)
})

test("agent color uses named and hex values with a fallback", () => {
  assert.equal(agentColor(agent(), "#fallback"), "#8be9fd")
  assert.equal(agentColor(agent({ color: "#123456" }), "#fallback"), "#123456")
  assert.equal(agentColor(undefined, "#fallback"), "#fallback")
  assert.equal(agentColor(agent({ color: "chartreuse" }), "#fallback"), "#fallback")
})

test("missing skills are reported against the catalog", () => {
  assert.deepEqual(missingSkills(agent({ skillbox: ["a", "b"] }), [{ id: "a" }]), ["b"])
  assert.deepEqual(missingSkills(agent({ skillbox: [] }), []), [])
})

test("workspace labels shorten home paths and group labels", () => {
  assert.ok(workspaceGroupLabel("/home/tristan/dev/ensemble").startsWith("~/dev/ensemble") || workspaceGroupLabel("/home/tristan/dev/ensemble").includes("dev/ensemble"))
  assert.equal(workspaceGroupLabel("/tmp/a"), "tmp/a")
})

test("unread counts exclude the user and respect last activation", () => {
  const state = { messages: { w: [message({ createdAt: 20 }), message({ author: "user", createdAt: 20 }), message({ createdAt: 5 })] } } as unknown as SnapshotState
  assert.equal(unreadCount(state, workspace({ lastActiveAt: 10 })), 1)
})

test("result lookup returns the stored reply", () => {
  const state = { messages: { w: [message({ id: "reply" })] }, subtasks: {} } as unknown as SnapshotState
  assert.equal(resultForTask(state, subtask({ resultMessageID: "reply" }))?.id, "reply")
  assert.equal(resultForTask(state, subtask()), undefined)
})

test("age labels use compact units", () => {
  assert.match(ageLabel(Date.now() - 5_000), /^\d+s$/)
  assert.match(ageLabel(Date.now() - 120_000), /^\d+m$/)
  assert.match(ageLabel(Date.now() - 7_200_000), /^\d+h$/)
})


test("renderMarkdownLines preserves headings, bullets, code, and tables", () => {
  const lines = renderMarkdownLines("# Title\n- one\n- two\n\n```ts\nconst x = 1\n```\n\n| Name | Age |\n|---|---|\n| Nova | 2 |\n| Sage | 3 |", 40)
  assert.equal(lines[0], "Title")
  assert.equal(lines[1], "• one")
  assert.equal(lines[2], "• two")
  assert.ok(lines.some((line) => line.includes("Name") && line.includes("Age")))
  assert.ok(lines.some((line) => line.includes("Nova") && line.includes("2")))
  assert.ok(lines.some((line) => line.trimStart().startsWith("const x = 1")))
  assert.deepEqual(renderMarkdownLines("", 10), [" "])
})


test("direct assistant messages use the rich agent transcript role", () => {
  assert.equal(transcriptRole("assistant"), "agent")
  assert.equal(transcriptRole("assistant"), "agent")
  assert.equal(transcriptRole("user"), "user")
  assert.equal(transcriptRole("system"), "system")
})

test("slice C attribution lines name the agent exactly once", () => {
  assert.equal(assignmentLine("Nova", "Do the thing"), "→ Assigned to $Nova: Do the thing")
  assert.equal(askingLine("Nova"), "Asking $Nova…")
  assert.equal(answerHeader("Nova"), "Answer from $Nova")
  const long = `t${"i".repeat(100)}`
  assert.equal(assignmentLine("Nova", long), `→ Assigned to $Nova: ${long}`)
})

test("slice C system lines use the glyph grammar", () => {
  assert.equal(systemLine("routine", "Leader will synthesize"), "◷ Leader will synthesize")
  assert.equal(systemLine("failure", "Handoff failed"), "✕ Handoff failed")
  assert.equal(systemLine("notice", "Mention normalized"), "ⓘ Mention normalized")
})

test("slice C queued suffix carries the remove affordance", () => {
  assert.equal(queuedSuffix(false), " · queued")
  assert.equal(queuedSuffix(true), " · queued · [x remove]")
})

test("review fix: queued remove is a direct-surface affordance only", () => {
  assert.equal(queuedRemovable("user", "agent"), true)
  assert.equal(queuedRemovable("user", "workspace"), false)
  assert.equal(queuedRemovable("agent", "agent"), false)
  assert.equal(queuedRemovable("system", "agent"), false)
  assert.equal(headerQueuedSuffix({ queued: true, role: "user" }, "agent"), " · queued · [x remove]")
  // A queued group row is impossible by construction (Message carries no
  // queued flag), and even a stray bit never offers a dead affordance.
  assert.equal(headerQueuedSuffix({ queued: true, role: "user" }, "workspace"), " · queued")
  assert.equal(headerQueuedSuffix({ queued: false, role: "user" }, "agent"), "")
  assert.equal(headerQueuedSuffix({ role: "user" }, "agent"), "")
})

test("slice C user text stays verbatim while agent text strips markdown", () => {
  assert.deepEqual(renderVerbatimLines("Use *asterisks* literally `code`", 40), ["Use *asterisks* literally `code`"])
  assert.deepEqual(renderVerbatimLines("a b c d", 3), ["a b", "c d"])
  assert.ok(!renderVerbatimLines("", 10)[0].includes("•"))
})

test("slice C relay answers link by correlation instead of double-rendering", () => {
  const turn = subtask({ id: "turn", workKind: "turn", assigneeID: "a", turn: { correlationID: "corr-1", askerKind: "user", answeredByID: "a" } })
  const other = subtask({ id: "other", workKind: "delegation", assigneeID: "a" })
  assert.equal(relayTaskForMessage({ correlationID: "corr-1", agentID: "a" }, [other, turn])?.id, "turn")
  assert.equal(relayTaskForMessage({ correlationID: "nope", agentID: "a" }, [turn]), undefined)
  assert.equal(relayTaskForMessage({ agentID: "a" }, [turn]), undefined)
  const handoff = subtask({ id: "hop", workKind: "handoff", assigneeID: "a", handoff: { correlationID: "corr-2", senderID: "b", recipientID: "a", depth: 1, answeredByID: "a" } })
  assert.equal(relayTaskForMessage({ correlationID: "corr-2", agentID: "a" }, [handoff])?.id, "hop")
  assert.equal(isAssignmentEvent({ kind: "task", taskID: "turn" }), true)
  assert.equal(isAssignmentEvent({ kind: "text" }), false)
})
