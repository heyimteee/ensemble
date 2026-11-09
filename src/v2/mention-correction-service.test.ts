import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EnsembleV2Service } from "./service.ts"
import { startServiceForTest } from "./test-service.ts"
import { V2Store } from "./store.ts"

/**
 * Ticket #200: one bounded correction turn when a final answer names a
 * teammate but the run created no work for that member. The correction may
 * create the work through the existing tool, or the agent may remove the
 * mention. A still-unbacked answer finalizes normally with a visible system
 * warning; nothing is ever dispatched from prose and the correction never
 * loops.
 */

type Handlers = {
  snapshot: (input: unknown) => Promise<any>
  invoke: (input: unknown) => Promise<any>
}

function fakeContext() {
  const values = new Map<string, unknown>()
  const tools = new Map<string, any>()
  const ctx = {
    onboarding: false,
    storage: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => { values.set(key, value) },
      remove: async (key: string) => { values.delete(key) },
      scan: async ({ prefix, after, limit }: any) => {
        const entries = [...values.entries()]
          .filter(([key]) => key.startsWith(prefix) && (!after || key > after))
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, limit ?? 500)
          .map(([key, value]) => ({ key, value }))
        return { entries, next: entries.length === (limit ?? 500) ? entries.at(-1)?.key : undefined }
      },
    },
    session: {
      hook: async () => ({ dispose: async () => undefined }),
      create: async ({ title }: any) => ({ data: { id: `session_${title}_${Math.random().toString(36).slice(2, 8)}`, title } }),
      instructions: { entry: { put: async () => undefined } },
      switchModel: async () => undefined,
      prompt: async () => undefined,
      wait: async () => { await new Promise((resolve) => setTimeout(resolve, 5)) },
      context: async () => assistant("Finished the work."),
      interrupt: async () => undefined,
      remove: async () => undefined,
      move: async ({ sessionID, directory }: any) => ({ data: { id: sessionID, directory } }),
      command: async () => ({ data: {} }),
    },
    tool: { transform: async (factory: any) => factory({ namespace() {}, add(tool: any) { tools.set(tool.name, tool) } }) },
    rpc: {
      register: async (_schema: unknown, value: Handlers) => {
        handlers.snapshot = value.snapshot
        handlers.invoke = value.invoke
        return { events: { emit: async () => undefined } }
      },
    },
    model: {
      list: async () => [{ providerID: "probe", id: "probe-model", name: "Probe", variants: [] }],
    },
    skill: { list: async () => [] },
    event: {
      subscribe: async function* () {
        while (true) await new Promise<void>(() => undefined)
      },
    },
  }
  const handlers: Partial<Handlers> = {}
  return { ctx, handlers: handlers as Handlers, tools }
}

function assistant(text: string) {
  return { data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text }] }] }
}

async function waitFor(check: () => Promise<boolean>, timeout = 8000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for condition")
}

