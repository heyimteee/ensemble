import test from "node:test"
import assert from "node:assert/strict"
import plugin from "./server.ts"
import { SharedEnsemble, SHARED_SERVICE_VERSION, resetSharedEnsembleForTests, sharedEnsemble } from "./shared-service.ts"

const REGISTRY_KEY = Symbol.for("ensemble.v2.shared-service")

function installRegistry(value: unknown): void {
  ;(globalThis as any)[REGISTRY_KEY] = value
}

type FakeService = { name: string }

function registryHarness() {
  const created: Array<{ ctx: any; service: FakeService }> = []
  const stopped: FakeService[] = []
  const factory = async (ctx: any) => {
    const service = { name: `service-${created.length + 1}` }
    created.push({ ctx, service })
    return { service: service as any, stop: async () => { stopped.push(service) } }
  }
  return { factory, created, stopped }
}

function locations() {
  return [
    { name: "project" },
    ...Array.from({ length: 4 }, (_, index) => ({ name: `channel-${index + 1}` })),
    ...Array.from({ length: 8 }, (_, index) => ({ name: `agent-${index + 1}` })),
  ]
}

test("a shared registry starts one service and stops it after the last release", async () => {
  const harness = registryHarness()
  const registry = new SharedEnsemble(harness.factory)
  const contexts = locations()
  const acquired = []
  for (const ctx of contexts) acquired.push(await registry.acquire(ctx))

  assert.equal(harness.created.length, 1, "one service starts for project + 4 channels + 8 agents")
  assert.equal(harness.created[0].ctx, contexts[0], "the first location owns the service context")
  const service = acquired[0].service
  for (const entry of acquired) assert.equal(entry.service, service)

  for (const entry of acquired.slice(0, -1)) await entry.release()
  assert.equal(harness.stopped.length, 0, "the service stays up while any location holds a reference")

  await acquired.at(-1)!.release()
  assert.deepEqual(harness.stopped, [harness.created[0].service], "the last release stops the service once")

  await acquired.at(-1)!.release()
  assert.equal(harness.stopped.length, 1, "a repeated release does not stop the service again")
})

test("sharedEnsemble keeps one registry across every host location", async (t) => {
  resetSharedEnsembleForTests()
  t.after(resetSharedEnsembleForTests)
  const harness = registryHarness()
  installRegistry(new SharedEnsemble(harness.factory))

  const registry = sharedEnsemble()
  const contexts = locations()
  const acquired = []
  for (const ctx of contexts) acquired.push(await registry.acquire(ctx))

  assert.equal(sharedEnsemble(), registry, "every location load sees the same process-global registry")
  assert.equal(harness.created.length, 1, "one service starts for project + 4 channels + 8 agents")
  assert.equal(harness.created[0].ctx, contexts[0], "the first location owns the service context")
  assert.equal(new Set(acquired.map((entry) => entry.service)).size, 1)

  for (const entry of acquired.slice(0, -1)) await entry.release()
  assert.equal(harness.stopped.length, 0)

  await acquired.at(-1)!.release()
  assert.equal(harness.stopped.length, 1, "the service stops only after the last release")
})

test("the global registry is versioned and reused structurally across module copies", async (t) => {
  resetSharedEnsembleForTests()
  t.after(resetSharedEnsembleForTests)

  const foreign = { version: SHARED_SERVICE_VERSION, acquire: async () => ({ service: {} as any, release: async () => {} }), attach: async () => ({}) }
  installRegistry(foreign)
  assert.equal(sharedEnsemble(), foreign, "a structurally compatible registry wins over class identity")

  const harness = registryHarness()
  const old = new SharedEnsemble(harness.factory, SHARED_SERVICE_VERSION - 1)
  const held = await old.acquire({ name: "old-location" })
  installRegistry(old)

  const current = sharedEnsemble()
  assert.notEqual(current, old, "a version change starts a new registry instead of reusing the old contract")
  assert.equal(current.version, SHARED_SERVICE_VERSION)

  await held.release()
  assert.deepEqual(harness.stopped, [harness.created[0].service], "the old registry stops when its last old ref releases")
})

test("a module cache-busted import returns the same process-global registry", async (t) => {
  resetSharedEnsembleForTests()
  t.after(resetSharedEnsembleForTests)

  const specifier = (version: string) => new URL(`./shared-service.ts?${version}`, import.meta.url).href
  const one = await import(specifier("v=one"))
  const two = await import(specifier("v=two"))

  assert.notEqual(one.SharedEnsemble, two.SharedEnsemble, "the query string forces a second module evaluation")
  assert.equal(one.sharedEnsemble(), two.sharedEnsemble(), "both module copies see the same globalThis registry")
})

