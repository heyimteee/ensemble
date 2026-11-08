import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EnsembleV2Service } from "./service.ts"
import { SharedEnsemble } from "./shared-service.ts"
import { V2Store } from "./store.ts"
import type { Agent, SessionBinding, Workspace } from "./types.ts"

type Registration = { dispose?: () => Promise<void> | void }

function inMemoryStorage(values: Map<string, unknown>) {
  return {
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
}

type EventSubscription = {
  types: string[]
  signal: AbortSignal | undefined
  queue: any[]
  wake: (() => void) | undefined
  done: boolean
}

/** One location's host event bus with abort-aware subscriptions and a test emit. */
function eventSource() {
  const subscriptions = new Set<EventSubscription>()
  const subscribe = async function* (options: any = {}) {
    const subscription: EventSubscription = {
      types: options?.types ?? [],
      signal: options?.signal,
      queue: [],
      wake: undefined,
      done: false,
    }
    subscriptions.add(subscription)
    const abort = () => {
      subscription.done = true
      subscription.wake?.()
    }
    subscription.signal?.addEventListener("abort", abort, { once: true })
    if (subscription.signal?.aborted) abort()
    try {
      while (!subscription.done) {
        if (subscription.queue.length === 0) await new Promise<void>((resolve) => { subscription.wake = resolve })
        while (!subscription.done && subscription.queue.length > 0) yield subscription.queue.shift()
      }
    } finally {
      subscription.signal?.removeEventListener("abort", abort)
      subscriptions.delete(subscription)
    }
  }
  return {
    subscribe,
    subscriptions,
    active: () => subscriptions.size,
    emit(value: any) {
      for (const subscription of subscriptions) {
        if (subscription.done) continue
        if (subscription.types.length > 0 && !subscription.types.includes(value.type)) continue
        subscription.queue.push(value)
        subscription.wake?.()
        subscription.wake = undefined
      }
    },
  }
}

/**
 * A host location as OpenCode presents it to one plugin setup: a directory, a
 * tool transform that owns its registration, an RPC registration, and a retry
 * hook. Registrations record their disposal so tests can prove per-location
 * cleanup.
 */
function fakeHost(name: string, directory: string, values = new Map<string, unknown>()) {
  const tools = new Map<string, any>()
  const rpcRegistrations: Array<Registration & { disposed: boolean; handlers: any }> = []
  const toolRegistrations: Array<Registration & { disposed: boolean }> = []
  const hookRegistrations: Array<Registration & { disposed: boolean }> = []
  const retryHooks: Array<(event: any) => void> = []
  const permissionReplies: any[] = []
  const events = eventSource()
  let models = [{ providerID: "probe", id: "probe-model", name: "Probe", variants: [] as string[] }]
  let modelListCalls = 0
  let sessions = 0

  const ctx = {
    onboarding: false,
    location: { directory },
    storage: inMemoryStorage(values),
    session: {
      hook: async (_name: string, callback: (event: any) => void) => {
        retryHooks.push(callback)
        const registration = {
          disposed: false,
          dispose: async () => { registration.disposed = true },
        }
        hookRegistrations.push(registration)
        return registration
      },
      create: async ({ title }: any) => ({ data: { id: `session_${name}_${++sessions}`, title } }),
      instructions: { entry: { put: async () => undefined } },
      switchModel: async () => undefined,
      prompt: async () => undefined,
      update: async () => undefined,
      wait: async () => undefined,
      context: async () => ({ data: [] }),
      interrupt: async () => undefined,
      remove: async () => undefined,
      move: async ({ sessionID }: any) => ({ data: { id: sessionID } }),
      command: async () => ({ data: {} }),
    },
    permission: {
      reply: async (input: any) => { permissionReplies.push(input) },
    },
    tool: {
      transform: async (factory: (editor: any) => void) => {
        factory({
          namespace: () => undefined,
          add: (tool: any) => { tools.set(tool.name, tool) },
        })
        const registration = {
          disposed: false,
          dispose: async () => {
            registration.disposed = true
            tools.clear()
          },
        }
        toolRegistrations.push(registration)
        return registration
      },
    },
    rpc: {
      register: async (_definition: unknown, handlers: any) => {
        const registration = {
          handlers,
          disposed: false,
          events: { emit: async () => undefined },
          dispose: async () => { registration.disposed = true },
        }
        rpcRegistrations.push(registration)
        return registration
      },
    },
    model: { list: async () => { modelListCalls += 1; return models.map((model) => ({ ...model, variants: [...model.variants] })) } },
    skill: { list: async () => [] },
    event: events,
  }

  return {
    name,
    directory,
    ctx,
    tools,
    rpcRegistrations,
    toolRegistrations,
    hookRegistrations,
    retryHooks,
    permissionReplies,
    events,
    setModels(next: Array<{ providerID: string; id: string; name: string; variants?: string[] }>) {
      models = next.map((model) => ({ ...model, variants: model.variants ?? [] }))
    },
    get modelListCalls() { return modelListCalls },
  }
}

function serviceRegistry() {
  const starts: EnsembleV2Service[] = []
  const stops: EnsembleV2Service[] = []
  const registry = new SharedEnsemble(async (ctx) => {
    const service = new EnsembleV2Service(ctx)
    const stop = await service.start()
    starts.push(service)
    return {
      service,
      stop: async () => {
        stops.push(service)
        await stop()
      },
    }
  })
  return { registry, starts, stops }
}

const agent: Agent = {
  id: "a",
  name: "Nova",
  title: "",
  role: "",
  mainModel: { providerID: "probe", modelID: "probe-model" },
  backupModels: [],
  skillbox: [],
  color: "cyan",
  archived: false,
  pendingSettings: false,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
}

function workspace(id: string, name: string, directory: string): Workspace {
  return {
    id,
    name,
    directory,
    leaderID: "a",
    memberIDs: ["a"],
    synthesis: true,
    archived: false,
    paused: false,
    nextSeq: 1,
    createdAt: 1,
    lastActiveAt: 1,
  }
}

function binding(workspaceID: string, sessionID: string, directory: string): SessionBinding {
  return { workspaceID, agentID: "a", sessionID, kind: "workspace", directory, agentVersion: 1, updatedAt: 1 }
}

async function waitFor(check: () => Promise<boolean> | boolean, timeout = 3000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for condition")
}

test("two host locations each install the Ensemble tools and execute against their own binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-locations-"))
  const alphaDirectory = join(root, "alpha")
  const betaDirectory = join(root, "beta")
  const values = new Map<string, unknown>()
  const alpha = fakeHost("alpha", alphaDirectory, values)
  const beta = fakeHost("beta", betaDirectory)

  const seed = new V2Store(alpha.ctx as any)
  await seed.load()
  await seed.saveAgent(agent)
  await seed.saveWorkspace(workspace("wa", "alpha", alphaDirectory))
  await seed.saveWorkspace(workspace("wb", "beta", betaDirectory))
  await seed.saveBinding(binding("wa", "ses_alpha", alphaDirectory))
  await seed.saveBinding(binding("wb", "ses_beta", betaDirectory))

  const { registry, starts, stops } = serviceRegistry()
  const alphaAttachment = await registry.attach(alpha.ctx)
  const betaAttachment = await registry.attach(beta.ctx)
  try {
    assert.equal(starts.length, 1, "two locations share one realm service")
    assert.equal(alphaAttachment.service, betaAttachment.service)
    assert.equal(alphaAttachment.directory, alphaDirectory)
    assert.equal(betaAttachment.directory, betaDirectory)

    assert.equal(alpha.tools.size, 11, "the first location installs its own tool transform")
    assert.equal(beta.tools.size, 11, "the second location installs its own tool transform")

    const fromAlpha = JSON.parse((await alpha.tools.get("workspace_info").execute({}, { sessionID: "ses_alpha" })).content)
    const fromBeta = JSON.parse((await beta.tools.get("workspace_info").execute({}, { sessionID: "ses_beta" })).content)
    assert.equal(fromAlpha.workspace, "alpha")
    assert.equal(fromAlpha.directory, alphaDirectory)
    assert.equal(fromBeta.workspace, "beta", "a non-first location executes with its own session binding")
    assert.equal(fromBeta.directory, betaDirectory)
  } finally {
    await alphaAttachment.dispose()
    await betaAttachment.dispose()
    rmSync(root, { recursive: true, force: true })
  }
  assert.equal(stops.length, 1)
})

