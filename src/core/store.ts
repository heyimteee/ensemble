import type { EnsembleState, Settings } from "./types.ts"

export const DEFAULT_SETTINGS: Settings = {
  maxConcurrentTurns: 3,
  chainLimit: 10,
  modelFallback: true,
}

export function createInitialState(settings: Partial<Settings> = {}): EnsembleState {
  const at = Date.now()
  return {
    schemaVersion: 1,
    version: 1,
    updatedAt: at,
    agents: {},
    channels: {},
    conversations: {},
    work: {},
    handoffs: {},
    approvals: {},
    memories: {},
    chains: {},
    settings: { ...DEFAULT_SETTINGS, ...settings },
  }
}

export type Mutation<Result> = (draft: EnsembleState) => Result | Promise<Result>

export type StoreOptions = {
  initial?: EnsembleState
  persist?: (state: EnsembleState) => Promise<void>
  onChange?: (state: EnsembleState) => void
}

/**
 * Serializes mutations and persists a complete snapshot after each change.
 * The persisted state is deliberately one JSON document: OpenCode's plugin
 * storage is durable, and Ensemble's state is small enough to replace.
 */
export class EnsembleStore {
  private current: EnsembleState
  private tail: Promise<unknown> = Promise.resolve()
  private readonly persist?: (state: EnsembleState) => Promise<void>
  private readonly onChange?: (state: EnsembleState) => void

  constructor(options: StoreOptions = {}) {
    this.current = options.initial ?? createInitialState()
    this.persist = options.persist
    this.onChange = options.onChange
  }

  snapshot(): EnsembleState {
    return structuredClone(this.current)
  }

  async mutate<Result>(mutation: Mutation<Result>): Promise<Result> {
    const run = this.tail.then(async () => {
      const draft = structuredClone(this.current)
      const result = await mutation(draft)
      draft.version = this.current.version + 1
      draft.updatedAt = Date.now()
      if (this.persist) await this.persist(draft)
      this.current = draft
      this.onChange?.(structuredClone(draft))
      return result
    })
    this.tail = run.catch(() => undefined)
    return run
  }
}
