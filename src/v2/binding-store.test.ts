import test from "node:test"
import assert from "node:assert/strict"
import { V2Store } from "./store.ts"
import { bindingStateKey } from "./conversation-binding.ts"
import type { SessionBinding } from "./types.ts"

function fakeContext(values = new Map<string, unknown>()) {
  const storage = {
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
  }
  return { values, storage }
}

const groupBinding = (patch: Partial<SessionBinding> = {}): SessionBinding => ({
  workspaceID: "w",
  agentID: "a",
  sessionID: "s_group",
  kind: "workspace",
  directory: "/repo",
  agentVersion: 1,
  updatedAt: 1,
  ...patch,
})

const directBinding = (patch: Partial<SessionBinding> = {}): SessionBinding => ({
  workspaceID: "w",
  agentID: "a",
  sessionID: "s_direct",
  kind: "direct",
  directory: "/repo",
  agentVersion: 1,
  updatedAt: 1,
  ...patch,
})

const homeBinding = (patch: Partial<SessionBinding> = {}): SessionBinding => ({
  workspaceID: "home",
  agentID: "a",
  sessionID: "s_home",
  kind: "home",
  directory: "/home/a",
  agentVersion: 1,
  updatedAt: 1,
  ...patch,
})

test("workspace group, workspace direct, and home direct bindings coexist for one agent", async () => {
  const store = new V2Store(fakeContext())
  await store.saveBinding(groupBinding())
  await store.saveBinding(directBinding())
  await store.saveBinding(homeBinding())

  assert.equal(store.bindingForConversation("a", { kind: "workspace", workspaceID: "w", agentID: "a" })?.sessionID, "s_group")
  assert.equal(store.bindingForConversation("a", { kind: "direct", workspaceID: "w", agentID: "a" })?.sessionID, "s_direct")
  assert.equal(store.bindingForConversation("a", { kind: "home", agentID: "a" })?.sessionID, "s_home")
  assert.equal(store.bindingForSession("s_group")?.sessionID, "s_group")
  assert.equal(store.bindingForSession("s_direct")?.sessionID, "s_direct")
  assert.equal(store.bindingForSession("s_home")?.sessionID, "s_home")
  assert.deepEqual(
    Object.keys(store.snapshot().bindings).sort(),
    ["dm:a:w", "home:a", "w:a"],
  )
})

test("a current native session cannot be bound to two conversations", async () => {
  const store = new V2Store(fakeContext())
  await store.saveBinding(groupBinding())
  const before = store.snapshot().bindings

  await assert.rejects(
    () => store.saveBinding(directBinding({ sessionID: "s_group" })),
    (error: any) => error?.code === "session_already_bound",
  )
  assert.deepEqual(store.snapshot().bindings, before, "a rejected duplicate changes no binding")
  assert.equal(store.bindingForSession("s_group")?.sessionID, "s_group")
  assert.equal(store.bindingForConversation("a", { kind: "direct", workspaceID: "w", agentID: "a" }), undefined)
})

test("moving a conversation to a new session preserves the retired session and updates the reverse index", async () => {
  const store = new V2Store(fakeContext())
  await store.saveBinding(directBinding({ sessionID: "s_direct", history: [] }))
  assert.equal(store.bindingForSession("s_direct")?.sessionID, "s_direct")

  await store.saveBinding(directBinding({ sessionID: "s_next", updatedAt: 2 }))
  const binding = store.bindingForConversation("a", { kind: "direct", workspaceID: "w", agentID: "a" })
  assert.equal(binding?.sessionID, "s_next")
  assert.deepEqual(binding?.history, ["s_direct"], "the retired session is kept for rebind")
  assert.equal(store.bindingForSession("s_next")?.sessionID, "s_next")
  assert.equal(store.bindingForSession("s_direct")?.sessionID, "s_next", "history remains resolvable")
})

test("removing a conversation binding clears its reverse index entry", async () => {
  const store = new V2Store(fakeContext())
  await store.saveBinding(directBinding())
  await store.removeConversationBinding("a", { kind: "direct", workspaceID: "w", agentID: "a" })

  assert.equal(store.bindingForSession("s_direct"), undefined)
  assert.equal(store.bindingForConversation("a", { kind: "direct", workspaceID: "w", agentID: "a" }), undefined)
  await store.saveBinding(groupBinding({ sessionID: "s_direct" }))
  assert.equal(store.bindingForSession("s_direct")?.sessionID, "s_direct")
})

test("pre-#213 bindings load as workspace group and home direct without being rewritten", async () => {
  const values = new Map<string, unknown>()
  const legacyWorkspace = { workspaceID: "w", agentID: "a", sessionID: "s_old", directory: "/repo", agentVersion: 1, updatedAt: 1 }
  const legacyHome = { workspaceID: "home", agentID: "a", sessionID: "s_home", kind: "home", directory: "/home/a", agentVersion: 1, updatedAt: 1 }
  values.set("v2/binding/w/a", legacyWorkspace)
  values.set("v2/binding/home/a", legacyHome)
  const store = new V2Store(fakeContext(values))
  await store.load()

  assert.deepEqual(store.bindingForConversation("a", { kind: "workspace", workspaceID: "w", agentID: "a" }), legacyWorkspace)
  assert.deepEqual(store.bindingForConversation("a", { kind: "home", agentID: "a" }), legacyHome)
  assert.equal(store.bindingForSession("s_old")?.sessionID, "s_old")
  assert.equal(store.bindingForSession("s_home")?.sessionID, "s_home")
  assert.deepEqual(values.get("v2/binding/w/a"), legacyWorkspace, "load does not migrate old rows in place")
})

test("duplicate current sessions in stored rows fail closed instead of picking conversations", async () => {
  const values = new Map<string, unknown>()
  values.set("v2/binding/w/a", groupBinding({ sessionID: "s_dup" }))
  values.set("v2/binding/direct/w/a", directBinding({ sessionID: "s_dup" }))
  const store = new V2Store(fakeContext(values))
  await store.load()

  assert.equal(store.bindingForSession("s_dup"), undefined, "an ambiguous session is never attributed")
  assert.equal(store.bindingForConversation("a", { kind: "workspace", workspaceID: "w", agentID: "a" })?.sessionID, "s_dup")
  assert.equal(store.bindingForConversation("a", { kind: "direct", workspaceID: "w", agentID: "a" })?.sessionID, "s_dup")
})

test("a direct binding survives reload at its own storage key", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.saveBinding(directBinding())
  assert.ok(ctx.values.has("v2/binding/direct/w/a"))

  const reloaded = new V2Store(fakeContext(ctx.values))
  await reloaded.load()
  assert.equal(reloaded.bindingForConversation("a", { kind: "direct", workspaceID: "w", agentID: "a" })?.sessionID, "s_direct")
  assert.equal(reloaded.bindingForSession("s_direct")?.sessionID, "s_direct")
  assert.equal(bindingStateKey(directBinding()), "dm:a:w")
})

test("bindings with malformed conversation identity are rejected", async () => {
  const store = new V2Store(fakeContext())
  await assert.rejects(
    () => store.saveBinding(directBinding({ workspaceID: "home" })),
    (error: any) => error?.code === "invalid_binding",
  )
  await assert.rejects(
    () => store.saveBinding(groupBinding({ workspaceID: "" })),
    (error: any) => error?.code === "invalid_binding",
  )
  assert.equal(store.bindingForSession("s_direct"), undefined)
})
