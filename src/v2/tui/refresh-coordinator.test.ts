import test from "node:test"
import assert from "node:assert/strict"
import {
  createRefreshCoordinator,
  decideSnapshotApply,
  heartbeatDelay,
  revisionChanged,
  type SnapshotMeta,
} from "./refresh-coordinator.ts"

const meta = (value: Partial<SnapshotMeta> & { version: number }): SnapshotMeta => ({
  catalogRevision: 1,
  configRevision: 1,
  protocol: 1,
  epoch: 1,
  directory: "/tmp/ensemble",
  ...value,
})

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

test("a burst of requests runs one refresh and one queued dirty pass", async () => {
  let calls = 0
  let release!: () => void
  const firstRun = new Promise<void>((resolve) => { release = resolve })
  const coordinator = createRefreshCoordinator({
    run: async () => {
      calls++
      if (calls === 1) await firstRun
    },
  })

  coordinator.request()
  coordinator.request()
  coordinator.request()

  assert.equal(calls, 1, "only one refresh may be in flight")
  assert.equal(coordinator.inFlight(), true)
  assert.equal(coordinator.pending(), true, "the burst collapses into one dirty pass")

  release()
  await coordinator.whenIdle()

  assert.equal(calls, 2, "the queued dirty pass runs once")
  assert.equal(coordinator.inFlight(), false)
  assert.equal(coordinator.pending(), false)
})

test("a slow fetch keeps running to completion and the latest requested pass still applies", async () => {
  const completed: number[] = []
  let calls = 0
  const coordinator = createRefreshCoordinator({
    run: async () => {
      const call = ++calls
      await new Promise<void>((resolve) => setTimeout(resolve, call === 1 ? 20 : 1))
      completed.push(call)
    },
  })

  coordinator.request()
  await tick()
  coordinator.request()
  coordinator.request()
  await coordinator.whenIdle()

  assert.deepEqual(completed, [1, 2], "an in-flight response is not discarded by a later request")
  assert.equal(calls, 2)
})

test("pausing queues one dirty pass and resumes it once", async () => {
  let calls = 0
  const coordinator = createRefreshCoordinator({ run: () => { calls++ } })

  coordinator.setPaused(true)
  coordinator.request()
  coordinator.request()
  await coordinator.whenIdle()
  assert.equal(calls, 0, "a hidden route starts no refresh")

  coordinator.setPaused(false)
  await coordinator.whenIdle()
  assert.equal(calls, 1, "activation resumes one coalesced refresh")
  assert.equal(coordinator.pending(), false)
})

test("an in-flight refresh finishes while paused but starts no follow-up pass", async () => {
  let calls = 0
  let release!: () => void
  const firstRun = new Promise<void>((resolve) => { release = resolve })
  const coordinator = createRefreshCoordinator({
    run: async () => {
      calls++
      await firstRun
    },
  })

  coordinator.request()
  coordinator.setPaused(true)
  coordinator.request()
  release()
  await coordinator.whenIdle()

  assert.equal(calls, 1)
  assert.equal(coordinator.pending(), true, "the hidden pass waits for activation")

  coordinator.setPaused(false)
  await coordinator.whenIdle()
  assert.equal(calls, 2)
})

test("an unchanged version never replaces entity state, but a metadata revision still applies", () => {
  assert.equal(decideSnapshotApply(undefined, meta({ version: 3 })), "replace")

  assert.equal(decideSnapshotApply(meta({ version: 3 }), meta({ version: 4 })), "replace")
  assert.equal(decideSnapshotApply(meta({ version: 4 }), meta({ version: 3 })), "skip")
  assert.equal(decideSnapshotApply(meta({ version: 3 }), meta({ version: 3 })), "skip")

  assert.equal(
    decideSnapshotApply(meta({ version: 3, catalogRevision: 1 }), meta({ version: 3, catalogRevision: 2 })),
    "metadata",
  )
  assert.equal(
    decideSnapshotApply(meta({ version: 3, configRevision: 1 }), meta({ version: 3, configRevision: 2 })),
    "metadata",
  )
  assert.equal(
    decideSnapshotApply(meta({ version: 3, configError: undefined }), meta({ version: 3, configError: "bad config" })),
    "metadata",
  )
})

test("a new server epoch replaces even when the restarted store version is lower", () => {
  assert.equal(decideSnapshotApply(meta({ version: 12, epoch: 1 }), meta({ version: 1, epoch: 2 })), "replace")
})

test("the revision check ignores an unchanged metadata revision and accepts catalog or config changes", () => {
  const previous = meta({ version: 7, catalogRevision: 2, configRevision: 4 })
  assert.equal(revisionChanged(previous, { version: 7, catalogRevision: 2, configRevision: 4, protocol: 1, epoch: 1 }), false)
  assert.equal(revisionChanged(previous, { version: 8, catalogRevision: 2, configRevision: 4, protocol: 1, epoch: 1 }), true)
  assert.equal(revisionChanged(previous, { version: 7, catalogRevision: 3, configRevision: 4, protocol: 1, epoch: 1 }), true)
  assert.equal(revisionChanged(previous, { version: 7, catalogRevision: 2, configRevision: 5, protocol: 1, epoch: 1 }), true)
  assert.equal(revisionChanged(previous, { version: 7, catalogRevision: 2, configRevision: 4, protocol: 2, epoch: 1 }), true)
  assert.equal(revisionChanged(previous, { version: 7, catalogRevision: 2, configRevision: 4, protocol: 1, epoch: 2 }), true)
})

test("the heartbeat is cheap when idle and faster while work is live", () => {
  assert.equal(heartbeatDelay(false), 2000)
  assert.equal(heartbeatDelay(true), 1000)
})
