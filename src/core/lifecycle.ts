import type { EnsembleState } from "./types.ts"

function cancelAgentWork(state: EnsembleState, agentID: string): void {
  const cancelled = new Set(["queued", "running", "paused", "waiting_approval"])
  for (const work of Object.values(state.work)) {
    if (work.agentID === agentID && cancelled.has(work.status)) work.status = "cancelled"
  }
  for (const handoff of Object.values(state.handoffs)) {
    if ((handoff.fromAgentID === agentID || handoff.toAgentID === agentID) && handoff.status !== "completed") {
      handoff.status = "cancelled"
      handoff.updatedAt = Date.now()
    }
  }
  for (const approval of Object.values(state.approvals)) {
    if (approval.agentID === agentID && approval.status === "pending") {
      approval.status = "rejected"
      approval.resolvedAt = Date.now()
      approval.resolution = "Target agent was archived or deleted."
    }
  }
}

function cancelChannelWork(state: EnsembleState, channelID: string): void {
  const cancelled = new Set(["queued", "running", "paused", "waiting_approval"])
  for (const work of Object.values(state.work)) {
    if (work.channelID === channelID && cancelled.has(work.status)) work.status = "cancelled"
  }
  for (const handoff of Object.values(state.handoffs)) {
    if (handoff.channelID === channelID && handoff.status !== "completed") {
      handoff.status = "cancelled"
      handoff.updatedAt = Date.now()
    }
  }
  for (const approval of Object.values(state.approvals)) {
    if (approval.channelID === channelID && approval.status === "pending") {
      approval.status = "rejected"
      approval.resolvedAt = Date.now()
      approval.resolution = "Channel was archived or deleted."
    }
  }
}

export type LifecycleResult =
  | { ok: true }
  | { ok: false; code: "not_found" | "leader_replacement_required"; message: string; channels?: string[] }

export function archiveAgent(state: EnsembleState, agentID: string, replacementLeaderID?: string): LifecycleResult {
  const agent = state.agents[agentID]
  if (!agent) return { ok: false, code: "not_found", message: "Agent not found." }
  const led = Object.values(state.channels).filter((channel) => !channel.archived && channel.leaderID === agentID)
  if (led.length > 0 && !replacementLeaderID) {
    return {
      ok: false,
      code: "leader_replacement_required",
      message: "Choose a replacement leader before archiving this agent.",
      channels: led.map((channel) => channel.id),
    }
  }
  if (replacementLeaderID) {
    for (const channel of led) {
      if (!channel.memberIDs.includes(replacementLeaderID) || replacementLeaderID === agentID) {
        return { ok: false, code: "leader_replacement_required", message: "The replacement leader must be another channel member." }
      }
      channel.leaderID = replacementLeaderID
      channel.updatedAt = Date.now()
    }
  }
  agent.archived = true
  agent.updatedAt = Date.now()
  agent.version++
  cancelAgentWork(state, agentID)
  for (const channel of Object.values(state.channels)) {
    channel.memberIDs = channel.memberIDs.filter((id) => id !== agentID)
  }
  return { ok: true }
}

export function deleteAgent(state: EnsembleState, agentID: string, replacementLeaderID?: string): LifecycleResult {
  const agent = state.agents[agentID]
  if (!agent) return { ok: false, code: "not_found", message: "Agent not found." }
  const led = Object.values(state.channels).filter((channel) => !channel.archived && channel.leaderID === agentID)
  if (led.length > 0 && !replacementLeaderID) {
    return {
      ok: false,
      code: "leader_replacement_required",
      message: "Choose a replacement leader before deleting this agent.",
      channels: led.map((channel) => channel.id),
    }
  }
  if (replacementLeaderID) {
    for (const channel of led) {
      if (!channel.memberIDs.includes(replacementLeaderID) || replacementLeaderID === agentID) {
        return { ok: false, code: "leader_replacement_required", message: "The replacement leader must be another channel member." }
      }
      channel.leaderID = replacementLeaderID
      channel.updatedAt = Date.now()
    }
  }
  for (const channel of Object.values(state.channels)) {
    channel.memberIDs = channel.memberIDs.filter((id) => id !== agentID)
  }
  for (const [id, conversation] of Object.entries(state.conversations)) {
    if (conversation.agentID === agentID) delete state.conversations[id]
  }
  for (const [id, memory] of Object.entries(state.memories)) {
    if (memory.agentID === agentID) delete state.memories[id]
  }
  cancelAgentWork(state, agentID)
  delete state.agents[agentID]
  return { ok: true }
}

export function archiveChannel(state: EnsembleState, channelID: string): LifecycleResult {
  const channel = state.channels[channelID]
  if (!channel) return { ok: false, code: "not_found", message: "Channel not found." }
  channel.archived = true
  channel.paused = true
  channel.updatedAt = Date.now()
  cancelChannelWork(state, channelID)
  return { ok: true }
}

export function deleteChannel(state: EnsembleState, channelID: string): LifecycleResult {
  const channel = state.channels[channelID]
  if (!channel) return { ok: false, code: "not_found", message: "Channel not found." }
  for (const [id, conversation] of Object.entries(state.conversations)) {
    if (conversation.channelID === channelID) delete state.conversations[id]
  }
  for (const [id, memory] of Object.entries(state.memories)) {
    if (memory.channelID === channelID) delete state.memories[id]
  }
  for (const [id, handoff] of Object.entries(state.handoffs)) {
    if (handoff.channelID === channelID) delete state.handoffs[id]
  }
  cancelChannelWork(state, channelID)
  delete state.channels[channelID]
  return { ok: true }
}