async function seedDelegatedTask(ctx: any, directory: string, taskID: string): Promise<void> {
  const seed = new V2Store(ctx)
  await seed.load()
  for (const [id, name] of [["nova", "Nova"], ["sage", "Sage"], ["echo", "Echo"]] as const) {
    await seed.saveAgent({ id, name, title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  }
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "nova", memberIDs: ["nova", "sage", "echo"], synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  await seed.saveBinding({ workspaceID: "w", agentID: "sage", sessionID: "sess_sage", kind: "workspace", directory, agentVersion: 1, updatedAt: 1 })
  await seed.saveSubtask({
    id: taskID, workspaceID: "w", creatorType: "user", assigneeID: "sage",
    title: "Prepare update", instruction: "Prepare the update.", mode: "research", state: "pending",
    stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 0, createdAt: 1, workKind: "delegation", queueKey: `mention:w:sage:${taskID}`, dispatchGroupID: "dispatch_mention",
  })
}

function writeHandoffFile(directory: string): string {
  mkdirSync(join(directory, ".ensemble", "handoffs"), { recursive: true })
  writeFileSync(join(directory, ".ensemble", "handoffs", "follow-up.md"), "---\nensemble: handoff\ntask: Follow up with Echo\n---\n# Handoff\n")
  return ".ensemble/handoffs/follow-up.md"
}

function correctionPrompts(prompts: Array<{ sessionID: string; text: string }>): Array<{ sessionID: string; text: string }> {
  return prompts.filter((item) => item.text.includes("Mention correction"))
}

// The correction can repair the turn: calling ensemble_handoff creates the
// work, the refreshed policy sees the backing row, and the turn follows the
// normal wait-for-child/synthesis path instead of warning.
test("ticket200: an unbacked mention gets one correction and the created work finalizes normally", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-mention-"))
  const { ctx, tools } = fakeContext()
  const prompts: Array<{ sessionID: string; text: string }> = []
  let sageCalls = 0
  ;(ctx.session as any).context = async ({ sessionID }: any) => {
    if (sessionID !== "sess_sage") return assistant("Finished the work.")
    sageCalls++
    if (sageCalls === 1) return assistant("Done. $Echo can take the follow-up.")
    if (sageCalls === 2) return assistant("Handed to $Echo.")
    return assistant("Synthesis complete.")
  }
  ;(ctx.session as any).prompt = async (input: any) => {
    prompts.push({ sessionID: input.sessionID, text: input.text })
    if (!input.text.includes("Mention correction")) return
    const path = writeHandoffFile(directory)
    const handed = await tools.get("handoff").execute(
      { maxHops: 0, task: "Follow up with Echo", to: "Echo", instruction: "Take the follow-up and report back.", path },
      { sessionID: "sess_sage" },
    )
    assert.match(handed.content, /Handed to \$Echo/)
  }
  await seedDelegatedTask(ctx, directory, "task_mention")
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks as any).task_mention?.state === "replied"
    })
    const after = await handlers.snapshot({ directory })
    const rows = after.state.subtasks as any
    const corrections = correctionPrompts(prompts)
    assert.equal(corrections.length, 1, "exactly one bounded correction turn")
    assert.match(corrections[0].text, /ensemble_handoff/)
    assert.match(corrections[0].text, /ensemble_delegate/)
    assert.match(corrections[0].text, /\$Echo/, "the correction names the unbacked member")
    assert.equal(rows.task_mention.attempts, 2, "the correction adds no execution attempt; only the initial and synthesis runs were claimed")
    assert.equal(rows.task_mention.mentionCorrectionSent, true, "the correction marker is durable")
    const handoffs = Object.values(rows).filter(
      (task: any) => task.parentID === "task_mention" && task.workKind === "handoff" && task.assigneeID === "echo" && task.handoff?.completion !== true,
    ) as any[]
    assert.equal(handoffs.length, 1, "the correction created exactly one visible work row")
    const texts = ((after.state.messages.w ?? []) as any[]).map((message: any) => message.text)
    assert.equal(texts.some((text) => text.includes("Unbacked mention")), false, "repaired work never warns")
    assert.ok(texts.some((text) => text === "Handed to $Echo."), "the corrected answer is the final reply")
    assert.equal(rows.task_mention.state, "replied")
    assert.equal(rows.task_mention.status, "replied")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

// The first answer already created work for the member it names. The policy
// accepts it immediately; no correction prompt and no warning.
test("ticket200: a mention backed by work created in the run needs no correction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-mention-"))
  const { ctx, tools } = fakeContext()
  const prompts: Array<{ sessionID: string; text: string }> = []
  let sageCalls = 0
  let firstPrompt = true
  ;(ctx.session as any).context = async ({ sessionID }: any) => {
    if (sessionID !== "sess_sage") return assistant("Finished the work.")
    sageCalls++
    return sageCalls === 1 ? assistant("Done. $Echo has the follow-up.") : assistant("Synthesis complete.")
  }
  ;(ctx.session as any).prompt = async (input: any) => {
    prompts.push({ sessionID: input.sessionID, text: input.text })
    if (!firstPrompt || input.sessionID !== "sess_sage") return
    firstPrompt = false
    const path = writeHandoffFile(directory)
    const handed = await tools.get("handoff").execute(
      { maxHops: 0, task: "Follow up with Echo", to: "Echo", instruction: "Take the follow-up and report back.", path },
      { sessionID: "sess_sage" },
    )
    assert.match(handed.content, /Handed to \$Echo/)
  }
  await seedDelegatedTask(ctx, directory, "task_backed")
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks as any).task_backed?.state === "replied"
    })
    const after = await handlers.snapshot({ directory })
    const rows = after.state.subtasks as any
    assert.equal(correctionPrompts(prompts).length, 0, "backed mentions never trigger correction")
    assert.equal(rows.task_backed.attempts, 2, "only the initial and synthesis runs are claimed")
    assert.equal(rows.task_backed.mentionCorrectionSent, undefined, "no correction marker is spent")
    const handoffs = Object.values(rows).filter(
      (task: any) => task.parentID === "task_backed" && task.workKind === "handoff" && task.assigneeID === "echo" && task.handoff?.completion !== true,
    ) as any[]
    assert.equal(handoffs.length, 1)
    const texts = ((after.state.messages.w ?? []) as any[]).map((message: any) => message.text)
    assert.equal(texts.some((text) => text.includes("Unbacked mention")), false)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

