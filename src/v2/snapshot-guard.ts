/**
 * Snapshot version guard for the TUI refresh path. Snapshot RPC responses
 * can arrive out of order (a 250ms poll overlapping an event-triggered
 * refresh); applying an older response over newer state would repaint stale
 * rows, cursors, and work items. The guard keeps the highest applied store
 * version and drops anything older. Equal versions still apply: the store
 * version only moves on durable writes, while models/skills/configError can
 * change without a version bump.
 */
export function shouldApplySnapshot(lastAppliedVersion: number | undefined, nextVersion: number): boolean {
  if (lastAppliedVersion === undefined) return true
  return nextVersion >= lastAppliedVersion
}
