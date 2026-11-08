import type { ModelOption, ModelRef, SkillOption } from "./types.ts"

function listData(value: any): any[] {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.data)) return value.data
  return []
}

function sameModels(left: ModelOption[], right: ModelOption[]): boolean {
  return left.length === right.length && left.every((model, index) => {
    const other = right[index]
    return model.providerID === other?.providerID
      && model.modelID === other.modelID
      && model.name === other.name
      && model.variants.length === other.variants.length
      && model.variants.every((variant, variantIndex) => variant === other.variants[variantIndex])
  })
}

function sameSkills(left: SkillOption[], right: SkillOption[]): boolean {
  return left.length === right.length && left.every((skill, index) => {
    const other = right[index]
    return skill.id === other?.id && skill.name === other.name && skill.description === other.description
  })
}

function sanitizeCatalogError(error: unknown): string {
  const raw = String((error as any)?.message ?? error ?? "unknown error")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, "//[redacted]@")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "[redacted]")
    .replace(/(password|authorization|api[_-]?key|token)\s*[:=]?\s*\S+/gi, "$1=[redacted]")
    .trim()
  return raw.slice(0, 200) || "unknown error"
}

export class Catalog {
  private readonly ctx: any
  private readonly onChange?: () => void
  private models: ModelOption[] = []
  private skills: SkillOption[] = []
  private promise: Promise<void> | undefined
  private queuedSource: any
  private queuedSourceSet = false
  private failure: string | undefined
  private generation = 0
  private revisionValue = 0
  lastRefreshedAt = 0

  constructor(ctx: any, onChange?: () => void) {
    this.ctx = ctx
    this.onChange = onChange
  }

  /** Monotonic revision for catalog metadata changes that do not bump the store. */
  get revision(): number {
    return this.revisionValue
  }

  get modelOptions(): ModelOption[] {
    return this.models
  }

  get skillOptions(): SkillOption[] {
    return this.skills
  }

  /** Last model-catalog failure, safe to show in the UI. Undefined when models are available. */
  get lastError(): string | undefined {
    return this.failure
  }

  refresh(source?: any): Promise<void> {
    const ctx = source ?? this.ctx
    if (this.promise) {
      // A location-scoped update that arrives during a refresh from another
      // location must still be read. Queue one follow-up instead of dropping
      // the event into the coalesced in-flight pass.
      if (ctx !== this.ctx) {
        this.queuedSource = ctx
        this.queuedSourceSet = true
      }
      return this.promise
    }
    const generation = ++this.generation
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, 10_000) })
    const work = (async () => {
      const [modelsResult, skillsRaw] = await Promise.all([
        ctx.model.list().then((value: any) => ({ value, error: undefined as unknown }), (error: unknown) => ({ value: [], error })),
        ctx.skill.list().catch(() => []),
      ])
      // A timed-out earlier attempt must not clobber a newer refresh.
      if (generation !== this.generation) return
      const nextModels = listData(modelsResult.value).map((model: any) => ({
        providerID: model.providerID,
        modelID: model.id ?? model.modelID,
        name: model.name ?? model.id ?? model.modelID,
        variants: Array.isArray(model.variants) ? model.variants.map((variant: any) => (typeof variant === "string" ? variant : variant.id)).filter(Boolean) : [],
      }))
      const nextFailure = modelsResult.error
        ? `OpenCode model list failed: ${sanitizeCatalogError(modelsResult.error)}`
        : nextModels.length === 0
          ? "OpenCode reported no models for this project."
          : undefined
      const nextSkills = listData(skillsRaw).map((skill: any) => ({ id: skill.id, name: skill.name ?? skill.id, description: skill.description }))
      if (!sameModels(this.models, nextModels) || !sameSkills(this.skills, nextSkills) || this.failure !== nextFailure) this.revisionValue++
      this.models = nextModels
      this.skills = nextSkills
      this.failure = nextFailure
      this.lastRefreshedAt = Date.now()
      this.onChange?.()
    })().catch(() => undefined)
    this.promise = Promise.race([work, timeout]).finally(() => {
      if (timer) clearTimeout(timer)
      this.promise = undefined
      if (this.queuedSourceSet) {
        const next = this.queuedSource
        this.queuedSource = undefined
        this.queuedSourceSet = false
        void this.refresh(next)
      }
    })
    return this.promise
  }

  async ensureModels(): Promise<ModelOption[]> {
    if (this.models.length === 0) {
      await Promise.race([this.refresh(), new Promise<void>((resolve) => setTimeout(resolve, 1500))])
    }
    return this.models
  }

  validate(model: ModelRef): void {
    if (!model.providerID || !model.modelID) throw Object.assign(new Error("Choose a provider and model."), { code: "invalid_model" })
    const option = this.models.find((item) => item.providerID === model.providerID && item.modelID === model.modelID)
    if (!option) throw Object.assign(new Error("That model is not available in this project."), { code: "invalid_model" })
    if (model.variant && !option.variants.includes(model.variant)) throw Object.assign(new Error(`Reasoning variant "${model.variant}" is not supported by ${model.modelID}.`), { code: "invalid_model" })
  }
}
