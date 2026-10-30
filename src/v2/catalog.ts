import type { ModelOption, ModelRef, SkillOption } from "./types.ts"

function listData(value: any): any[] {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.data)) return value.data
  return []
}

export class Catalog {
  private readonly ctx: any
  private readonly onChange?: () => void
  private models: ModelOption[] = []
  private skills: SkillOption[] = []
  private promise: Promise<void> | undefined
  lastRefreshedAt = 0

  constructor(ctx: any, onChange?: () => void) {
    this.ctx = ctx
    this.onChange = onChange
  }

  get modelOptions(): ModelOption[] {
    return this.models
  }

  get skillOptions(): SkillOption[] {
    return this.skills
  }

  refresh(): Promise<void> {
    if (this.promise) return this.promise
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, 10_000) })
    const work = (async () => {
      const [modelsRaw, skillsRaw] = await Promise.all([this.ctx.model.list().catch(() => []), this.ctx.skill.list().catch(() => [])])
      this.models = listData(modelsRaw).map((model: any) => ({
        providerID: model.providerID,
        modelID: model.id ?? model.modelID,
        name: model.name ?? model.id ?? model.modelID,
        variants: Array.isArray(model.variants) ? model.variants.map((variant: any) => (typeof variant === "string" ? variant : variant.id)).filter(Boolean) : [],
      }))
      this.skills = listData(skillsRaw).map((skill: any) => ({ id: skill.id, name: skill.name ?? skill.id, description: skill.description }))
      this.lastRefreshedAt = Date.now()
      this.onChange?.()
    })().catch(() => undefined)
    this.promise = Promise.race([work, timeout]).finally(() => {
      if (timer) clearTimeout(timer)
      this.promise = undefined
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
