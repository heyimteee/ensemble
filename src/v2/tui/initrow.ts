/**
 * Ticket #118: the System Agent init row.
 *
 * Init is a staged job, not a measurable download. The row names the current
 * stage and shows four discrete stage marks; it never invents a percentage or
 * within-stage progress. The native `/init` call is opaque, so `running`
 * always reads as indeterminate. Pure mapping over a durable InitJob; the app
 * decides when the row is visible and threads the shared motion tick.
 */
import type { InitJob, InitPhase } from "../types.ts"
import { INIT_PHASES, SYSTEM_AGENT_NAME, initJobPhase, initPhaseDetail, initPhaseLabel } from "../system-agent.ts"
import { effectiveTick, workingFrame } from "./motion.ts"
import { chromeJoin, isAsciiTerminal } from "./separators.ts"

const STAGE_FILLED = "●"
const STAGE_EMPTY = "○"

/** Four discrete marks: stages reached (including current) are filled. */
export function initStageIndicator(phase: InitPhase, env?: NodeJS.ProcessEnv): string {
  const current = Math.max(0, INIT_PHASES.indexOf(phase))
  const filled = env && isAsciiTerminal(env) ? "#" : STAGE_FILLED
  const blank = env && isAsciiTerminal(env) ? "-" : STAGE_EMPTY
  return INIT_PHASES.map((_, index) => (index <= current ? filled : blank)).join(" ")
}

export type InitRow = {
  id: string
  messageID: string
  phase: InitPhase
  label: string
  detail: string
  stage: string
  /** Animated Braille liveness mark; reduced motion pins it to frame 0. */
  glyph: string
  startedAt: number
}

export function initRowForJob(job: InitJob, tick: number, env: NodeJS.ProcessEnv = process.env): InitRow {
  const phase = initJobPhase(job)
  return {
    id: job.id,
    messageID: job.messageID,
    phase,
    label: initPhaseLabel(phase),
    detail: initPhaseDetail(phase),
    stage: initStageIndicator(phase, env),
    glyph: workingFrame(effectiveTick(tick, env), env),
    startedAt: job.startedAt,
  }
}

/** Live rows only: running jobs in the active workspace, oldest first. */
export function activeInitJobs(jobs: Record<string, InitJob>, workspaceID: string | undefined): InitJob[] {
  if (!workspaceID) return []
  return Object.values(jobs)
    .filter((job) => job.workspaceID === workspaceID && job.state === "running")
    .sort((a, b) => a.startedAt - b.startedAt)
}

/**
 * Every init message in the workspace, including terminal jobs whose row may
 * still be settling. The generic streaming-activity line must not duplicate a
 * System Agent init row.
 */
export function initMessageIDs(jobs: Record<string, InitJob>, workspaceID: string | undefined): Set<string> {
  if (!workspaceID) return new Set<string>()
  return new Set(
    Object.values(jobs)
      .filter((job) => job.workspaceID === workspaceID)
      .map((job) => job.messageID),
  )
}

/** One full-width row: `{glyph} System Agent │ {phase} │ {stages} │ {detail}`. */
export function initRowText(row: InitRow): string {
  return chromeJoin([`${row.glyph} ${SYSTEM_AGENT_NAME}`, row.label, row.stage, row.detail])
}
