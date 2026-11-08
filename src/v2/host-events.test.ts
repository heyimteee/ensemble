import test from "node:test"
import assert from "node:assert/strict"
import { RecentHostEvents, hostEventKey, retryEventKey } from "./host-events.ts"

test("a host event uses its host event id as identity", () => {
  assert.equal(hostEventKey({ id: "evt_1", type: "session.text.delta", data: {} }), "id:evt_1")
})

test("id-less stream and permission events derive stable keys from their own fields", () => {
  assert.equal(
    hostEventKey({ type: "session.text.delta", data: { sessionID: "s1", assistantMessageID: "m1", ordinal: 2, delta: "hi" } }),
    "session.text.delta:s1:m1:2",
  )
  assert.equal(
    hostEventKey({ type: "permission.asked", data: { sessionID: "s1", id: "perm_1" } }),
    "permission.asked:s1:perm_1",
  )
  assert.equal(
    hostEventKey({ type: "permission.replied", data: { sessionID: "s1", requestID: "perm_1", reply: "once" } }),
    "permission.replied:s1:perm_1:once",
  )
})

test("an event with no safe identity is processed rather than guessed away", () => {
  assert.equal(hostEventKey({ type: "config.updated", data: {} }), undefined)
  const recent = new RecentHostEvents(8)
  assert.equal(recent.claim({ type: "config.updated", data: {} }), true)
  assert.equal(recent.claim({ type: "config.updated", data: {} }), true)
})

test("recent event ids are bounded and evict the oldest identity", () => {
  const recent = new RecentHostEvents(2)
  assert.equal(recent.claim({ id: "one", type: "x" }), true)
  assert.equal(recent.claim({ id: "two", type: "x" }), true)
  assert.equal(recent.claim({ id: "one", type: "x" }), false, "a recent duplicate is skipped")
  assert.equal(recent.claim({ id: "three", type: "x" }), true)

  assert.equal(recent.claim({ id: "one", type: "x" }), true, "the oldest identity leaves the bounded window")
  assert.equal(recent.claim({ id: "three", type: "x" }), false, "the newest identities stay inside it")
})

test("retry hook deliveries derive identity from session, attempt, and error", () => {
  const one = { sessionID: "s1", attempt: 2, error: { type: "provider.internal", message: "boom" } }
  const two = { sessionID: "s1", attempt: 3, error: { type: "provider.internal", message: "boom" } }
  assert.equal(retryEventKey(one), retryEventKey({ ...one }))
  assert.notEqual(retryEventKey(one), retryEventKey(two))
  assert.equal(retryEventKey({}), undefined)
})
