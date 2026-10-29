import type { EnsembleState, WorkItem } from "./types.ts"

export function activeWork(state: EnsembleState): WorkItem[] {
  return Object.values(state.work).filter((item) => item.status === "running")
}

export function queuedWork(state: EnsembleState): WorkItem[] {
  return Object.values(state.work)
    .filter((item) => item.status === "queued")
    .sort((a, b) => a.queueOrder - b.queueOrder || a.createdAt - b.createdAt)
}

export function editingLock(state: EnsembleState): string | undefined {
  return activeWork(state).find((item) => item.mode === "edit" && item.checkoutKey)?.checkoutKey
}

export function isRunnable(state: EnsembleState, item: WorkItem): boolean {
  if (item.status !== "queued") return false
  const agent = state.agents[item.agentID]
  if (!agent || agent.archived) return false
  if (item.channelID) {
    const channel = state.channels[item.channelID]
    if (!channel || channel.archived || channel.paused) return false
  }
  return true
}

/** Returns the queue entries that may start now, in deterministic order. */
export function selectRunnable(state: EnsembleState): WorkItem[] {
  const running = activeWork(state)
  if (running.length >= state.settings.maxConcurrentTurns) return []
  const locked = running.find((item) => item.mode === "edit" && item.checkoutKey)?.checkoutKey
  const selected: WorkItem[] = []
  let slots = state.settings.maxConcurrentTurns - running.length
  let editLocked = locked
  for (const item of queuedWork(state)) {
    if (slots <= 0) break
    if (!isRunnable(state, item)) continue
    if (item.mode === "edit" && item.checkoutKey) {
      if (editLocked) continue
      editLocked = item.checkoutKey
    }
    selected.push(item)
    slots--
  }
  return selected
}

export function capacityAfterWaiting(state: EnsembleState, waiting: boolean): number {
  const running = activeWork(state).length
  return Math.max(0, state.settings.maxConcurrentTurns - running - (waiting ? 0 : 0))
}

export function chainLimitReached(state: EnsembleState, chainID: string): boolean {
  const chain = state.chains[chainID]
  if (!chain) return false
  return chain.deliveries >= chain.limit
}

export function nextQueueOrder(state: EnsembleState, workID: string, direction: "up" | "down"): string[] {
  const queued = queuedWork(state).filter((item) => !item.channelID || item.channelID === state.work[workID]?.channelID)
  const index = queued.findIndex((item) => item.id === workID)
  if (index < 0) return queued.map((item) => item.id)
  const swap = direction === "up" ? index - 1 : index + 1
  if (swap < 0 || swap >= queued.length) return queued.map((item) => item.id)
  const ids = queued.map((item) => item.id)
  ;[ids[index], ids[swap]] = [ids[swap], ids[index]]
  return ids
}
