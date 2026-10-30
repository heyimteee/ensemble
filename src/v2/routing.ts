import type { Agent, Workspace } from "./types.ts"

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function parseMentions(text: string, workspace: Workspace, agents: Record<string, Agent>): string[] {
  const members = workspace.memberIDs
    .map((memberID) => agents[memberID])
    .filter((agent): agent is Agent => Boolean(agent))
    .sort((a, b) => b.name.length - a.name.length)
  const matches: Array<{ id: string; start: number; end: number }> = []
  for (const agent of members) {
    for (const raw of [`@${agent.name}`, `!${agent.name}`, `@${agent.id}`, `!${agent.id}`]) {
      const pattern = new RegExp(escapeRegExp(raw), "gi")
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

export function visibleRecipients(text: string, workspace: Workspace, agents: Record<string, Agent>): string[] {
  const mentioned = parseMentions(text, workspace, agents).filter((agentID) => agents[agentID] && !agents[agentID].archived)
  return mentioned.length > 0 ? mentioned : [workspace.leaderID]
}
