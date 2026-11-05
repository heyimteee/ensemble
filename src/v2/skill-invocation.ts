import type { Agent, SkillOption, Workspace } from "./types.ts"

/** Composer slash commands. One catalog serves recognition, completion, and execution. */
export const COMPOSER_COMMANDS = [
  { name: "workspace", description: "switch workspace" },
  { name: "agent", description: "mention an agent" },
  { name: "settings", description: "agent settings" },
  { name: "approvals", description: "approval inbox" },
  { name: "pause", description: "pause workspace" },
  { name: "resume", description: "resume workspace" },
  { name: "init", description: "initialize workspace files" },
  { name: "help", description: "shortcut help" },
  { name: "native", description: "open native session" },
  { name: "delegate", description: "delegate selected subtask" },
  { name: "retry", description: "retry selected subtask" },
  { name: "restart", description: "restart selected subtask" },
  { name: "cancel", description: "cancel selected subtask" },
  { name: "reset-ensemble", description: "delete all Ensemble data" },
] as const

const COMMAND_NAMES = new Set<string>(COMPOSER_COMMANDS.map((command) => command.name))

export type SkillInvocationRecipient = {
  agentID: string
  assignedSkills: string[]
  generalSkills: string[]
  normal: boolean
  triage: boolean
}

export type SkillInvocationError = {
  code: string
  message: string
  skillID?: string
  agentName?: string
}

export type SkillInvocationPlan = {
  kind: "message" | "command" | "init" | "skills"
  recipients: SkillInvocationRecipient[]
  ownerChoices?: Array<{ skillID: string; ownerIDs: string[] }>
  errors: SkillInvocationError[]
}

export type SkillInvocationInput = {
  text: string
  workspace: Workspace
  agents: Record<string, Agent>
  skills: readonly SkillOption[]
  maxSkills?: number
}

export type SkillPaletteRow = {
  kind: "command" | "skill"
  id: string
  label: string
  flag: string
  command?: string
  skillID?: string
  ownerID?: string
  insert?: string
}

export type SkillPalette = {
  scope: "start" | "agent"
  tokenStart: number
  tokenEnd: number
  query: string
  ownerID?: string
  rows: SkillPaletteRow[]
}

export type SkillPaletteInput = {
  text: string
  cursor: number
  workspace: Workspace
  agents: Record<string, Agent>
  skills: readonly SkillOption[]
}

type Mention = {
  start: number
  end: number
  token: string
  agentID?: string
  name: string
}

