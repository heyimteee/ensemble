import test from "node:test"
import assert from "node:assert/strict"
import { FILE_INDEX_MAX_FILES, createFileIndex, fileIndexArguments, parseFileIndexOutput } from "./file-index.ts"

/**
 * File-completion index seam (ticket #176).
 *
 * Discovery is injected, so these tests own the clock and the scheduler. That
 * makes cache hits, stale-while-refresh, and the bounded refresh rate
 * deterministic without sleeping or touching the real filesystem.
 */

type Scheduled = { at: number; run: () => void }

function manualClock(start = 1_000) {
  let current = start
  let sequence = 0
  const jobs = new Map<number, Scheduled>()
  return {
    now: () => current,
    schedule: (run: () => void, delayMs: number) => {
      const id = ++sequence
      jobs.set(id, { at: current + delayMs, run })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    cancel: (handle: ReturnType<typeof setTimeout>) => {
      jobs.delete(handle as unknown as number)
    },
    setNow: (value: number) => {
      current = value
    },
    pending: () => jobs.size,
    async advance(ms: number) {
      current += ms
      const due = [...jobs.entries()]
        .filter(([, job]) => job.at <= current)
        .sort((left, right) => left[1].at - right[1].at)
      for (const [id, job] of due) {
        jobs.delete(id)
        job.run()
      }
      await flush()
    },
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test("file discovery keeps the exclusions, depth cap, spaces, and a bounded sorted list", async () => {
  assert.deepEqual(fileIndexArguments(), [
    "--type", "f", "--hidden",
    "--exclude", ".git",
    "--exclude", ".ensemble",
    "--exclude", "node_modules",
    "--max-depth", "4",
    ".",
  ])
  assert.ok(!fileIndexArguments().some((argument) => argument === "--git" || argument.startsWith("--git-ignore")), "staging state never filters discovery")

  const output = [
    ".hidden",
    "docs/my notes.md",
    "src/a.ts",
    "src/b c.ts",
    "./src/a.ts",
    ".git/HEAD",
    ".ensemble/config.json",
    "node_modules/pkg/index.js",
    "docs/a/b/d.txt",
    "docs/a/b/c/e.txt",
    "../escape.ts",
    "/absolute.ts",
    "",
  ].join("\n")

  assert.deepEqual(parseFileIndexOutput(output), [
    ".hidden",
    "docs/a/b/d.txt",
    "docs/my notes.md",
    "src/a.ts",
    "src/b c.ts",
  ])
  assert.deepEqual(parseFileIndexOutput(output, { maxFiles: 2 }), [".hidden", "docs/a/b/d.txt"])
  assert.deepEqual(parseFileIndexOutput("src\\windows\\file.ts\n", {}), ["src/windows/file.ts"])
  assert.ok(parseFileIndexOutput(Array.from({ length: FILE_INDEX_MAX_FILES + 100 }, (_value, position) => `f/${String(position).padStart(4, "0")}.ts`).join("\n")).length === FILE_INDEX_MAX_FILES)
})

test("a stale cache renders immediately and refreshes in the background", async () => {
  const clock = manualClock()
  let next: ReturnType<typeof deferred<string[]>> | undefined
  let discoveries = 0
  const updates: string[] = []
  const index = createFileIndex({
    discover: () => {
      discoveries++
      return next ? next.promise : Promise.resolve(["old.ts"])
    },
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    onUpdate: (workspaceID) => updates.push(workspaceID),
  })

  index.ensure("workspace-a", "/repo/a")
  await index.whenIdle()
  updates.length = 0
  assert.deepEqual(index.paths("workspace-a", "/repo/a"), ["old.ts"])

  clock.setNow(clock.now() + 31_000)
  next = deferred<string[]>()
  assert.deepEqual(index.paths("workspace-a", "/repo/a"), ["old.ts"], "the stale list is still synchronous")
  assert.deepEqual(index.paths("workspace-a", "/repo/a"), ["old.ts"])
  assert.equal(discoveries, 2, "stale access starts exactly one refresh")

  next.resolve(["new.ts", "old.ts"])
  await index.whenIdle()
  assert.deepEqual(index.paths("workspace-a", "/repo/a"), ["new.ts", "old.ts"])
  assert.deepEqual(updates, ["workspace-a"], "the landed refresh tells an open palette to repaint")

  clock.setNow(clock.now() + 31_000)
  next = deferred<string[]>()
  index.paths("workspace-a", "/repo/a")
  next.reject(new Error("fd disappeared"))
  await index.whenIdle()
  assert.deepEqual(index.paths("workspace-a", "/repo/a"), ["new.ts", "old.ts"], "a failed refresh never erases the last good list")
})

test("explicit refreshes coalesce into one discovery per rate window", async () => {
  const clock = manualClock()
  let discoveries = 0
  const index = createFileIndex({
    discover: async () => {
      discoveries++
      return ["src/a.ts"]
    },
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    refreshIntervalMs: 1_000,
  })

  index.ensure("workspace-a", "/repo/a")
  await index.whenIdle()
  assert.equal(discoveries, 1)

  const refreshes = [index.refresh("workspace-a", "/repo/a")]
  for (let press = 0; press < 20; press++) refreshes.push(index.refresh("workspace-a", "/repo/a"))
  assert.equal(discoveries, 1, "an explicit refresh never starts inside the rate window")
  assert.equal(clock.pending(), 1, "a burst of explicit refreshes keeps one trailing timer")

  await clock.advance(1_000)
  await Promise.all(refreshes)
  await index.whenIdle()
  assert.equal(discoveries, 2, "the burst collapses into one guaranteed refresh")
})

test("the workspace cache is bounded and evicts the least recently used root", async () => {
  const clock = manualClock()
  let discoveries = 0
  const index = createFileIndex({
    discover: async () => {
      discoveries++
      return ["src/a.ts"]
    },
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    maxWorkspaces: 2,
  })

  for (const id of ["one", "two", "three"]) {
    index.paths(id, `/repo/${id}`)
    await index.whenIdle()
  }
  assert.equal(index.stats().workspaces, 2, "only two workspace roots stay cached")
  assert.equal(discoveries, 3)

  assert.deepEqual(index.paths("one", "/repo/one"), [], "an evicted root is a cold cache again")
  await index.whenIdle()
  assert.equal(discoveries, 4)
  assert.equal(index.stats().workspaces, 2)
})

test("changing a workspace directory invalidates that workspace's cache", async () => {
  const clock = manualClock()
  let directory = "/repo/old"
  const index = createFileIndex({
    discover: async (root) => [`${root.slice(root.lastIndexOf("/") + 1)}.ts`],
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  index.paths("workspace-a", directory)
  await index.whenIdle()
  assert.deepEqual(index.paths("workspace-a", directory), ["old.ts"])

  directory = "/repo/new"
  assert.deepEqual(index.paths("workspace-a", directory), [], "a new root never reuses the old list")
  await index.whenIdle()
  assert.deepEqual(index.paths("workspace-a", directory), ["new.ts"])
})

test("event refreshes during an in-flight discovery collapse into one queued pass", async () => {
  const clock = manualClock()
  const first = deferred<string[]>()
  let discoveries = 0
  const index = createFileIndex({
    discover: () => {
      discoveries++
      return discoveries === 1 ? first.promise : Promise.resolve(["new.ts"])
    },
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  const refreshes = [index.refresh("workspace-a", "/repo/a")]
  for (let event = 0; event < 20; event++) refreshes.push(index.refresh("workspace-a", "/repo/a"))
  assert.equal(discoveries, 1)
  assert.equal(clock.pending(), 0, "events never start a second concurrent discovery")

  first.resolve(["old.ts"])
  await flush()
  assert.equal(clock.pending(), 1, "the burst leaves exactly one trailing pass")
  await clock.advance(1_000)
  await Promise.all(refreshes)
  await index.whenIdle()
  assert.equal(discoveries, 2)
  assert.deepEqual(index.paths("workspace-a", "/repo/a"), ["new.ts"])
})

test("file discovery is asynchronous and cached per workspace", async () => {
  const clock = manualClock()
  const pending = deferred<string[]>()
  let discoveries = 0
  const index = createFileIndex({
    discover: () => {
      discoveries++
      return pending.promise
    },
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  assert.deepEqual(index.paths("workspace-a", "/repo/a"), [], "a cold cache renders immediately as empty")
  assert.equal(discoveries, 1, "the cold read starts one background discovery")
  for (let pass = 0; pass < 50; pass++) assert.deepEqual(index.paths("workspace-a", "/repo/a"), [])

  pending.resolve(["src/b.ts", "src/a.ts"])
  await index.whenIdle()

  assert.deepEqual(index.paths("workspace-a", "/repo/a"), ["src/a.ts", "src/b.ts"])
  for (let pass = 0; pass < 50; pass++) assert.deepEqual(index.paths("workspace-a", "/repo/a"), ["src/a.ts", "src/b.ts"])
  assert.equal(discoveries, 1, "a filter burst over a warm cache never rediscovers")
})
