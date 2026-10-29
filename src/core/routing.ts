import { resolve } from "node:path"
import { realpathSync } from "node:fs"
import type { AgentProfile, Channel, ModelOption, ModelSelection } from "./types.ts"

export function parseMentions(text: string, agents: AgentProfile[], memberIDs: string[]): string[] {
  const byID = new Map(agents.map((agent) => [agent.id, agent]))
  const members = memberIDs
    .map((id) => byID.get(id))
    .filter((agent): agent is AgentProfile => Boolean(agent))
    .sort((a, b) => b.name.length - a.name.length)
  const found: Array<{ id: string; at: number }> = []
  for (const agent of members) {
    const needles = [`!${agent.name}`, `!${agent.id}`]
    for (const needle of needles) {
      const index = text.toLowerCase().indexOf(needle.toLowerCase())
      if (index >= 0) found.push({ id: agent.id, at: index })
    }
  }
  return [...new Map(found.sort((a, b) => a.at - b.at).map((entry) => [entry.id, entry.id])).values()]
}

export function routeChannelMessage(text: string, channel: Channel, agents: AgentProfile[]): string[] {
  const mentions = parseMentions(text, agents, channel.memberIDs)
  if (mentions.length > 0) return mentions
  return channel.memberIDs.includes(channel.leaderID) ? [channel.leaderID] : []
}

export function selectableModels(models: ModelOption[]): ModelOption[] {
  return [...models].sort((a, b) => `${a.providerID}/${a.modelID}`.localeCompare(`${b.providerID}/${b.modelID}`))
}

export function modelKey(model: ModelSelection): string {
  return `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}`
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