type SlashToken = {
  start: number
  end: number
  id: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function mentionMatches(text: string, agents: Record<string, Agent>): Mention[] {
  const candidates: Mention[] = []
  for (const agent of Object.values(agents)) {
    for (const raw of [`$${agent.name}`, `!${agent.name}`, `$${agent.id}`, `!${agent.id}`]) {
      const pattern = new RegExp(`(?<![\\w$!])${escapeRegExp(raw)}(?![\\w.-])`, "gi")
      for (const match of text.matchAll(pattern)) {
        candidates.push({
          start: match.index ?? 0,
          end: (match.index ?? 0) + match[0].length,
          token: match[0],
          agentID: agent.id,
          name: agent.name,
        })
      }
    }
  }
  candidates.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.name.localeCompare(b.name))
  const accepted: Mention[] = []
  for (const candidate of candidates) {
    if (accepted.some((existing) => candidate.start < existing.end && candidate.end > existing.start)) continue
    accepted.push(candidate)
  }
  for (const match of text.matchAll(/(^|[\s([{])[$!]([A-Za-z][\w.-]*)/g)) {
    const start = (match.index ?? 0) + match[1].length
    const end = start + match[0].length - match[1].length
    if (accepted.some((existing) => start < existing.end && end > existing.start)) continue
    const token = text.slice(start, end)
    const name = token.slice(1)
    if (token.startsWith("$") && name === name.toUpperCase() && name.length > 1) continue
    accepted.push({ start, end, token, name })
  }
  return accepted.sort((a, b) => a.start - b.start)
}

function slashTokens(text: string): SlashToken[] {
  const tokens: SlashToken[] = []
  for (const match of text.matchAll(/(^|[\s([{])\/([A-Za-z][\w.-]*)?(?=[\s,.;:!?)\]}'\"]|$)/g)) {
    const start = (match.index ?? 0) + match[1].length
    const id = match[2] ?? ""
    tokens.push({ start, end: start + 1 + id.length, id })
  }
  return tokens
}

function ownerMap(workspace: Workspace, agents: Record<string, Agent>): Map<string, Agent[]> {
  const owners = new Map<string, Agent[]>()
  for (const memberID of workspace.memberIDs) {
    const agent = agents[memberID]
    if (!agent || agent.archived) continue
    for (const skillID of agent.skillbox) {
      const list = owners.get(skillID) ?? []
      if (!list.some((owner) => owner.id === agent.id)) list.push(agent)
      owners.set(skillID, list)
    }
  }
  for (const list of owners.values()) list.sort((a, b) => a.name.localeCompare(b.name))
  return owners
}

function ownerNames(owners: Agent[]): string {
  return owners.map((owner) => `$${owner.name}`).join(", ")
}

function skillLabel(skill: SkillOption): string {
  const description = (skill.description ?? "").trim()
  if (description) return `${skill.name} — ${description}`
  if (skill.name !== skill.id) return `${skill.name} (${skill.id})`
  return skill.name
}

function matchesQuery(query: string, values: readonly string[]): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return values.some((value) => value.toLowerCase().includes(needle))
}

/**
 * Cursor-scoped composer completion context. `/` at message start lists
 * commands and assigned skills; `$Agent /` lists only that agent's assigned
 * skills. The same mention/slash parser as the planner keeps palette and
 * server validation from drifting.
 */
export function skillPaletteAt(input: SkillPaletteInput): SkillPalette | undefined {
  const { text, cursor } = input
  const token = slashTokens(text).find((item) => cursor >= item.start && cursor <= item.end)
  if (!token) return undefined
  const leading = text.length - text.trimStart().length
  const anchor = [...mentionMatches(text, input.agents)].reverse().find((item) => item.start < token.start)
  const scope = token.start === leading ? "start" : anchor ? "agent" : undefined
  if (!scope) return undefined
  const query = token.id.toLowerCase()
  const owners = ownerMap(input.workspace, input.agents)
  const rows: SkillPaletteRow[] = []
  if (scope === "start") {
    for (const command of COMPOSER_COMMANDS) {
      if (!matchesQuery(query, [command.name, command.description])) continue
      rows.push({
        kind: "command",
        id: command.name,
        command: command.name,
        label: `/${command.name} — ${command.description}`,
        flag: "Command",
      })
    }
  }

  const catalog = new Map(input.skills.map((skill) => [skill.id, skill]))
  const agentScope = anchor?.agentID
    ? input.workspace.memberIDs.includes(anchor.agentID) ? input.agents[anchor.agentID] : undefined
    : undefined
  const entries: Array<{ skill: SkillOption; owner: Agent }> = []
  if (scope === "agent" && agentScope && !agentScope.archived) {
    for (const skillID of agentScope.skillbox) {
      const skill = catalog.get(skillID)
      if (skill) entries.push({ skill, owner: agentScope })
    }
  } else if (scope === "start") {
    for (const skill of input.skills) {
      for (const owner of owners.get(skill.id) ?? []) entries.push({ skill, owner })
    }
  }
  entries.sort((a, b) => a.skill.name.localeCompare(b.skill.name) || a.owner.name.localeCompare(b.owner.name))
  for (const { skill, owner } of entries) {
    const label = skillLabel(skill)
    if (!matchesQuery(query, [skill.id, skill.name, skill.description ?? "", owner.name])) continue
    rows.push({
      kind: "skill",
      id: skill.id,
      skillID: skill.id,
      ownerID: owner.id,
      label,
      flag: `Skill | ${owner.name}`,
      insert: scope === "agent" || owner.id === input.workspace.leaderID
        ? `/${skill.id} `
        : `$${owner.name} /${skill.id} `,
    })
  }
  return {
    scope,
    tokenStart: token.start,
    tokenEnd: token.end,
    query,
    ownerID: scope === "agent" ? agentScope?.id : undefined,
    rows,
  }
}

/** Replace the slash token under the cursor with a selected skill template. */
export function replaceSkillToken(
  text: string,
  tokenStart: number,
  tokenEnd: number,
  insert: string,
): { text: string; cursor: number } {
  let end = tokenEnd
  if (text[end] === " " && insert.endsWith(" ")) end += 1
  return {
    text: `${text.slice(0, tokenStart)}${insert}${text.slice(end)}`,
    cursor: tokenStart + insert.length,
  }
}

/** Apply a palette selection to the composer text without touching its request tail. */
export function applySkillPaletteSelection(
  text: string,
  palette: SkillPalette,
  row: SkillPaletteRow,
): { text: string; cursor: number } | undefined {
  if (!row.insert) return undefined
  return replaceSkillToken(text, palette.tokenStart, palette.tokenEnd, row.insert)
}

/**
 * The pure skill invocation planner shared by the composer palette and the
 * server. It parses the exact user text into `$Agent` anchors and `/skill`
 * tokens, resolves the Skillbox assignment, and returns recipients plus
 * specific validation errors. It never rewrites the user text and never
 * extracts per-skill bodies.
 *
 * Ticket #101 delivers the assigned-skill path only. General skills,
 * multi-agent routing, and init jobs are the extension points owned by
 * tickets #100, #102, and #103: the recipient shape already carries
 * `generalSkills` and `triage`, and catalog skills without a workspace owner
 * are intentionally not recipients yet.
 */
export function planSkillInvocation(input: SkillInvocationInput): SkillInvocationPlan {
  const { text, workspace, agents } = input
  const anchors = mentionMatches(text, agents)
  const tokens = slashTokens(text)
  const leading = text.length - text.trimStart().length
  const startToken = tokens.find((token) => token.start === leading && token.id.length > 0)
  const colonCommand = text.trimStart().startsWith(":")
    ? text.trimStart().slice(1).split(/[\s:]/, 1)[0]
    : undefined
  if (startToken && COMMAND_NAMES.has(startToken.id)) {
    return { kind: startToken.id === "init" ? "init" : "command", recipients: [], errors: [] }
  }
  if (colonCommand && COMMAND_NAMES.has(colonCommand)) {
    return { kind: colonCommand === "init" ? "init" : "command", recipients: [], errors: [] }
  }
  const anchorTokens = new Map<Mention, SlashToken[]>()
  for (const token of tokens) {
    if (token === startToken || token.id.length === 0) continue
    const anchor = [...anchors].reverse().find((item) => item.start < token.start)
    if (!anchor) continue
    const list = anchorTokens.get(anchor) ?? []
    list.push(token)
    anchorTokens.set(anchor, list)
  }
  const allSkillTokens = [...(startToken ? [startToken] : []), ...[...anchorTokens.values()].flat()]
  if (allSkillTokens.length === 0) {
    return { kind: "message", recipients: [], errors: [] }
  }

  const errors: SkillInvocationError[] = []
  const bySkill = new Map(input.skills.map((skill) => [skill.id, skill]))
  const owners = ownerMap(workspace, agents)
  const recipients = new Map<string, SkillInvocationRecipient>()

  const resolveToken = (token: SlashToken, target: Agent): void => {
    if (!bySkill.has(token.id)) {
      if (owners.has(token.id)) {
        errors.push({
          code: "skill_unavailable",
          skillID: token.id,
          message: `Skill /${token.id} is assigned but is not available from the host skill catalog.`,
        })
      } else {
        errors.push({ code: "unknown_skill", skillID: token.id, message: `Unknown skill: /${token.id}.` })
      }
      return
    }
    if (!target.skillbox.includes(token.id)) {
      const assigned = owners.get(token.id) ?? []
      errors.push({
        code: "skill_not_assigned",
        skillID: token.id,
        agentName: target.name,
        message: assigned.length > 0
          ? `Skill /${token.id} is assigned to ${ownerNames(assigned)}, not $${target.name}.`
          : `Skill /${token.id} is not assigned to any workspace member.`,
      })
      return
    }
    const recipient = recipients.get(target.id) ?? {
      agentID: target.id,
      assignedSkills: [],
      generalSkills: [],
      normal: false,
      triage: false,
    }
    if (!recipient.assignedSkills.includes(token.id)) recipient.assignedSkills.push(token.id)
    recipients.set(target.id, recipient)
  }

  for (const anchor of anchors) {
    const tokensForAnchor = anchorTokens.get(anchor) ?? []
    if (tokensForAnchor.length === 0) continue
    const target = anchor.agentID ? agents[anchor.agentID] : undefined
    if (!target) {
      errors.push({
        code: "unknown_agent",
        agentName: anchor.name,
        message: `Unknown agent: ${anchor.token}.`,
      })
      continue
    }
    if (target.archived) {
      errors.push({
        code: "agent_archived",
        agentName: target.name,
        message: `$${target.name} is archived and cannot take a skill turn.`,
      })
      continue
    }
    if (!workspace.memberIDs.includes(target.id)) {
      errors.push({
        code: "not_member",
        agentName: target.name,
        message: `$${target.name} is not a workspace member; add them before invoking a skill.`,
      })
      continue
    }
    for (const token of tokensForAnchor) resolveToken(token, target)
  }

  if (startToken) {
    const leader = agents[workspace.leaderID]
    if (!leader) {
      errors.push({ code: "missing_leader", message: "The workspace has no leader to receive this skill." })
    } else if (!bySkill.has(startToken.id)) {
      const ownersForSkill = owners.get(startToken.id) ?? []
      if (ownersForSkill.length > 0) {
        errors.push({
          code: "skill_unavailable",
          skillID: startToken.id,
          message: `Skill /${startToken.id} is assigned but is not available from the host skill catalog.`,
        })
      } else {
        errors.push({ code: "unknown_skill", skillID: startToken.id, message: `Unknown skill: /${startToken.id}.` })
      }
    } else {
      const assigned = owners.get(startToken.id) ?? []
      if (!leader.skillbox.includes(startToken.id)) {
        errors.push({
          code: "skill_not_assigned",
          skillID: startToken.id,
          agentName: leader.name,
          message: assigned.length > 0
            ? `Skill /${startToken.id} is assigned to ${ownerNames(assigned)}; mention the owner to invoke it.`
            : `Skill /${startToken.id} is not assigned to any workspace member.`,
        })
      } else {
        const recipient = recipients.get(leader.id) ?? {
          agentID: leader.id,
          assignedSkills: [],
          generalSkills: [],
          normal: false,
          triage: false,
        }
        if (!recipient.assignedSkills.includes(startToken.id)) recipient.assignedSkills.push(startToken.id)
        recipients.set(leader.id, recipient)
      }
    }
  }

  const recipientList = [...recipients.values()]
  const addressed = new Set<string>()
  for (const anchor of anchors) if (anchor.agentID) addressed.add(anchor.agentID)
  if (startToken && agents[workspace.leaderID]) addressed.add(workspace.leaderID)
  if (addressed.size > 1) {
    errors.push({
      code: "unsupported_multi_agent",
      message: "Skill invocation is limited to one addressed agent in this version; split the message by agent.",
    })
  }
  const cap = Math.max(1, Math.min(input.maxSkills ?? 8, 8))
  if (allSkillTokens.length > cap) {
    errors.push({
      code: "skill_limit",
      message: `A message can invoke at most ${cap} skills; ${allSkillTokens.length} were requested.`,
    })
  }
  if (errors.length > 0) return { kind: "skills", recipients: [], errors }
  return { kind: "skills", recipients: recipientList, errors: [] }
}