// A durable marker survives a fresh service run: the contract does not grant
// a second correction after a crash or restart, it only warns.
test("ticket200: a durable correction marker prevents a second correction after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-mention-"))
  const { ctx } = fakeContext()
  const prompts: Array<{ sessionID: string; text: string }> = []
  ;(ctx.session as any).context = async ({ sessionID }: any) => {
    if (sessionID !== "sess_sage") return assistant("Finished the work.")
    return assistant("Done. $Echo can take the follow-up.")
  }
  ;(ctx.session as any).prompt = async (input: any) => {
    prompts.push({ sessionID: input.sessionID, text: input.text })
  }
  await seedDelegatedTask(ctx, directory, "task_restart")
  // Persist the marker as if a previous process had already corrected once.
  const seed = new V2Store(ctx)
  await seed.load()
  const row = seed.subtask("task_restart")!
  row.mentionCorrectionSent = true
  await seed.saveSubtask(row)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks as any).task_restart?.state === "replied"
    })
    const after = await handlers.snapshot({ directory })
    assert.equal(correctionPrompts(prompts).length, 0, "a durable marker never grants a second correction")
    const texts = ((after.state.messages.w ?? []) as any[]).map((message: any) => message.text)
    assert.ok(texts.some((text) => text.includes("Unbacked mention") && text.includes("$Echo")))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket200: a still-unbacked mention warns visibly, creates no work, and never loops", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-mention-"))
  const { ctx } = fakeContext()
  const prompts: Array<{ sessionID: string; text: string }> = []
  ;(ctx.session as any).context = async ({ sessionID }: any) => {
    if (sessionID !== "sess_sage") return assistant("Finished the work.")
    return assistant("Done. $Echo can take the follow-up.")
  }
  ;(ctx.session as any).prompt = async (input: any) => {
    prompts.push({ sessionID: input.sessionID, text: input.text })
  }
  await seedDelegatedTask(ctx, directory, "task_unbacked")
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks as any).task_unbacked?.state === "replied"
    })
    const after = await handlers.snapshot({ directory })
    const rows = after.state.subtasks as any
    const corrections = correctionPrompts(prompts)
    assert.equal(corrections.length, 1, "exactly one correction turn")
    assert.equal(rows.task_unbacked.attempts, 1, "no execution attempt is consumed")
    assert.equal(rows.task_unbacked.mentionCorrectionSent, true, "the marker survives the turn")
    assert.equal(rows.task_unbacked.state, "replied", "the answer still finalizes")
    assert.equal(rows.task_unbacked.status, "replied", "card status is unchanged")
    const texts = ((after.state.messages.w ?? []) as any[]).map((message: any) => message.text)
    assert.ok(texts.some((text) => text === "Done. $Echo can take the follow-up."), "the answer is not silently dropped")
    const warnings = texts.filter((text) => text.includes("Unbacked mention"))
    assert.equal(warnings.length, 1, "one visible warning")
    assert.match(warnings[0], /\$Echo/, "the warning names the member")
    assert.equal(
      Object.values(rows).some((task: any) => task.parentID === "task_unbacked" && task.assigneeID === "echo"),
      false,
      "prose never creates work automatically",
    )
    const settledPrompts = prompts.length
    await new Promise((resolve) => setTimeout(resolve, 500))
    const settled = await handlers.snapshot({ directory })
    assert.equal(prompts.length, settledPrompts, "no second correction turn")
    assert.equal((settled.state.subtasks as any).task_unbacked.attempts, 1, "no second native execution")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
