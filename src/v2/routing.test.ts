import test from "node:test"
import assert from "node:assert/strict"
import { normalizeAgentMentions, unknownMentions, visibleRecipients } from "./routing.ts"
import type { Agent, Workspace } from "./types.ts"

const agent = { id: "a", name: "Jessy" } as Agent

test("agent chat mentions are display-normalized from @Name to $Name", () => {
  assert.deepEqual(normalizeAgentMentions("@Jessy please introduce yourself.", [agent]), {
    text: "$Jessy please introduce yourself.",
    changed: true,
    names: ["Jessy"],
  })
  assert.equal(normalizeAgentMentions("mail me at me@Jessy.dev", [agent]).changed, false)
  assert.equal(normalizeAgentMentions("@Jessy/file", [agent]).changed, false)
  assert.equal(normalizeAgentMentions("$Jessy is already correct", [agent]).changed, false)
})

const nova = { id: "n", name: "Nova" } as Agent
const sage = { id: "s", name: "Sage" } as Agent
const echo = { id: "e", name: "Echo" } as Agent
const agents = { n: nova, s: sage, e: echo }
const workspaceOf = (patch: Partial<import("./types.ts").Workspace> = {}) => ({
  id: "w", name: "site", directory: "/repo", leaderID: "n", memberIDs: ["n", "s", "e"],
  synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1, ...patch,
})

test("unmentioned text resolves only to the workspace leader", () => {
  assert.deepEqual(visibleRecipients("Do the thing", workspaceOf(), agents), ["n"])
})

test("a single mention replaces default routing entirely", () => {
  assert.deepEqual(visibleRecipients("$Sage take this", workspaceOf(), agents), ["s"])
})

test("several mentions fan out to exactly the mentioned active members", () => {
  assert.deepEqual(visibleRecipients("$Sage and $Echo pair up", workspaceOf(), agents).sort(), ["e", "s"])
})

test("archived members are never routed to, even when mentioned", () => {
  const archivedSage = { ...sage, archived: true }
  assert.deepEqual(visibleRecipients("$Sage take this", workspaceOf(), { n: nova, s: archivedSage, e: echo }), ["n"])
})

test("unknown mentions are reported instead of falling back to the leader", () => {
  assert.deepEqual(unknownMentions("$Ghost take a look", workspaceOf(), agents), ["$Ghost"])
  assert.deepEqual(unknownMentions("Do the thing", workspaceOf(), agents), [])
})

test("recipient resolution uses explicit naming only, never activity or frequency", () => {
  assert.deepEqual(visibleRecipients("$Sage $Sage $Sage take this", workspaceOf(), agents), ["s"])
  assert.deepEqual(visibleRecipients("Sage take this", workspaceOf(), agents), ["n"])
  assert.deepEqual(visibleRecipients("thanks Sage, great work everybody", workspaceOf(), agents), ["n"])
})
