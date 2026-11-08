import { DISPATCH_LIMIT_DEFAULTS } from "./dispatch-budget.ts"
import type { Settings, SnapshotState } from "./types.ts"

export const DEFAULT_SETTINGS: Settings = {
  maxActiveRuns: 3,
  maxDelegations: 10,
  maxDepth: 5,
  synthesis: true,
  dispatchGroupMaxHops: DISPATCH_LIMIT_DEFAULTS.groupMaxHops,
  dispatchCommandMaxHops: DISPATCH_LIMIT_DEFAULTS.commandMaxHops,
  dispatchDepth: DISPATCH_LIMIT_DEFAULTS.depth,
  dispatchContinuations: DISPATCH_LIMIT_DEFAULTS.continuations,
}

export function createInitialState(): SnapshotState {
  return {
    version: 0,
    updatedAt: Date.now(),
    agents: {},
    workspaces: {},
    messages: {},
    subtasks: {},
    dispatchGroups: {},
    initJobs: {},
    bindings: {},
    memories: {},
    approvals: {},
    dmQueue: {},
    dmTranscripts: {},
    settings: { ...DEFAULT_SETTINGS },
    ui: {},
    runs: {},
  }
}
