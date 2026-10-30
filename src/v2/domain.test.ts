import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseMentions, visibleRecipients } from "./routing.ts"
import { canonicalDirectory } from "./paths.ts"
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

test("workspace canonicalization normalizes equivalent paths and rejects files", () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-v2-"))
  const nested = join(root, "project")
  mkdirSync(nested)
  assert.equal(canonicalDirectory(nested + "/"), canonicalDirectory(nested))
  assert.equal(canonicalDirectory(join(root, ".", "project")), canonicalDirectory(nested))
})

test("store persists agents, workspaces, messages, and binds per entity", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.saveAgent(agent("a", "Nova"))
  const ws = workspace("w", "a", ["a"])
  await store.saveWorkspace(ws)
  await store.appendMessage({ id: "m1", workspaceID: "w", seq: 1, author: "user", text: "hello", kind: "text", createdAt: 1 })
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
