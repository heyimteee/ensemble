import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseMentions, unknownMentions, visibleRecipients } from "./routing.ts"
import { canonicalDirectory, expandHome } from "./paths.ts"
import { homedir } from "node:os"
import { V2Store } from "./store.ts"
import type { Agent, Workspace } from "./types.ts"

function agent(id: string, name: string): Agent {
  return {
    id,
    name,
    title: "",
    role: "",
    mainModel: { providerID: "p", modelID: "m" },
    backupModels: [],
    skillbox: [],
    color: "cyan",
    archived: false,
    pendingSettings: false,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  }
}

function workspace(id: string, leaderID: string, memberIDs: string[]): Workspace {
  return {
    id,
    name: id,
    directory: "/repo",
    leaderID,
    memberIDs,
    synthesis: true,
    archived: false,
    paused: false,
    nextSeq: 1,
    createdAt: 1,
    lastActiveAt: 1,
  }
}

function fakeContext() {
  const values = new Map<string, unknown>()
  return {
    values,
    storage: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => { values.set(key, value) },
      remove: async (key: string) => { values.delete(key) },
      scan: async ({ prefix, after, limit }: any) => {
        const entries = [...values.entries()]
          .filter(([key]) => key.startsWith(prefix) && (!after || key > after))
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, limit ?? 500)
          .map(([key, value]) => ({ key, value }))
        return { entries, next: entries.length === (limit ?? 500) ? entries.at(-1)?.key : undefined }
      },
    },
  }
}

test("mentions use @ or !, longest names win, and unaddressed messages go to the leader", () => {
  const agents = { a: agent("a", "Nova"), b: agent("b", "Nova Prime") }
  const ws = workspace("w", "a", ["a", "b"])
  assert.deepEqual(parseMentions("@Nova Prime", ws, agents), ["b"])
  assert.deepEqual(parseMentions("!Nova", ws, agents), ["a"])
  assert.deepEqual(parseMentions("@Nova Prime and @Nova", ws, agents), ["b", "a"])
  assert.deepEqual(parseMentions("no mention", ws, agents), [])
  assert.deepEqual(visibleRecipients("no mention", ws, agents), ["a"])
  assert.deepEqual(visibleRecipients("@Nova Prime", ws, agents), ["b"])
})

test("unknown mentions are reported while emails and known names pass", () => {
  const agents = { a: agent("a", "Nova"), b: agent("b", "Nova Prime") }
  const ws = workspace("w", "a", ["a", "b"])
  assert.deepEqual(unknownMentions("@Nova Prime and @Nova", ws, agents), [])
  assert.deepEqual(unknownMentions("@Ghost please check", ws, agents), ["@Ghost"])
  assert.deepEqual(unknownMentions("mail me at dev@example.com", ws, agents), [])
  assert.deepEqual(unknownMentions("Fix the @media query and @ts-ignore", ws, agents), [])
})

test("workspace canonicalization expands home and normalizes equivalent paths", () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-v2-"))
  const nested = join(root, "project")
  mkdirSync(nested)
  assert.equal(canonicalDirectory(nested + "/"), canonicalDirectory(nested))
  assert.equal(canonicalDirectory(join(root, ".", "project")), canonicalDirectory(nested))
  assert.equal(expandHome("~"), homedir())
  assert.equal(expandHome("~/dev"), join(homedir(), "dev"))
  assert.equal(expandHome("/tmp/project"), "/tmp/project")
})

test("store allocates message sequence numbers without overwriting concurrent appends", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.saveWorkspace(workspace("w", "a", ["a"]))
  const messages = await Promise.all([
    store.appendMessage("w", { id: "m1", author: "user", text: "one", kind: "text", createdAt: 1 }),
    store.appendMessage("w", { id: "m2", author: "user", text: "two", kind: "text", createdAt: 2 }),
    store.appendMessage("w", { id: "m3", author: "user", text: "three", kind: "text", createdAt: 3 }),
  ])
  assert.deepEqual(messages.map((message) => message.seq), [1, 2, 3])
  const loaded = new V2Store(ctx)
  await loaded.load()
  assert.deepEqual(loaded.snapshot().messages.w.map((message) => message.text), ["one", "two", "three"])
  assert.equal(loaded.snapshot().workspaces.w.nextSeq, 4)
})

test("startup marks working subtasks as interrupted instead of replaying them", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.saveWorkspace(workspace("w", "a", ["a"]))
  await store.saveSubtask({
    id: "t1",
    workspaceID: "w",
    creatorType: "user",
    title: "Hello",
    instruction: "Hello",
    mode: "research",
    state: "working",
    stage: "initial",
    outcome: "pending",
    interrupted: false,
    awaitingChildren: false,
    attempts: 1,
    createdAt: 1,
  })
  const loaded = new V2Store(ctx)
  await loaded.load()
  const task = loaded.snapshot().subtasks.t1
  assert.equal(task.state, "pending")
  assert.equal(task.interrupted, true)
  assert.equal(task.activeRunID, undefined)
})

test("store persists agents, workspaces, messages, and binds per entity", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.saveAgent(agent("a", "Nova"))
  const ws = workspace("w", "a", ["a"])
  await store.saveWorkspace(ws)
  await store.appendMessage("w", { id: "m1", author: "user", text: "hello", kind: "text", createdAt: 1 })
  await store.saveBinding({ workspaceID: "w", agentID: "a", sessionID: "s1", agentVersion: 1, updatedAt: 1 })
  const loaded = new V2Store(ctx)
  await loaded.load()
  const snapshot = loaded.snapshot()
  assert.equal(snapshot.agents.a.name, "Nova")
  assert.equal(snapshot.workspaces.w.directory, "/repo")
  assert.deepEqual(snapshot.messages.w.map((message) => message.text), ["hello"])
  assert.equal(snapshot.bindings["w:a"].sessionID, "s1")
  assert.equal(snapshot.settings.maxActiveRuns, 3)
})
