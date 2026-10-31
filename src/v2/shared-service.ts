import { EnsembleV2Service } from "./service.ts"

type Entry = {
  service: EnsembleV2Service
  stop: () => Promise<void>
  refs: number
}

/**
 * One Ensemble store per OpenCode process. OpenCode sets plugins up once per
 * location; without this registry each location keeps its own in-memory copy
 * of the same durable state and the last writer wins.
 */
export class SharedEnsemble {
  private pending: Promise<Entry> | undefined

  async acquire(ctx: any): Promise<{ service: EnsembleV2Service; release: () => Promise<void> }> {
    if (!this.pending) {
      this.pending = this.create(ctx).catch((error) => {
        this.pending = undefined
        throw error
      })
    }
    const entry = await this.pending
    entry.refs += 1
    let released = false
    return {
      service: entry.service,
      release: async () => {
        if (released) return
        released = true
        entry.refs -= 1
        if (entry.refs > 0) return
        this.pending = undefined
        await entry.stop()
      },
    }
  }

  private async create(ctx: any): Promise<Entry> {
    const service = new EnsembleV2Service(ctx)
    const stop = await service.start()
    return { service, stop, refs: 0 }
  }
}
