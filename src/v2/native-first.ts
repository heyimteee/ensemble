import type { Agent, NativeFirstMode, Settings } from "./types.ts"

export const NATIVE_FIRST_MODES: readonly NativeFirstMode[] = ["off", "shadow", "on"]

export function isNativeFirstMode(value: unknown): value is NativeFirstMode {
  return typeof value === "string" && (NATIVE_FIRST_MODES as readonly string[]).includes(value)
}

/**
 * Read the native-first migration mode (ticket #240). A pre-flag, unset, or
 * invalid store resolves to `on`: native-first is the default after the
 * cutover. Explicit `off` and `shadow` are always respected.
 */
export function nativeFirstMode(settings: Pick<Settings, "nativeFirst"> | undefined): NativeFirstMode {
  return settings?.nativeFirst && isNativeFirstMode(settings.nativeFirst) ? settings.nativeFirst : "on"
}

/**
 * The per-agent native mirror default. Only an explicit `false` turns it off;
 * a pre-toggle agent row and every new agent mirror by default.
 */
export function nativeMirrorEnabled(agent: Pick<Agent, "nativeMirror"> | undefined): boolean {
  return agent?.nativeMirror !== false
}
