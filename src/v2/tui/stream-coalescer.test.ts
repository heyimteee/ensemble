import test from "node:test"
import assert from "node:assert/strict"
import { createStreamCoalescer } from "./stream-coalescer.ts"

test("stream updates coalesce per key into one client apply", () => {
  const applied: Array<Map<string, string>> = []
  const stream = createStreamCoalescer<string>((updates) => applied.push(updates), 60_000)

  stream.push("workspace:m1", (previous) => `${previous ?? ""}partial`)
  stream.push("workspace:m1", (previous) => `${previous ?? ""} reply`)
  stream.push("direct:s1", () => "Hello")
  assert.equal(applied.length, 0, "updates wait for the coalescing window")
  stream.flush()

  assert.equal(applied.length, 1)
  assert.deepEqual([...applied[0]!.entries()], [
    ["workspace:m1", "partial reply"],
    ["direct:s1", "Hello"],
  ])
  stream.dispose()
})

test("the scheduled flush applies the latest text once", async () => {
  const applied: Array<Map<string, string>> = []
  const stream = createStreamCoalescer<string>((updates) => applied.push(updates), 5)
  stream.push("workspace:m1", () => "a")
  stream.push("workspace:m1", () => "ab")
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(applied.length, 1)
  assert.equal(applied[0]!.get("workspace:m1"), "ab")
  stream.dispose()
})

test("clear drops pending text without applying it", () => {
  const applied: Array<Map<string, string>> = []
  const stream = createStreamCoalescer<string>((updates) => applied.push(updates), 60_000)
  stream.push("direct:s1", () => "stale partial")
  stream.clear()
  stream.flush()
  assert.deepEqual(applied, [])
  stream.dispose()
})
