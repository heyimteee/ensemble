/**
 * Cached per-workspace file list for composer `@file` completion (ticket #176).
 *
 * The cache is the only source the palette filters. Discovery is asynchronous
 * and single-flight per workspace: a stale list renders immediately while one
 * background refresh runs, and repeated filter passes never spawn a process.
 * The current `fd` exclusions and depth cap are kept; the stored list, the
 * number of cached workspaces, and the refresh rate are bounded.
 */
import { execFile } from "node:child_process"

export const FILE_INDEX_MAX_FILES = 500
export const FILE_INDEX_MAX_DEPTH = 4
export const FILE_INDEX_MAX_WORKSPACES = 8
export const FILE_INDEX_REFRESH_MS = 1_000
export const FILE_INDEX_STALE_MS = 30_000
export const FILE_INDEX_EXCLUDED_DIRECTORIES = [".git", ".ensemble", "node_modules"] as const
export const FILE_INDEX_DISCOVERY_TIMEOUT_MS = 5_000
export const FILE_INDEX_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

export type FileIndexDiscover = (directory: string) => Promise<readonly string[]>

export type FileIndexOptions = {
  discover: FileIndexDiscover
  now?: () => number
  schedule?: (run: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancel?: (handle: ReturnType<typeof setTimeout>) => void
  /** Called after a successful refresh lands, so an open palette can repaint. */
  onUpdate?: (workspaceID: string, directory: string) => void
  maxFiles?: number
  maxWorkspaces?: number
  refreshIntervalMs?: number
  staleAfterMs?: number
}

export type FileIndex = {
  /** Cached paths; starts a bounded background refresh when cold or stale. */
  paths: (workspaceID: string, directory: string) => readonly string[]
  /** Prime or stale-refresh without making a promise; used on activation. */
  ensure: (workspaceID: string, directory: string) => void
  /** Explicit refresh. Rate-limited but guaranteed to run after the window. */
  refresh: (workspaceID: string, directory: string) => Promise<void>
  /** Resolve once no discovery, queued pass, or refresh timer remains. */
  whenIdle: () => Promise<void>
  stats: () => { workspaces: number; discoveries: number; inFlight: number }
  dispose: () => void
}

/** `fd` arguments, kept identical to the pre-index synchronous listing. */
export function fileIndexArguments(): string[] {
  const args = ["--type", "f", "--hidden"]
  for (const directory of FILE_INDEX_EXCLUDED_DIRECTORIES) args.push("--exclude", directory)
  args.push("--max-depth", String(FILE_INDEX_MAX_DEPTH), ".")
  return args
}

type ParseOptions = {
  maxFiles?: number
  maxDepth?: number
  excludedDirectories?: readonly string[]
}

/**
 * Normalize one discovered path list: relative slash paths only, no excluded
 * segments, no entries past the depth cap, deduped, sorted, and truncated.
 * A path with spaces is one entry and keeps its spaces verbatim.
 */
export function normalizeFileIndexPaths(paths: readonly string[], options: ParseOptions = {}): string[] {
  const maxFiles = Math.max(0, Math.min(FILE_INDEX_MAX_FILES, options.maxFiles ?? FILE_INDEX_MAX_FILES))
  const maxDepth = Math.max(1, Math.min(FILE_INDEX_MAX_DEPTH, options.maxDepth ?? FILE_INDEX_MAX_DEPTH))
  const excluded = new Set(options.excludedDirectories ?? FILE_INDEX_EXCLUDED_DIRECTORIES)
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const raw of paths) {
    if (typeof raw !== "string" || raw.length === 0) continue
    let path = raw.replace(/\r$/, "").replaceAll("\\", "/")
    while (path.startsWith("./")) path = path.slice(2)
    if (!path || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) continue
    const segments = path.split("/")
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || excluded.has(segment))) continue
    if (segments.length > maxDepth) continue
    if (seen.has(path)) continue
    seen.add(path)
    normalized.push(path)
    if (normalized.length >= maxFiles * 8) break
  }
  normalized.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  return normalized.slice(0, maxFiles)
}

/** Parse one `fd` stdout payload with the same normalization rules. */
export function parseFileIndexOutput(output: string, options: ParseOptions = {}): string[] {
  return normalizeFileIndexPaths(output.split("\n"), options)
}

/** Asynchronous `fd` discovery; never spawns synchronously on the TUI thread. */
export function discoverWorkspaceFiles(directory: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "fd",
      fileIndexArguments(),
      {
        cwd: directory,
        encoding: "utf8",
        timeout: FILE_INDEX_DISCOVERY_TIMEOUT_MS,
        maxBuffer: FILE_INDEX_MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error: Error | null, stdout: string) => {
        if (error) {
          reject(error)
          return
        }
        resolve(parseFileIndexOutput(stdout))
      },
    )
  })
}

type Entry = {
  id: string
  directory: string
  paths: readonly string[]
  /** Undefined until a successful discovery lands. */
  loadedAt?: number
  /** Undefined until the first discovery starts. */
  startedAt?: number
  running: boolean
  queued: boolean
  timer?: ReturnType<typeof setTimeout>
  waiters: Array<() => void>
}

/**
 * One cache plus one refresh loop. Every entry keeps its last successful list,
 * so callers always read synchronously and never wait on discovery.
 */
