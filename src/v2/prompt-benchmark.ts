import { contextForTask, promptForTask, recentGroupMessages } from "./execution.ts"
import { agentIdentity } from "./init-block.ts"
import { registerEnsembleTools } from "./tool-registrar.ts"
import { TOOL_SURFACE_TOOL_NAMES, type ToolSurface } from "./tool-surface.ts"
import type { Agent, Message, SnapshotState, Subtask, Workspace } from "./types.ts"

/**
 * Ticket #225 benchmark fixture. It is deliberately fixed and content-free:
 * the same 12-agent roster, 20 short group messages, one turn, and one budget
 * ledger are rendered through the pre-#225 text and the current text. Token
 * counts are a documented chars/4 estimate; schema bytes are exact JSON.
 *
 * Baselines were measured from `integration/native-first` at 8923d99 before
 * the contract and tool-surface changes. They are constants so the regression
 * test fails when the current implementation grows past the released contract.
 */

export type PromptSize = { chars: number; estimatedTokens: number }

export type ToolSurfaceSize = PromptSize & { count: number }

export type BenchmarkReport = {
  fixture: { members: number; recentMessages: number; turn: string }
  before: {
    toolSurface: ToolSurfaceSize
    identity: PromptSize
    turnContext: PromptSize
    totalPrompt: PromptSize
    toolCalls: number
    modelRoundTrips: number
  }
  after: {
    toolSurface: ToolSurfaceSize
    identity: PromptSize
    turnContext: PromptSize
    totalPrompt: PromptSize
    toolCalls: number
    modelRoundTrips: number
  }
  reduction: {
    toolSchemaPct: number
    identityPct: number
    turnContextPct: number
    totalPromptPct: number
  }
}

const MEMBER_NAMES = ["Nova", "Sage", "Echo", "Iris", "Milo", "Juno", "Kai", "Lena", "Otto", "Pia", "Quinn", "Rhea"] as const

const BASELINE = {
  toolSurface: { chars: 4821, estimatedTokens: 1206, count: 11 },
  identity: { chars: 10620, estimatedTokens: 2655 },
  turnContext: { chars: 2768, estimatedTokens: 692 },
} as const

export function size(text: string): PromptSize {
  return { chars: text.length, estimatedTokens: Math.ceil(text.length / 4) }
}

export function addSize(left: PromptSize, right: PromptSize): PromptSize {
  return {
    chars: left.chars + right.chars,
    estimatedTokens: left.estimatedTokens + right.estimatedTokens,
  }
}

export function schemaText(surface: ToolSurface): string {
  const tools: Array<{ name: string; description: string; input: unknown }> = []
  const fail = async () => ({ content: "" })
  registerEnsembleTools(
    {
      namespace() {},
      add(tool) { tools.push({ name: tool.name, description: tool.description, input: tool.input }) },
    },
    {
      workspaceInfo: fail,
      listWorkspaces: fail,
      listAgents: fail,
      taskStatus: fail,
      sendMessage: fail,
      handoff: fail,
      delegate: fail,
      review: fail,
      askPerson: fail,
      remember: fail,
      share: fail,
    },
    surface,
  )
  return JSON.stringify(tools)
}

export function toolSurfaceSize(surface: ToolSurface): ToolSurfaceSize {
  const text = schemaText(surface)
  return { ...size(text), count: TOOL_SURFACE_TOOL_NAMES[surface].length }
}

