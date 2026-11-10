import type { NativeFirstMode, Settings } from "./types.ts"

export const NATIVE_FIRST_MODES: readonly NativeFirstMode[] = ["off", "shadow", "on"]

export function isNativeFirstMode(value: unknown): value is NativeFirstMode {
  return typeof value === "string" && (NATIVE_FIRST_MODES as readonly string[]).includes(value)
}

/**
 * Read the native-first migration mode. A pre-flag or unset store is `off`,
 * which preserves the explicit-tool path (ADR 0011).
 */
export function nativeFirstMode(settings: Pick<Settings, "nativeFirst"> | undefined): NativeFirstMode {
  return settings?.nativeFirst && isNativeFirstMode(settings.nativeFirst) ? settings.nativeFirst : "off"
}
