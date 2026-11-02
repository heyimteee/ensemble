import { deriveWorkStatus } from "./queue.ts"
import type { Agent, Subtask } from "./types.ts"

/**
 * Group-chat peer-turn helpers (ticket #57). A peer turn is a subtask with
 * `workKind: "turn"` flowing through the same durable queue, lease, retry,
 * and recovery machinery as delegations and handoff hops. Group states are
 * a projection of the derived work lifecycle, never a stored status.
 */

export type PeerTurnStatus = "queued" | "running" | "waiting" | "completed" | "failed"

/**
 * Group-visible state for one peer turn. Derived from the canonical work
 * lifecycle: pending queues, working runs, retrying waits, replied
 * completes, and both failed and cancelled terminate as failed on the
 * group surface (cancellation detail stays on the work row derivation).
 * Pure: the caller passes `now`.
 */
export function peerTurnStatus(task: Subtask, now: number): PeerTurnStatus {
  const status = deriveWorkStatus(task, now)
  if (status === "pending") return "queued"
  if (status === "working") return "running"
  if (status === "retrying") return "waiting"
  if (status === "replied") return "completed"
  return "failed"
}

export function isPeerTurn(task: Subtask): boolean {
  return task.workKind === "turn"
}

/**
 * Visible refusal for one refused peer. Uses `$Name` addressing; `@` stays
 * reserved for workspace file references. One refused peer never aborts the
 * rest of the exchange — the caller posts one line per refusal.
 */
export function peerRefusalText(recipientName: string, reason: string): string {
  return `Peer turn refused: $${recipientName} — ${reason}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Archived agents named with `$Name`/`!Name` (or `$id`) in group-chat text.
 * The member-only mention matcher never matches these, so without this check
 * an archived mention would silently fall back to the leader or read as an
 * unknown token. Refused loudly instead. Pure.
 */
export function archivedMentionRefs(text: string, agents: Record<string, Agent>): Agent[] {
  const found: Agent[] = []
  for (const agent of Object.values(agents)) {
    if (!agent.archived) continue
    const hit = [`$${agent.name}`, `!${agent.name}`, `$${agent.id}`, `!${agent.id}`].some((raw) => new RegExp(escapeRegExp(raw), "i").test(text))
    if (hit) found.push(agent)
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/** Bare name for a `$Name`/`!Name` token (`$Ghost` → `Ghost`). */
export function bareMentionToken(token: string): string {
  return token.replace(/^[$!]/, "")
}

/**
 * Roster agents named with `$Name`/`!Name` that are not workspace members
 * (and are not the asker, and are not archived). These follow the existing
 * approval model instead of routing directly: contact needs user consent.
 * Pure.
 */
export function outsideMentionRefs(
  text: string,
  agents: Record<string, Agent>,
  memberIDs: string[],
  selfID: string,
): Agent[] {
  const found: Agent[] = []
  for (const agent of Object.values(agents)) {
    if (agent.archived || agent.id === selfID || memberIDs.includes(agent.id)) continue
    const hit = [`$${agent.name}`, `!${agent.name}`, `$${agent.id}`, `!${agent.id}`].some((raw) => new RegExp(escapeRegExp(raw), "i").test(text))
    if (hit) found.push(agent)
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}