export function benchmarkFixture(directory = "/tmp/ensemble-benchmark-site"): {
  state: SnapshotState
  task: Subtask
  workspace: Workspace
  agent: Agent
} {
  const agents: Record<string, Agent> = {}
  MEMBER_NAMES.forEach((name, index) => {
    const id = `a${index}`
    agents[id] = {
      id,
      name,
      title: "",
      role: "",
      mainModel: { providerID: "benchmark", modelID: "benchmark" },
      backupModels: [],
      skillbox: [],
      color: "cyan",
      archived: false,
      pendingSettings: false,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    }
  })
  const workspace: Workspace = {
    id: "w",
    name: "site",
    directory,
    leaderID: "a0",
    memberIDs: MEMBER_NAMES.map((_, index) => `a${index}`),
    synthesis: true,
    archived: false,
    paused: false,
    nextSeq: 21,
    createdAt: 1,
    lastActiveAt: 1,
  }
  const task: Subtask = {
    id: "task_benchmark",
    workspaceID: "w",
    creatorType: "user",
    assigneeID: "a1",
    title: "Review the release notes",
    instruction: "Review the release notes and report blockers.",
    mode: "research",
    state: "working",
    stage: "initial",
    outcome: "pending",
    interrupted: false,
    awaitingChildren: false,
    attempts: 0,
    createdAt: 1,
    workKind: "turn",
    dispatchGroupID: "dispatch_benchmark",
    taskMaxHops: 4,
  }
  const state: SnapshotState = {
    version: 1,
    updatedAt: 1,
    agents,
    workspaces: { w: workspace },
    messages: {
      w: Array.from({ length: 20 }, (_, index) => ({
        id: `msg_${index}`,
        workspaceID: "w",
        author: index % 2 === 0 ? "user" : "agent",
        ...(index % 2 === 0 ? {} : { agentID: "a0" }),
        text: `Message ${index} with a representative sentence about the release.`,
        kind: "text",
        seq: index + 1,
        createdAt: index + 1,
      })),
    },
    subtasks: { task_benchmark: task },
    dispatchGroups: {
      dispatch_benchmark: {
        id: "dispatch_benchmark",
        workspaceID: "w",
        rootID: "dispatch_benchmark",
        continuationIndex: 0,
        maxHops: 8,
        usedHops: 2,
        depthMax: 8,
        commandMaxHops: 24,
        commandUsedHops: 3,
        maxContinuations: 2,
        continuationsUsed: 0,
        createdAt: 1,
      },
    },
    initJobs: {},
    nativeSubagents: {},
    bindings: {},
    memories: {},
    approvals: {},
    dmQueue: {},
    settings: {
      maxActiveRuns: 3,
      maxDelegations: 10,
      maxDepth: 5,
      synthesis: true,
      dispatchGroupMaxHops: 8,
      dispatchCommandMaxHops: 24,
      dispatchDepth: 8,
      dispatchContinuations: 2,
    },
    ui: {},
    runs: {},
  }
  return { state, task, workspace, agent: agents.a1! }
}

/**
 * Ticket #249 measurement fixture: one root synthesis over a five-branch
 * fan-out. It reuses the #225 roster and 20-message transcript, appends five
 * synthetic branch results, and measures the prompt the leader actually
 * receives. `removedRecentTranscript` is the exact old block the synthesis
 * context no longer carries; `representativeOutput` is a fixed concise summary
 * sample, not a live model measurement.
 */
export type SynthesisBenchmarkReport = {
  fixture: { branches: number; recentMessages: number }
  context: PromptSize
  prompt: PromptSize
  totalPrompt: PromptSize
  removedRecentTranscript: PromptSize
  representativeOutput: PromptSize
}

const BRANCH_NOTES = [
  "Install steps are correct on a clean machine; the only change needed is a note about the Node version.",
  "Migration notes match the schema; no data backfill is required for this release.",
  "Rollback path was exercised against staging and completed in under two minutes.",
  "Accessibility section is clear; contrast and keyboard notes are covered.",
  "Changelog links resolve and the version header matches the release candidate.",
] as const

const REPRESENTATIVE_SYNTHESIS_OUTPUT = [
  "Release notes review complete: no blockers. Sage checked the install steps, Echo verified the migration notes, Iris reviewed the rollback path, Milo cleared the accessibility section, and Juno confirmed the changelog links.",
  "One open item: the CDN cache header needs a staging run after the next deploy.",
].join("\n\n")

function synthesisBenchmarkFixture(): {
  state: SnapshotState
  task: Subtask
  workspace: Workspace
  agent: Agent
} {
  const base = benchmarkFixture()
  const root: Subtask = {
    ...base.task,
    id: "task_synthesis",
    assigneeID: base.workspace.leaderID,
    stage: "synthesis",
    state: "pending",
    outcome: "pending",
    workKind: "delegation",
  }
  const subtasks: Record<string, Subtask> = { task_synthesis: root }
  const results: Message[] = BRANCH_NOTES.map((text, index) => ({
    id: `msg_result_${index}`,
    workspaceID: "w",
    author: "agent",
    agentID: `a${index + 1}`,
    text,
    kind: "text",
    seq: 21 + index,
    createdAt: 21 + index,
  }))
  BRANCH_NOTES.forEach((_, index) => {
    subtasks[`branch_${index}`] = {
      id: `branch_${index}`,
      workspaceID: "w",
      creatorType: "agent",
      creatorAgentID: base.workspace.leaderID,
      parentID: "task_synthesis",
      assigneeID: `a${index + 1}`,
      title: "Review the release notes",
      instruction: "Review the release notes and report blockers.",
      mode: "research",
      state: "replied",
      stage: "initial",
      outcome: "succeeded",
      interrupted: false,
      awaitingChildren: false,
      attempts: 0,
      createdAt: index + 1,
      resultMessageID: `msg_result_${index}`,
      workKind: "handoff",
    }
  })
  const state: SnapshotState = {
    ...base.state,
    messages: { w: [...(base.state.messages.w ?? []), ...results] },
    subtasks,
  }
  return { state, task: root, workspace: base.workspace, agent: base.state.agents[base.workspace.leaderID]! }
}

