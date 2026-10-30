import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Agent, Workspace } from "./types.ts"

export const ENSEMBLE_DIR = ".ensemble"
export const CONFIG_VERSION = 1

export type WorkspaceConfig = {
  version: number
  id?: string
  name: string
  leader: string
  members: string[]
  synthesis: boolean
  paused: boolean
}

export function workspaceConfigPath(directory: string): string {
  return join(directory, ENSEMBLE_DIR, "config.json")
}

export function handoffDirectory(directory: string): string {
  return join(directory, ENSEMBLE_DIR, "handoffs")
}

export function initMetadataPath(directory: string): string {
  return join(directory, ENSEMBLE_DIR, "init.json")
}

export function ensureEnsembleDirectory(directory: string): void {
  mkdirSync(join(directory, ENSEMBLE_DIR, "handoffs"), { recursive: true })
  const gitignore = join(directory, ".gitignore")
  const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : ""
  if (!existing.split(/\r?\n/).includes(`${ENSEMBLE_DIR}/`)) {
    const next = `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}# ensemble\n${ENSEMBLE_DIR}/\n`
    writeFileSync(gitignore, next)
  }
}

export function readWorkspaceConfig(directory: string): WorkspaceConfig | undefined {
  const path = workspaceConfigPath(directory)
  if (!existsSync(path)) return undefined
  try {
    const value = JSON.parse(readFileSync(path, "utf8"))
    if (value?.version !== CONFIG_VERSION) return undefined
    if (typeof value.name !== "string" || !value.name.trim()) return undefined
    if (typeof value.leader !== "string" || !value.leader.trim()) return undefined
    if (!Array.isArray(value.members) || value.members.some((member: any) => typeof member !== "string")) return undefined
    if (new Set(value.members.map((member: string) => member.toLowerCase())).size !== value.members.length) return undefined
    return {
      version: CONFIG_VERSION,
      id: typeof value.id === "string" ? value.id : undefined,
      name: value.name.trim(),
      leader: value.leader.trim(),
      members: value.members.map((member: string) => member.trim()).filter(Boolean),
      synthesis: value.synthesis !== false,
      paused: value.paused === true,
    }
  } catch {
    return undefined
  }
}

export function writeWorkspaceConfig(workspace: Workspace, agents: Record<string, Agent>): void {
  if (workspace.archived) return
  ensureEnsembleDirectory(workspace.directory)
  const config: WorkspaceConfig = {
    version: CONFIG_VERSION,
    id: workspace.id,
    name: workspace.name,
    leader: agents[workspace.leaderID]?.name ?? workspace.leaderID,
    members: workspace.memberIDs.map((memberID) => agents[memberID]?.name ?? memberID),
    synthesis: workspace.synthesis,
    paused: workspace.paused,
  }
  writeFileSync(workspaceConfigPath(workspace.directory), `${JSON.stringify(config, null, 2)}\n`)
}

export function writeInitMetadata(directory: string, version: number): void {
  ensureEnsembleDirectory(directory)
  writeFileSync(initMetadataPath(directory), `${JSON.stringify({ version, installedAt: Date.now() }, null, 2)}\n`)
}

export function readInitMetadata(directory: string): { version?: number; installedAt?: number } {
  const path = initMetadataPath(directory)
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return {}
  }
}

export function writeAgentsBlock(directory: string, block: string): void {
  const path = join(directory, "AGENTS.md")
  const existing = existsSync(path) ? readFileSync(path, "utf8") : ""
  const stripped = stripEnsembleBlock(existing).trim()
  const next = `${block.trim()}\n${stripped ? `\n${stripped}\n` : ""}`
  writeFileSync(path, next)
}

export function stripEnsembleBlock(value: string): string {
  return value
    .replace(/<!-- ensemble:start[^>]*-->[\s\S]*?<!-- ensemble:end -->\s*/g, "")
    .replace(/^\s+/, "")
}

export function writeHandoff(directory: string, relativePath: string, content: string): string {
  ensureEnsembleDirectory(directory)
  const path = join(handoffDirectory(directory), relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}