export function createFileIndex(options: FileIndexOptions): FileIndex {
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? ((run, delayMs) => setTimeout(run, delayMs))
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle))
  const maxFiles = Math.max(0, Math.min(FILE_INDEX_MAX_FILES, options.maxFiles ?? FILE_INDEX_MAX_FILES))
  const maxWorkspaces = Math.max(1, options.maxWorkspaces ?? FILE_INDEX_MAX_WORKSPACES)
  const refreshIntervalMs = Math.max(0, options.refreshIntervalMs ?? FILE_INDEX_REFRESH_MS)
  const staleAfterMs = Math.max(0, options.staleAfterMs ?? FILE_INDEX_STALE_MS)
  const entries = new Map<string, Entry>()
  let idleWaiters: Array<() => void> = []
  let discoveries = 0
  let disposed = false

  const isIdle = (entry: Entry) => !entry.running && !entry.queued && entry.timer === undefined
  const settleIdle = () => {
    if (!disposed && [...entries.values()].some((entry) => !isIdle(entry))) return
    const waiters = idleWaiters
    idleWaiters = []
    for (const resolve of waiters) resolve()
  }
  const settle = (entry: Entry) => {
    const waiters = entry.waiters
    entry.waiters = []
    for (const resolve of waiters) resolve()
    settleIdle()
  }
  const detach = (entry: Entry) => {
    if (entry.timer !== undefined) cancel(entry.timer)
    entry.timer = undefined
    entry.queued = false
    settle(entry)
  }
  const evict = () => {
    while (entries.size > maxWorkspaces) {
      const oldest = entries.entries().next().value
      if (!oldest) break
      entries.delete(oldest[0])
      detach(oldest[1])
    }
  }
  const entryFor = (workspaceID: string, directory: string): Entry => {
    const existing = entries.get(workspaceID)
    if (existing && existing.directory === directory) {
      entries.delete(workspaceID)
      entries.set(workspaceID, existing)
      return existing
    }
    if (existing) {
      entries.delete(workspaceID)
      detach(existing)
    }
    const entry: Entry = {
      id: workspaceID,
      directory,
      paths: [],
      running: false,
      queued: false,
      waiters: [],
    }
    entries.set(workspaceID, entry)
    evict()
    return entry
  }
  const settleIfCurrent = (entry: Entry, finish: () => void) => {
    if (entries.get(entry.id) === entry) finish()
    else settle(entry)
  }
  const start = (entry: Entry) => {
    if (disposed || entry.running || entry.timer !== undefined || entries.get(entry.id) !== entry) return
    entry.running = true
    entry.startedAt = now()
    discoveries++
    let discovery: Promise<readonly string[]>
    try {
      discovery = Promise.resolve(options.discover(entry.directory))
    } catch (error) {
      discovery = Promise.reject(error)
    }
    void discovery
      .then((paths) => {
        if (entries.get(entry.id) !== entry) return
        entry.paths = normalizeFileIndexPaths(paths, { maxFiles })
        entry.loadedAt = now()
        options.onUpdate?.(entry.id, entry.directory)
      })
      .catch(() => {
        // Keep the last successful list; a transient `fd` failure is not data.
      })
      .finally(() => {
        entry.running = false
        settleIfCurrent(entry, () => {
          if (entry.queued) {
            entry.queued = false
            begin(entry)
            return
          }
          settle(entry)
        })
      })
  }
  const begin = (entry: Entry) => {
    if (disposed || entry.running || entry.timer !== undefined || entries.get(entry.id) !== entry) return
    const wait = entry.startedAt === undefined ? 0 : refreshIntervalMs - (now() - entry.startedAt)
    if (wait > 0) {
      entry.timer = schedule(() => {
        entry.timer = undefined
        start(entry)
      }, wait)
      return
    }
    start(entry)
  }
  const ensure = (workspaceID: string, directory: string) => {
    if (disposed) return
    const entry = entryFor(workspaceID, directory)
    if (entry.running || entry.timer !== undefined) return
    if (entry.loadedAt !== undefined && now() - entry.loadedAt < staleAfterMs) return
    begin(entry)
  }
  const paths = (workspaceID: string, directory: string): readonly string[] => {
    if (disposed) return []
    const entry = entryFor(workspaceID, directory)
    const cached = entry.paths
    ensure(workspaceID, directory)
    return cached
  }
  const refresh = (workspaceID: string, directory: string): Promise<void> => {
    if (disposed) return Promise.resolve()
    const entry = entryFor(workspaceID, directory)
    return new Promise<void>((resolve) => {
      entry.waiters.push(resolve)
      if (entry.running) {
        entry.queued = true
        return
      }
      begin(entry)
    })
  }
  const whenIdle = (): Promise<void> => {
    if (disposed || [...entries.values()].every(isIdle)) return Promise.resolve()
    return new Promise<void>((resolve) => { idleWaiters.push(resolve) })
  }
  const stats = () => ({
    workspaces: entries.size,
    discoveries,
    inFlight: [...entries.values()].filter((entry) => entry.running).length,
  })
  const dispose = () => {
    if (disposed) return
    disposed = true
    const pending = [...entries.values()]
    entries.clear()
    for (const entry of pending) detach(entry)
    settleIdle()
  }
  return { paths, ensure, refresh, whenIdle, stats, dispose }
}