export function synthesisBenchmark(): SynthesisBenchmarkReport {
  const { state, task, workspace, agent } = synthesisBenchmarkFixture()
  const context = contextForTask(state, task, workspace, agent)
  const prompt = promptForTask(task)
  const removedRecentTranscript = `<ensemble_recent_messages>\n${recentGroupMessages(state, workspace)}\n</ensemble_recent_messages>`
  return {
    fixture: { branches: BRANCH_NOTES.length, recentMessages: 20 },
    context: size(context),
    prompt: size(prompt),
    totalPrompt: addSize(size(context), size(prompt)),
    removedRecentTranscript: size(removedRecentTranscript),
    representativeOutput: size(REPRESENTATIVE_SYNTHESIS_OUTPUT),
  }
}

export function synthesisBenchmarkSummary(report: SynthesisBenchmarkReport = synthesisBenchmark()): string {
  return [
    `synthesis context ${report.context.chars} chars`,
    `synthesis prompt ${report.prompt.chars} chars`,
    `synthesis prompt total ${report.totalPrompt.chars} chars`,
    `removed recent transcript ${report.removedRecentTranscript.chars} chars`,
    `representative summary ${report.representativeOutput.chars} chars`,
  ].join("; ")
}

/**
 * Render the before/after report. `before` is the released baseline; `after`
 * is computed from the current source so drift is visible in one test.
 */
export function benchmarkReport(): BenchmarkReport {
  const { state, task, workspace, agent } = benchmarkFixture()
  const identity = size(agentIdentity(agent))
  const turnContext = size(contextForTask(state, task, workspace, agent))
  const nativeSurface = toolSurfaceSize("native")
  const legacySurface = toolSurfaceSize("legacy")
  const beforeTotal = addSize(BASELINE.identity, BASELINE.turnContext)
  const afterTotal = addSize(identity, turnContext)
  const pct = (before: number, after: number): number => Number(((1 - after / before) * 100).toFixed(1))
  return {
    fixture: { members: MEMBER_NAMES.length, recentMessages: 20, turn: "workspace group" },
    before: {
      toolSurface: { ...BASELINE.toolSurface },
      identity: { ...BASELINE.identity },
      turnContext: { ...BASELINE.turnContext },
      totalPrompt: beforeTotal,
      toolCalls: 1,
      modelRoundTrips: 2,
    },
    after: {
      toolSurface: nativeSurface,
      identity,
      turnContext,
      totalPrompt: afterTotal,
      toolCalls: 0,
      modelRoundTrips: 1,
    },
    reduction: {
      toolSchemaPct: pct(legacySurface.estimatedTokens, nativeSurface.estimatedTokens),
      identityPct: pct(BASELINE.identity.estimatedTokens, identity.estimatedTokens),
      turnContextPct: pct(BASELINE.turnContext.estimatedTokens, turnContext.estimatedTokens),
      totalPromptPct: pct(beforeTotal.estimatedTokens, afterTotal.estimatedTokens),
    },
  }
}

/** Compact one-line summary for the benchmark script and the verification record. */
export function benchmarkSummary(report: BenchmarkReport = benchmarkReport()): string {
  return [
    `prompt tokens ${report.before.totalPrompt.estimatedTokens} -> ${report.after.totalPrompt.estimatedTokens} (-${report.reduction.totalPromptPct}%)`,
    `tool schemas ${report.before.toolSurface.estimatedTokens} -> ${report.after.toolSurface.estimatedTokens} (-${report.reduction.toolSchemaPct}%)`,
    `tool calls ${report.before.toolCalls} -> ${report.after.toolCalls}`,
    `model round-trips ${report.before.modelRoundTrips} -> ${report.after.modelRoundTrips}`,
  ].join("; ")
}
