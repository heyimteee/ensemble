import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EnsembleV2Service } from "./service.ts"
import { V2Store } from "./store.ts"
import { activityStateForTask } from "./tui/workrows.ts"

type Handlers = {
  snapshot: (input: unknown) => Promise<any>
  invoke: (input: unknown) => Promise<any>
}

function fakeContext() {
  const values = new Map<string, unknown>()
  const tools = new Map<string, any>()
  const ctx = {
    onboarding: false,
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
    session: {
      hook: async () => ({ dispose: async () => undefined }),
      create: async ({ title }: any) => ({ data: { id: `session_${title}_${Math.random().toString(36).slice(2, 8)}`, title } }),
      instructions: { entry: { put: async () => undefined } },
      switchModel: async () => undefined,
      prompt: async () => undefined,
      wait: async () => { await new Promise((resolve) => setTimeout(resolve, 5)) },
      context: async () => ({
        data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "Relayed answer." }] }],
      }),
      interrupt: async () => undefined,
      remove: async () => undefined,
      move: async ({ sessionID, directory }: any) => ({ data: { id: sessionID, directory } }),
      command: async () => ({ data: {} }),
    },
    tool: { transform: async (factory: any) => factory({ namespace() {}, add(tool: any) { tools.set(tool.name, tool) } }) },
    rpc: {
      register: async (_schema: unknown, value: Handlers) => {
        handlers.snapshot = value.snapshot
        handlers.invoke = value.invoke
        return { events: { emit: async () => undefined } }
      },
    },
    model: {
      list: async () => [{ providerID: "probe", id: "probe-model", name: "Probe", variants: [] }],
    },
    skill: { list: async () => [] },
    event: {
      subscribe: async function* () {
        while (true) await new Promise<void>(() => undefined)
      },
    },
  }
  const handlers: Partial<Handlers> = {}
  return { ctx, handlers: handlers as Handlers, tools }
}

async function waitFor(check: () => Promise<boolean>, timeout = 8000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for condition")
}

const handoffFile = (directory: string, name: string, body: string): string => {
  mkdirSync(join(directory, ".ensemble", "handoffs"), { recursive: true })
  writeFileSync(join(directory, ".ensemble", "handoffs", name), body)
  return `.ensemble/handoffs/${name}`
}

async function bindingSessionID(handlers: Handlers, directory: string, agentID: string): Promise<string> {
  let sessionID = ""
  await waitFor(async () => {
    const next = await handlers.snapshot({ directory })
    const binding = Object.values(next.state.bindings).find((item: any) => item.agentID === agentID) as any
    if (!binding) return false
    sessionID = binding.sessionID
    return true
  })
  return sessionID
}

