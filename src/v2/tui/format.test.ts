import test from "node:test"
import assert from "node:assert/strict"
import { ageLabel, agentColor, fuzzyMatch, markdownText, missingSkills, resultForTask, unreadCount, wrapText, workspaceGroupLabel } from "./format.ts"
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
