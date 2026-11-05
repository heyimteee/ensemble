import type { Memory } from "../types.ts"
import { chromeJoin } from "./separators.ts"

export type MemoryStatus = "reviewed" | "needs review" | "promoted"

/**
 * Slice D status mapping (ticket #62). The memory model records origin and
 * scope directly; status is derived from provenance history so later edits
 * never erase the origin:
 * - any `promoted` history entry -> "promoted" (global promotion happened),
 * - automatic origin with no user `edited`/`promoted` touch -> "needs review",
 * - everything else (manual, or automatic touched by the user) -> "reviewed".
 */
export function memoryStatus(memory: Memory): MemoryStatus {
  if (memory.history.some((entry) => entry.action === "promoted")) return "promoted"
  if (memory.origin === "automatic" && !memory.history.some((entry) => entry.action === "edited" || entry.action === "promoted")) {
    return "needs review"
  }
  return "reviewed"
}

export function memoryNeedsReview(memory: Memory): boolean {
  return memoryStatus(memory) === "needs review"
}

/** Second-line grammar: `origin │ scope │ status` (brief section 2.6). */
export function memoryProvenanceLine(memory: Memory): string {
  return chromeJoin([memory.origin, memory.scope, memoryStatus(memory)])
}

/** Inline substring filter over fact text plus the provenance line. */
export function filterMemories(memories: Memory[], query: string): Memory[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return memories
  return memories.filter((memory) => `${memory.text} ${memoryProvenanceLine(memory)}`.toLowerCase().includes(needle))
}

/** Settings tab count: `Memories (n)`. */
export function memoryCountLabel(count: number): string {
  return `Memories (${count})`
}
