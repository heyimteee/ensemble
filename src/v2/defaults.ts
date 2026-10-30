import type { Settings, SnapshotState } from "./types.ts"

export const DEFAULT_SETTINGS: Settings = {
  maxActiveRuns: 3,
  maxDelegations: 10,
  maxDepth: 5,
  synthesis: true,
}

export function createInitialState(): SnapshotState {
  return {
    version: 0,
    updatedAt: Date.now(),
    agents: {},
    workspaces: {},
    messages: {},
    subtasks: {},
    bindings: {},
    memories: {},
    approvals: {},
    settings: { ...DEFAULT_SETTINGS },
    ui: {},
    runs: {},
  }
}