// Ticket #70: the parentless-hop hole. A handoff issued from a session with
// no live run must anchor to the sender's newest open task — never orphan —
// so the sender's turn stays open until the hop is answered.
test("parentless handoff anchors to the sender's newest open task", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-handoff-wait-"))
  const { ctx, tools } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seed.saveAgent({ id: "nova", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveAgent({ id: "sage", name: "Sage", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "nova", memberIDs: ["nova", "sage"], synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  await seed.saveBinding({ workspaceID: "w", agentID: "nova", sessionID: "sess_nova", kind: "workspace", directory, agentVersion: 1, updatedAt: 1 })
  // Parked past the pump filter (retryAfter in the future) so no live run
  // can register for it: the handoff call below is deterministically runless.
  await seed.saveSubtask({
    id: "sender-open", workspaceID: "w", creatorType: "user", assigneeID: "nova",
    title: "Coordinate", instruction: "Coordinate", mode: "research", state: "pending",
    stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 0, createdAt: 1, retryAfter: Date.now() + 60_000, workKind: "delegation",
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
  const handlers = service.handlers()
  try {
    const path = handoffFile(directory, "ask.md", "---\nensemble: handoff\ntask: Summarize the deploy\n---\n# Handoff\n")
    const asked = await tools.get("handoff").execute({ task: "Summarize the deploy", summary: "Short version", path, to: "Sage" }, { sessionID: "sess_nova" })
    assert.match(asked.content, /Handed to \$Sage/)
    // The waiting contract is stated on the tool result: no second delegate.
    assert.match(asked.content, /stays open/)
    assert.match(asked.content, /do not call ensemble_delegate/)
    const after = await handlers.snapshot({ directory })
    const hops = Object.values(after.state.subtasks).filter((task: any) => task.workKind === "handoff") as any[]
    assert.equal(hops.length, 1)
    assert.equal(hops[0].parentID, "sender-open")
    assert.equal(hops[0].handoff?.parentID, "sender-open")
    assert.ok(hops[0].handoff?.correlationID)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

// Ticket #70: full waiting contract. The sender's parented turn stays in
// awaitingChildren with a visible `Waiting for $Name…` state until the hop
// is delivered/answered — and no second delegate double-queues the work.
test("sender waits on the handoff with a visible wait and no double-queue", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-handoff-wait-"))
  const { ctx, tools } = fakeContext()
  // Stagger the waits so the sender's wait ends while the hop is still in
  // flight: the first session wait (the sender's turn) is short, every
  // later wait (the hop, then the synthesis pass) is long. This makes the
  // `awaitingChildren` hold deterministically observable instead of a race.
  let waits = 0
  ;(ctx.session as any).wait = async () => {
    waits++
    await new Promise((resolve) => setTimeout(resolve, waits === 1 ? 500 : 4000))
  }
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [nova.result.id, sage.result.id], leaderID: nova.result.id },
    })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Coordinate" } })
    const novaSession = await bindingSessionID(handlers, directory, nova.result.id)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const parent = Object.values(next.state.subtasks).find((task: any) => task.title === "Coordinate") as any
      if (!parent) return false
      return Object.values(next.state.runs ?? {}).some((run: any) => run.subtaskID === parent.id && run.status === "running")
    })
    const path = handoffFile(directory, "ask.md", "---\nensemble: handoff\ntask: Summarize the deploy\n---\n# Handoff\n")
    const asked = await tools.get("handoff").execute({ task: "Summarize the deploy", summary: "", path, to: "Sage" }, { sessionID: novaSession })
    assert.match(asked.content, /Handed to \$Sage/)
    // The sender's turn holds in awaitingChildren while the hop is in flight.
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const parent = Object.values(next.state.subtasks).find((task: any) => task.title === "Coordinate") as any
      return parent?.awaitingChildren === true
    })
    const waiting = await handlers.snapshot({ directory })
    const parent = Object.values(waiting.state.subtasks).find((task: any) => task.title === "Coordinate") as any
    const hop = Object.values(waiting.state.subtasks).find((task: any) => task.workKind === "handoff") as any
    assert.ok(hop)
    assert.equal(hop.parentID, parent.id)
    const derived = activityStateForTask(parent, {
      now: Date.now(),
      pendingApprovalIDs: new Set(),
      nativeBlockedIDs: new Set(),
      children: [hop],
      agentNameFor: (id) => (id === sage.result.id ? "Sage" : "Nova"),
    })
    assert.equal(derived.verb, "Waiting for $Sage…")
    assert.equal(derived.kind, "waiting")
    // A peer delegate after the handoff is refused (leader-only) — the hop
    // is the single queued effect, never double-queued under a second key.
    const sageSession = await bindingSessionID(handlers, directory, sage.result.id)
    const refused = await tools.get("delegate").execute({ assignee: "Nova", title: "Same work", instruction: "Check" }, { sessionID: sageSession })
    assert.match(refused.content, /Only the workspace leader/)
    // Both legs run to replied with exactly one hop row and one relay.
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).filter((task: any) => task.workKind === "handoff" && task.state === "replied").length === 1
    }, 15000)
    const after = await handlers.snapshot({ directory })
    assert.equal(Object.values(after.state.subtasks).filter((task: any) => task.workKind === "handoff").length, 1)
    const relayed = ((after.state.messages[workspace.result.id] ?? []) as any[]).filter(
      (message) => message.correlationID === hop.handoff.correlationID && message.agentID === sage.result.id && !message.streaming,
    )
    assert.equal(relayed.length, 1)
    for (const message of (after.state.messages[workspace.result.id] ?? []) as any[]) {
      assert.ok(!message.text.includes("@Sage") && !message.text.includes("@Nova"), `agent mention must use $Name syntax: ${message.text}`)
    }
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
