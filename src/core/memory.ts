import type { EnsembleState, MemoryEntry, MemoryScope } from "./types.ts"

export type MemoryQuery = {
  agentID?: string
  channelID?: string
  projectDirectory?: string
}

export function visibleMemories(state: EnsembleState, query: MemoryQuery): MemoryEntry[] {
  return Object.values(state.memories)
    .filter((entry) => !entry.deletedAt)
    .filter((entry) => {
      if (entry.agentID && entry.agentID !== query.agentID) return false
      if (entry.channelID && entry.channelID !== query.channelID) return false
      if (entry.scope === "channel") return Boolean(entry.channelID && entry.channelID === query.channelID)
      if (entry.scope === "global") return Boolean(entry.agentID && entry.agentID === query.agentID)
      return Boolean(entry.agentID && entry.agentID === query.agentID && entry.projectDirectory === query.projectDirectory)
    })
    .sort((a, b) => a.createdAt - b.createdAt)
}

export function memoryContext(entries: MemoryEntry[]): string {
  if (entries.length === 0) return ""
  return [
    "<ensemble_memory>",
    ...entries.map((entry) => `- [${entry.scope}] ${entry.text}`),
    "</ensemble_memory>",
  ].join("\n")
}

export function canPromoteMemory(entry: MemoryEntry): boolean {
  return entry.origin === "automatic" && entry.scope === "project"
}

export function createMemoryEntry(input: {
  id: string
  text: string
  scope: MemoryScope
  origin: "automatic" | "manual"
  source: string
  agentID?: string
  channelID?: string
  projectDirectory?: string
  at?: number
}): MemoryEntry {
  const at = input.at ?? Date.now()
  return {
    id: input.id,
    agentID: input.agentID,
    channelID: input.channelID,
    scope: input.scope,
    projectDirectory: input.projectDirectory,
    text: input.text.trim(),
    origin: input.origin,
    source: input.source,
    createdAt: at,
    updatedAt: at,
    history: [{ at, action: "created", by: input.origin === "automatic" ? "agent" : "user" }],
  }
}