test("disposing one location removes only its registrations and keeps the shared service up", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-locations-"))
  const values = new Map<string, unknown>()
  const alpha = fakeHost("alpha", join(root, "alpha"), values)
  const beta = fakeHost("beta", join(root, "beta"))

  const seed = new V2Store(alpha.ctx as any)
  await seed.load()
  await seed.saveAgent(agent)
  await seed.saveWorkspace(workspace("wa", "alpha", join(root, "alpha")))
  await seed.saveWorkspace(workspace("wb", "beta", join(root, "beta")))
  await seed.saveBinding(binding("wa", "ses_alpha", join(root, "alpha")))
  await seed.saveBinding(binding("wb", "ses_beta", join(root, "beta")))

  const { registry, stops } = serviceRegistry()
  const alphaAttachment = await registry.attach(alpha.ctx)
  const betaAttachment = await registry.attach(beta.ctx)
  try {
    assert.ok(alpha.events.active() > 0, "the first location subscribes to its host event stream")
    assert.ok(beta.events.active() > 0, "the second location subscribes to its host event stream")
    await alphaAttachment.dispose()

    assert.equal(alpha.rpcRegistrations[0].disposed, true, "the first location disposes its RPC registration")
    assert.equal(alpha.toolRegistrations[0].disposed, true, "the first location disposes its tool transform")
    assert.equal(alpha.hookRegistrations[0].disposed, true, "the first location disposes its retry hook")
    assert.equal(alpha.tools.size, 0, "a disposed location no longer contributes tools")
    await waitFor(() => alpha.events.active() === 0)
    assert.equal(alpha.events.subscriptions.size, 0, "the first location's event subscriptions are aborted")

    assert.equal(beta.rpcRegistrations[0].disposed, false, "the other location keeps its RPC registration")
    assert.equal(beta.toolRegistrations[0].disposed, false, "the other location keeps its tool transform")
    assert.equal(beta.hookRegistrations[0].disposed, false, "the other location keeps its retry hook")
    assert.equal(beta.tools.size, 11, "the other location still contributes tools")
    assert.ok(beta.events.active() > 0, "the other location keeps its event subscriptions")
    assert.equal(stops.length, 0, "the service stays up while another location remains")

    const stillWorks = JSON.parse((await beta.tools.get("workspace_info").execute({}, { sessionID: "ses_beta" })).content)
    assert.equal(stillWorks.workspace, "beta")

    await alphaAttachment.dispose()
    assert.equal(alpha.rpcRegistrations.length, 1, "a repeated dispose is a no-op")
    assert.equal(alpha.toolRegistrations.length, 1)
    assert.equal(alpha.hookRegistrations.length, 1)

    await betaAttachment.dispose()
    assert.equal(beta.toolRegistrations[0].disposed, true)
    assert.equal(beta.rpcRegistrations[0].disposed, true)
    assert.equal(beta.hookRegistrations[0].disposed, true)
    await waitFor(() => beta.events.active() === 0)
    assert.equal(stops.length, 1, "the service stops after the last location releases")
  } finally {
    await alphaAttachment.dispose()
    await betaAttachment.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test("a failed attach disposes the registrations it already created and releases the service", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-locations-"))
  const alpha = fakeHost("alpha", join(root, "alpha"))
  alpha.ctx.tool.transform = async (factory: (editor: any) => void) => {
    void factory
    throw new Error("tool transform unavailable")
  }

  const { registry, stops } = serviceRegistry()
  try {
    await assert.rejects(() => registry.attach(alpha.ctx), /tool transform unavailable/)
    assert.equal(alpha.rpcRegistrations[0].disposed, true, "the partial RPC registration is disposed")
    await waitFor(() => alpha.events.active() === 0)
    assert.equal(stops.length, 1, "the failed location releases its service reference")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a text delta from the second location reaches the service once", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-locations-"))
  const alphaDirectory = join(root, "alpha")
  const betaDirectory = join(root, "beta")
  const values = new Map<string, unknown>()
  const alpha = fakeHost("alpha", alphaDirectory, values)
  const beta = fakeHost("beta", betaDirectory, values)
  mkdirSync(alphaDirectory, { recursive: true })
  mkdirSync(betaDirectory, { recursive: true })
  let releaseWait: (() => void) | undefined
  const parked = new Promise<void>((resolve) => { releaseWait = resolve })
  alpha.ctx.session.wait = async () => { await parked }

  const { registry } = serviceRegistry()
  const alphaAttachment = await registry.attach(alpha.ctx)
  const betaAttachment = await registry.attach(beta.ctx)
  const handlers = alphaAttachment.service.handlers()
  try {
    const agent = await handlers.invoke({ directory: betaDirectory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({
      directory: betaDirectory,
      action: "workspace.create",
      payload: { name: "beta", directory: betaDirectory, memberIDs: [agent.result.id], leaderID: agent.result.id },
    })
    const workspaceID = workspace.result.id
    await handlers.invoke({ directory: betaDirectory, action: "message.send", payload: { workspaceID, text: "Hello from beta" } })

    let sessionID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory: betaDirectory })
      const run = Object.values(next.state.runs).find((item: any) => item.status === "running") as any
      sessionID = run?.sessionID ?? ""
      const message = (next.state.messages[workspaceID] ?? []).find((item: any) => item.streaming)
      return Boolean(sessionID && message)
    })

    const delta = {
      id: "evt_delta_beta_1",
      created: 1,
      type: "session.text.delta",
      data: { sessionID, assistantMessageID: "assistant_1", ordinal: 1, delta: "From B" },
    }
    beta.events.emit(delta)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory: betaDirectory })
      const message = (next.state.messages[workspaceID] ?? []).find((item: any) => item.streaming)
      return message?.text === "From B"
    })

    // A global host bus can deliver the same event to every location. The realm
    // claims the event id first, so the live buffer receives it exactly once.
    alpha.events.emit(delta)
    beta.events.emit(delta)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const after = await handlers.snapshot({ directory: betaDirectory })
    const streamed = (after.state.messages[workspaceID] ?? []).find((item: any) => item.streaming)
    assert.equal(streamed?.text, "From B", "duplicate global delivery does not append the delta twice")
  } finally {
    releaseWait?.()
    await alphaAttachment.dispose()
    await betaAttachment.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test("a permission event from the second location mirrors and resolves through that location", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-locations-"))
  const alphaDirectory = join(root, "alpha")
  const betaDirectory = join(root, "beta")
  const values = new Map<string, unknown>()
  const alpha = fakeHost("alpha", alphaDirectory, values)
  const beta = fakeHost("beta", betaDirectory, values)
  mkdirSync(alphaDirectory, { recursive: true })
  mkdirSync(betaDirectory, { recursive: true })

  const seed = new V2Store(alpha.ctx as any)
  await seed.load()
  await seed.saveAgent(agent)
  await seed.saveWorkspace(workspace("wb", "beta", betaDirectory))
  await seed.saveBinding(binding("wb", "ses_beta", betaDirectory))

  const { registry } = serviceRegistry()
  const alphaAttachment = await registry.attach(alpha.ctx)
  const betaAttachment = await registry.attach(beta.ctx)
  const handlers = alphaAttachment.service.handlers()
  try {
    beta.events.emit({
      id: "evt_permission_beta_1",
      created: 2,
      type: "permission.asked",
      data: { sessionID: "ses_beta", id: "perm_beta_1", action: "shell", resources: ["echo hi"] },
    })

    let native: any
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory: betaDirectory })
      native = Object.values(next.state.approvals).find((approval: any) => approval.status === "pending" && approval.kind === "native")
      return Boolean(native)
    })
    assert.equal(native.payload.sessionID, "ses_beta")
    assert.equal(native.payload.permissionID, "perm_beta_1")

    const resolved = await handlers.invoke({ directory: betaDirectory, action: "approval.resolve", payload: { id: native.id, approve: true } })
    assert.equal(resolved.ok, true)
    assert.equal(beta.permissionReplies.length, 1, "the owning location replies on the host permission request")
    assert.deepEqual(beta.permissionReplies[0], { sessionID: "ses_beta", requestID: "perm_beta_1", decision: "once" })
    assert.equal(alpha.permissionReplies.length, 0, "the first context is not used as a permission proxy")
  } finally {
    await alphaAttachment.dispose()
    await betaAttachment.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test("config, file, and catalog events from the second location are handled", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-locations-"))
  const alphaDirectory = join(root, "alpha")
  const betaDirectory = join(root, "beta")
  const values = new Map<string, unknown>()
  const alpha = fakeHost("alpha", alphaDirectory, values)
  const beta = fakeHost("beta", betaDirectory, values)
  mkdirSync(alphaDirectory, { recursive: true })
  mkdirSync(betaDirectory, { recursive: true })

  const seed = new V2Store(alpha.ctx as any)
  await seed.load()
  await seed.saveAgent(agent)

  const { registry } = serviceRegistry()
  const alphaAttachment = await registry.attach(alpha.ctx)
  const betaAttachment = await registry.attach(beta.ctx)
  const handlers = alphaAttachment.service.handlers()
  try {
    // The first snapshot settles the startup catalog against the first
    // location before the second location's update arrives.
    await handlers.snapshot({ directory: betaDirectory })

    mkdirSync(join(betaDirectory, ".ensemble"), { recursive: true })
    writeFileSync(join(betaDirectory, ".ensemble", "config.json"), JSON.stringify({
      version: 1, name: "Eventful", leader: "Nova", members: ["Nova"], synthesis: true, paused: false,
    }))
    beta.events.emit({ id: "evt_file_beta_1", created: 3, type: "file.edited", data: { file: join(betaDirectory, ".ensemble", "config.json") } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory: betaDirectory })
      return Object.values(next.state.workspaces).some((item: Workspace) => item.name === "Eventful")
    })

    beta.setModels([{ providerID: "probe", id: "beta-model", name: "Beta model", variants: [] }])
    const before = beta.modelListCalls
    beta.events.emit({ id: "evt_model_beta_1", created: 4, type: "model.updated", data: {} })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory: betaDirectory })
      return next.models.some((model: any) => model.modelID === "beta-model")
    })
    assert.ok(beta.modelListCalls > before, "the catalog refreshed from the second location")
  } finally {
    await alphaAttachment.dispose()
    await betaAttachment.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test("the second location's retry hook applies the realm policy once", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-locations-"))
  const values = new Map<string, unknown>()
  const alpha = fakeHost("alpha", join(root, "alpha"), values)
  const beta = fakeHost("beta", join(root, "beta"), values)
  mkdirSync(alpha.directory, { recursive: true })
  mkdirSync(beta.directory, { recursive: true })

  const { registry } = serviceRegistry()
  const alphaAttachment = await registry.attach(alpha.ctx)
  const betaAttachment = await registry.attach(beta.ctx)
  try {
    alphaAttachment.service.registerLocalRunForTest({
      id: "run_beta",
      sessionID: "ses_beta",
      workspaceID: "wb",
      agentID: "a",
      subtaskID: "task_beta",
      status: "running",
    } as any)

    let decision: any = { retry: true, delay: 1 }
    let decisions = 0
    const event = {
      sessionID: "ses_beta",
      attempt: 2,
      error: { type: "provider.internal", message: "server unavailable" },
      get decision() { return decision },
      set decision(value: any) { decisions += 1; decision = value },
    }
    beta.retryHooks[0](event)
    alpha.retryHooks[0](event)

    assert.equal(decisions, 1, "a global hook bus applies the policy once")
    assert.deepEqual(decision, { retry: false })
  } finally {
    await alphaAttachment.dispose()
    await betaAttachment.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test("ticket155: each location subscribes to native tool and execution activity", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-155-location-events-"))
  const host = fakeHost("activity", join(root, "activity"))
  const { registry } = serviceRegistry()
  const attachment = await registry.attach(host.ctx)
  try {
    const types = [...host.events.subscriptions].flatMap((subscription) => subscription.types)
    for (const type of [
      "session.tool.input.started",
      "session.tool.called",
      "session.tool.progress",
      "session.tool.success",
      "session.tool.failed",
      "session.execution.started",
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
    ]) {
      assert.ok(types.includes(type), `${type} is subscribed per location`)
    }
  } finally {
    await attachment.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
