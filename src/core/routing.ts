import { resolve } from "node:path"
import { realpathSync } from "node:fs"
import type { AgentProfile, Channel, ModelOption, ModelSelection } from "./types.ts"

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function parseMentions(text: string, agents: AgentProfile[], memberIDs: string[]): string[] {
  const byID = new Map(agents.map((agent) => [agent.id, agent]))
  const members = memberIDs
    .map((id) => byID.get(id))
    .filter((agent): agent is AgentProfile => Boolean(agent))
    .sort((a, b) => b.name.length - a.name.length)
  const matches: Array<{ id: string; start: number; end: number }> = []
  for (const agent of members) {
    for (const needle of [`!${agent.name}`, `!${agent.id}`]) {
      const pattern = new RegExp(escapeRegExp(needle), "gi")
      for (const match of text.matchAll(pattern)) {
        matches.push({ id: agent.id, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length })
      }
    }
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end)
  const accepted: typeof matches = []
  for (const match of matches) {
    if (accepted.some((existing) => match.start < existing.end && match.end > existing.start)) continue
    accepted.push(match)
  }
  return [...new Set(accepted.map((match) => match.id))]
}

export function routeChannelMessage(text: string, channel: Channel, agents: AgentProfile[]): string[] {
  const mentions = parseMentions(text, agents, channel.memberIDs)
  if (mentions.length > 0) return mentions
  return channel.memberIDs.includes(channel.leaderID) ? [channel.leaderID] : []
}

export function variantSupported(model: ModelOption | undefined, variant: string | undefined): boolean {
  if (!model) return false
  if (!variant) return true
  return model.variants.includes(variant)
}

export function validateModelSelection(model: ModelSelection, models: ModelOption[]): string | undefined {
  if (!model.providerID || !model.modelID) return "Choose a provider and model."
  const option = models.find((item) => item.providerID === model.providerID && item.modelID === model.modelID)
  if (!option) return "That model is not available in this project."
  if (!variantSupported(option, model.variant)) return `Reasoning variant "${model.variant}" is not supported by ${model.modelID}.`
  return undefined
}

export function resolveCheckoutKey(directory: string): string {
  const absolute = resolve(directory).replaceAll("\\", "/")
  try {
    return realpathSync(absolute).replaceAll("\\", "/")
  } catch {
    return absolute
  }
}

export function validateChannel(channel: Pick<Channel, "name" | "memberIDs" | "leaderID">, agents: Record<string, AgentProfile>): string | undefined {
  if (!channel.name.trim()) return "Channel name is required."
  if (channel.memberIDs.length === 0) return "A channel needs at least one member."
  if (!channel.memberIDs.includes(channel.leaderID)) return "The leader must be a member of the channel."
  for (const id of channel.memberIDs) {
    const agent = agents[id]
    if (!agent) return `Unknown agent: ${id}`
    if (agent.archived) return `${agent.name} is archived and cannot join a channel.`
  }
  return undefined
}
