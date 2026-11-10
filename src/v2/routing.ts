import type { Agent, Workspace } from "./types.ts"

/**
 * Legacy raw-text mention parsing. Composer and explicit-tool callers still
 * use this path until #220/#221 move them. Native message routing must use
 * `mention-routing.ts`, which applies the ADR 0011 sanitized-prose grammar.
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

type MentionMatch = { id: string; start: number; end: number }

function memberMatches(text: string, workspace: Workspace, agents: Record<string, Agent>): MentionMatch[] {
  const members = workspace.memberIDs
    .map((memberID) => agents[memberID])
    .filter((agent): agent is Agent => Boolean(agent))
    .sort((a, b) => b.name.length - a.name.length)
  const matches: MentionMatch[] = []
  for (const agent of members) {
    for (const raw of [`$${agent.name}`, `!${agent.name}`, `$${agent.id}`, `!${agent.id}`]) {
      const pattern = new RegExp(escapeRegExp(raw), "gi")
      for (const match of text.matchAll(pattern)) {
        matches.push({ id: agent.id, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length })
      }
    }
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end)
  const accepted: MentionMatch[] = []
  for (const match of matches) {
    if (accepted.some((existing) => match.start < existing.end && match.end > existing.start)) continue
    accepted.push(match)
  }
  return accepted
}

export function parseMentions(text: string, workspace: Workspace, agents: Record<string, Agent>): string[] {
  return [...new Set(memberMatches(text, workspace, agents).map((match) => match.id))]
}

export function unknownMentions(text: string, workspace: Workspace, agents: Record<string, Agent>): string[] {
  const known = memberMatches(text, workspace, agents)
  const unknown: string[] = []
  for (const match of text.matchAll(/(?<![\w$!])([$!])([A-Za-z][\w.-]*)/g)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (known.some((knownMatch) => start < knownMatch.end && end > knownMatch.start)) continue
    const word = match[2]
    if (match[1] === "$" && word === word.toUpperCase() && word.length > 1) continue
    unknown.push(`${match[1]}${word}`)
  }
  return [...new Set(unknown)]
}

export function visibleRecipients(text: string, workspace: Workspace, agents: Record<string, Agent>): string[] {
  const mentioned = parseMentions(text, workspace, agents).filter((agentID) => agents[agentID] && !agents[agentID].archived)
  return mentioned.length > 0 ? mentioned : [workspace.leaderID]
}

export function normalizeAgentMentions(text: string, agents: Agent[]): { text: string; changed: boolean; names: string[] } {
  let output = text
  const names: string[] = []
  for (const agent of agents) {
    const pattern = new RegExp(`(^|[\\s([{])@${escapeRegExp(agent.name)}(?=$|[\\s.,!?;:)\\]}])`, "gi")
    output = output.replace(pattern, (_match, prefix: string) => {
      names.push(agent.name)
      return `${prefix}$${agent.name}`
    })
  }
  return { text: output, changed: names.length > 0, names: [...new Set(names)] }
}