test("an acquire during final teardown waits for stop and creates one replacement", async () => {
  let releaseStop: () => void = () => {}
  const stopGate = new Promise<void>((resolve) => { releaseStop = resolve })
  const events: string[] = []
  let starts = 0
  const services: FakeService[] = []
  const registry = new SharedEnsemble(async () => {
    starts += 1
    const service = { name: `service-${starts}` }
    services.push(service)
    events.push(`start:${service.name}`)
    return {
      service: service as any,
      stop: async () => {
        events.push(`stop:start:${service.name}`)
        await stopGate
        events.push(`stop:end:${service.name}`)
      },
    }
  })

  const first = await registry.acquire({ name: "first" })
  const stopping = first.release()
  const secondA = registry.acquire({ name: "second-a" })
  const secondB = registry.acquire({ name: "second-b" })

  await Promise.resolve()
  assert.equal(starts, 1, "no replacement starts while the old service is still stopping")

  releaseStop()
  await stopping
  const [a, b] = await Promise.all([secondA, secondB])

  assert.equal(starts, 2, "concurrent acquires coalesce onto exactly one replacement")
  assert.equal(a.service, b.service)
  assert.equal(a.service, services[services.length - 1])
  assert.deepEqual(events, [
    "start:service-1",
    "stop:start:service-1",
    "stop:end:service-1",
    "start:service-2",
  ], "the old service finishes stopping before the replacement starts")

  await a.release()
  await b.release()
})


test("an acquire already awaiting the entry never joins its teardown", async () => {
  let releaseStop: () => void = () => {}
  const stopGate = new Promise<void>((resolve) => { releaseStop = resolve })
  let starts = 0
  const services: FakeService[] = []
  const registry = new SharedEnsemble(async () => {
    starts += 1
    const service = { name: `service-${starts}` }
    services.push(service)
    return {
      service: service as any,
      stop: async () => {
        await stopGate
      },
    }
  })

  const first = await registry.acquire({ name: "first" })
  // This acquire is already parked on the resolved pending entry when the
  // last release clears it and begins teardown.
  let secondSettled = false
  const secondPromise = registry.acquire({ name: "second" }).finally(() => { secondSettled = true })
  const stopping = first.release()

  await Promise.resolve()
  assert.equal(secondSettled, false, "the parked acquire waits for the old service to finish stopping")
  assert.equal(starts, 1, "it must not join the stopping entry")

  releaseStop()
  await stopping
  const second = await secondPromise

  assert.equal(starts, 2, "the parked acquire starts one replacement after teardown")
  assert.notEqual(second.service, first.service)
  assert.equal(second.service, services[services.length - 1])
  await second.release()
})

test("every location registers and disposes its own host surfaces against the one service", async (t) => {
  resetSharedEnsembleForTests()
  t.after(resetSharedEnsembleForTests)

  let starts = 0
  let stops = 0
  const attached: any[] = []
  const detached: any[] = []
  const toolRegistrations: any[] = []
  const hookRegistrations: any[] = []
  const service = {
    handlers: () => ({ fake: true }),
    attach: (registration: any) => { attached.push(registration) },
    detach: (registration: any) => { detached.push(registration) },
    installToolsFor: async (ctx: any) => {
      const registration = { kind: "tools", ctx, disposed: false, dispose: async () => { registration.disposed = true } }
      toolRegistrations.push(registration)
      return registration
    },
    installRetryHook: async (ctx: any) => {
      const registration = { kind: "retry", ctx, disposed: false, dispose: async () => { registration.disposed = true } }
      hookRegistrations.push(registration)
      return registration
    },
  }
  installRegistry(new SharedEnsemble(async () => {
    starts += 1
    return { service: service as any, stop: async () => { stops += 1 } }
  }))

  const registrations: any[] = []
  const contexts = locations().map((location) => ({
    ...location,
    rpc: {
      register: async (definition: unknown, handlers: unknown) => {
        const registration = {
          definition,
          handlers,
          events: { emit: async () => undefined },
          dispose: async () => { registration.disposed = true },
          disposed: false,
        }
        registrations.push(registration)
        return registration
      },
    },
    tool: { transform: async () => ({ dispose: async () => undefined }) },
    session: { hook: async () => ({ dispose: async () => undefined }) },
  }))

  const cleanups: Array<() => Promise<void>> = []
  for (const ctx of contexts) cleanups.push(await plugin.setup(ctx as any) as () => Promise<void>)

  assert.equal(starts, 1, "the host starts one service for all locations")
  assert.equal(registrations.length, 13, "every location registers its own RPC handlers")
  assert.equal(attached.length, 13)
  assert.deepEqual(registrations.map((registration) => registration.handlers), Array.from({ length: 13 }, () => ({ fake: true })))
  assert.equal(toolRegistrations.length, 13, "every location installs its own tool transform")
  assert.equal(hookRegistrations.length, 13, "every location installs its own retry hook")
  assert.deepEqual(toolRegistrations.map((registration) => registration.ctx), contexts)
  assert.deepEqual(hookRegistrations.map((registration) => registration.ctx), contexts)

  for (const cleanup of cleanups.slice(0, -1)) await cleanup()
  assert.equal(registrations.filter((registration) => registration.disposed).length, 12, "each location disposes its own registration")
  assert.equal(toolRegistrations.filter((registration) => registration.disposed).length, 12, "each location disposes its own tool transform")
  assert.equal(hookRegistrations.filter((registration) => registration.disposed).length, 12, "each location disposes its own retry hook")
  assert.equal(detached.length, 12)
  assert.equal(stops, 0, "the service stays up while a location remains")

  await cleanups.at(-1)!()
  assert.equal(registrations.every((registration) => registration.disposed), true)
  assert.equal(toolRegistrations.every((registration) => registration.disposed), true)
  assert.equal(hookRegistrations.every((registration) => registration.disposed), true)
  assert.equal(detached.length, 13)
  assert.equal(stops, 1, "the last location release stops the service")
})
