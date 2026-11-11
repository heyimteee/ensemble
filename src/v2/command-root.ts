import { isNativeTurn } from "./queue.ts"
import type { Id, Subtask } from "./types.ts"

/**
 * Ticket #246: one command root owns synthesis. The root is the topmost
 * Subtask on the parent chain; only that row may enter the synthesis stage.
 * Intermediate handoff and delegation parents relay instead.
 *
 * A native turn on the chain is host-answered: the host owns its response, so
 * a child completion must never convert it (or its root) into synthesis work.
 * Pure: the caller supplies the current subtask map.
 */
export type CommandRootResolution = {
  /** Topmost Subtask on the chain. */
  root: Subtask
  /** Root first, starting task last. */
  chain: Subtask[]
  /** True when any task on the chain is a host-answered native turn. */
  hostAnswered: boolean
}

export function resolveCommandRoot(
  taskID: Id,
  subtasks: Readonly<Record<Id, Subtask>>,
): CommandRootResolution | undefined {
  const start = subtasks[taskID]
  if (!start) return undefined
  const chain: Subtask[] = [start]
  const seen = new Set<Id>([start.id])
  let current = start
  let hostAnswered = isNativeTurn(start)
  while (current.parentID) {
    const parent = subtasks[current.parentID]
    if (!parent || seen.has(parent.id)) break
    seen.add(parent.id)
    chain.push(parent)
    hostAnswered ||= isNativeTurn(parent)
    current = parent
  }
  return { root: current, chain: chain.reverse(), hostAnswered }
}
