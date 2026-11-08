import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
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

function eventSource() {
  return {
    subscribe: async function* (options: any = {}) {
      const signal: AbortSignal | undefined = options?.signal
      if (!signal) return
      if (signal.aborted) return
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
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
      create: async ({ title }: any) => ({ data: { id: `session_${name}`, title } }),
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
    model: { list: async () => [{ providerID: "probe", id: "probe-model", name: "Probe", variants: [] }] },
    skill: { list: async () => [] },
    event: eventSource(),
  }

  return { name, directory, ctx, tools, rpcRegistrations, toolRegistrations, hookRegistrations, retryHooks }
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
    await alphaAttachment.dispose()

    assert.equal(alpha.rpcRegistrations[0].disposed, true, "the first location disposes its RPC registration")
    assert.equal(alpha.toolRegistrations[0].disposed, true, "the first location disposes its tool transform")
    assert.equal(alpha.hookRegistrations[0].disposed, true, "the first location disposes its retry hook")
    assert.equal(alpha.tools.size, 0, "a disposed location no longer contributes tools")

    assert.equal(beta.rpcRegistrations[0].disposed, false, "the other location keeps its RPC registration")
    assert.equal(beta.toolRegistrations[0].disposed, false, "the other location keeps its tool transform")
    assert.equal(beta.hookRegistrations[0].disposed, false, "the other location keeps its retry hook")
    assert.equal(beta.tools.size, 11, "the other location still contributes tools")
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
    assert.equal(stops.length, 1, "the failed location releases its service reference")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
