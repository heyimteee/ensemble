/**
 * Ticket #124 Settings one-shot feedback.
 *
 * Settings actions acknowledge once: a save, a newly added memory, a skill
 * assignment change, and a missing-skill warning each produce one explicit
 * signal. A signal may light a row or header for one short window, then settle
 * to its final color/state; it never loops and snapshot refreshes do not
 * restart it. Reduced motion skips the decorative window and mounts at the
 * final state. Pure helpers only; the app owns the clock and rendering.
 */

import { isReducedMotion } from "./motion.ts"

export type SettingsFeedbackKind = "saved" | "memory-added" | "skill-changed" | "missing-skills"

export type SettingsFeedback = {
  kind: SettingsFeedbackKind
  /** Row identity for memory/skill feedback, or the stable missing-set key. */
  key: string | null
  /** Wall-clock time the signal fired, used only to end its one-shot window. */
  at: number
}

/** Length of one acknowledgement window. Lit once, then settled. */
export const SETTINGS_FLASH_MS = 600

/** Build one explicit feedback signal. */
export function settingsFeedbackSignal(
  kind: SettingsFeedbackKind,
  key: string | null = null,
  at: number = Date.now(),
): SettingsFeedback {
  return { kind, key, at }
}

/** True only during the single window after the signal fired. */
export function settingsFlashActive(
  feedback: SettingsFeedback | null,
  now: number,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!feedback) return false
  if (isReducedMotion(env)) return false
  const elapsed = now - feedback.at
  return elapsed >= 0 && elapsed < SETTINGS_FLASH_MS
}

export type SettingsAcknowledgement = {
  saved: boolean
  savedFlash: boolean
  memoryID: string | null
  memoryFlash: boolean
  skillID: string | null
  skillFlash: boolean
  missingFlash: boolean
}

/**
 * Render-facing view of the current signal: the settled state flags and the
 * one-shot flash flags. Under reduced motion every flash flag is false while
 * the settled flags remain, so the final state is kept without motion.
 */
export function settingsAcknowledgement(
  feedback: SettingsFeedback | null,
  now: number,
  env: NodeJS.ProcessEnv = process.env,
): SettingsAcknowledgement {
  const flash = settingsFlashActive(feedback, now, env)
  return {
    saved: feedback?.kind === "saved",
    savedFlash: flash && feedback?.kind === "saved",
    memoryID: feedback?.kind === "memory-added" ? feedback.key : null,
    memoryFlash: flash && feedback?.kind === "memory-added",
    skillID: feedback?.kind === "skill-changed" ? feedback.key : null,
    skillFlash: flash && feedback?.kind === "skill-changed",
    missingFlash: flash && feedback?.kind === "missing-skills",
  }
}

/** Stable identity for a missing set: order and duplicates do not matter. */
export function missingSkillsKey(missing: readonly string[]): string {
  return [...new Set(missing)].sort().join("\u0000")
}

export type MissingSkillsTracker = { key: string }

export function createMissingSkillsTracker(): MissingSkillsTracker {
  return { key: "" }
}

/**
 * One-shot missing-skill emphasis: returns a signal only when a non-empty set
 * appears or changes. The same set on a later snapshot/paint returns null, so
 * the warning never loops. Clearing the set resets the tracker so a later
 * reappearance can acknowledge once more.
 */
export function trackMissingSkills(
  tracker: MissingSkillsTracker,
  missing: readonly string[],
  at: number = Date.now(),
): SettingsFeedback | null {
  const key = missingSkillsKey(missing)
  if (key === tracker.key) return null
  tracker.key = key
  if (!key) return null
  return settingsFeedbackSignal("missing-skills", key, at)
}
