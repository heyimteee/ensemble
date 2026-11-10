import type { Id } from "./types.ts"

/**
 * Ticket #224: the native session picker's read model.
 *
 * The picker lists recent sessions in the current scope, searches only inside
 * that scope, and refreshes from host session events rather than a timer
 * (ADR 0009). This module is pure: the service supplies host rows and the TUI
 * renders the returned candidates. No conversation content, absolute path, or
 * native transcript is part of a candidate.
 */
export const SESSION_PICKER_SCOPES = ["direct", "workspace", "project", "all"] as const
export type SessionPickerScope = (typeof SESSION_PICKER_SCOPES)[number]

/** The target conversation the session will serve. */
export type SessionPickerTarget = {
  kind: "workspace" | "direct" | "home"
  agentID: Id
  workspaceID?: Id
}

export type SessionPickerDirectoryContext = {
  /** The loaded project location, the plugin's own directory. */
  projectDirectory?: string
  /** The active workspace directory, when the target belongs to one. */
  workspaceDirectory?: string
  /** The directory of the target direct conversation (workspace or home). */
  directDirectory?: string
}

/** One host session row, normalized to the fields a picker needs. */
export type NativeSessionListing = {
  sessionID: string
  title?: string
  /** Host location directory; never logged, only compared and labeled. */
  directory?: string
  updatedAt?: number
  archived?: boolean
  /** A subagent child is never a conversation root. */
  parentID?: string | null
}

/** How a session currently relates to the binding it will be adopted into. */
export type SessionPickerBindingView = {
  /** Human conversation label, for example `#Ops group chat`. */
  conversation: string
  /** True when this is the target conversation's current session. */
  current: boolean
  /** True when the session is retired into a binding's history. */
  retired?: boolean
}

export type SessionPickerCandidate = {
  id: string
  label: string
  detail: string
  scope: SessionPickerScope
  directory?: string
  updatedAt?: number
  bound?: SessionPickerBindingView
}

export type SessionPickerListInput = {
  directory?: string
  search?: string
  parentID: null
  archived: false
  order: "desc"
  limit: number
}

export const DEFAULT_SESSION_PICKER_LIMIT = 20
export const MAX_SESSION_PICKER_LIMIT = 50

/**
 * Direct and workspace targets default to the scope a user is looking at:
 * a direct chat starts from the direct directory, a group chat from the
 * workspace directory. Project and All stay one key away.
 */
export function defaultSessionPickerScope(target: Pick<SessionPickerTarget, "kind">): SessionPickerScope {
  return target.kind === "workspace" ? "workspace" : "direct"
}

export function isSessionPickerScope(value: unknown): value is SessionPickerScope {
  return typeof value === "string" && (SESSION_PICKER_SCOPES as readonly string[]).includes(value)
}

export function normalizeSessionPickerScope(value: unknown, fallback: SessionPickerScope): SessionPickerScope {
  return isSessionPickerScope(value) ? value : fallback
}

/** Scope cycling for the picker's one-key scope switch. */
export function nextSessionPickerScope(scope: SessionPickerScope): SessionPickerScope {
  const index = SESSION_PICKER_SCOPES.indexOf(scope)
  return SESSION_PICKER_SCOPES[(index + 1) % SESSION_PICKER_SCOPES.length]
}

/**
 * Directories a scope reads. `all` returns no directory so the host lists
 * every location; a scope with no matching location returns nothing and the
 * caller must not widen it to `all` by accident.
 */
export function sessionPickerDirectories(
  scope: SessionPickerScope,
  context: SessionPickerDirectoryContext,
): string[] {
  if (scope === "all") return []
  if (scope === "direct") return context.directDirectory ? [context.directDirectory] : []
  if (scope === "workspace") return context.workspaceDirectory ? [context.workspaceDirectory] : []
  return context.projectDirectory ? [context.projectDirectory] : []
}

/**
 * Host `session.list` requests for one scope. Roots only, unarchived only, so
 * child and archived sessions never reach a picker row even when the host
 * ignores a filter. Search is sent to the host for economy; the pure filter
 * below is authoritative for the selected scope.
 */
export function sessionPickerListInputs(
  scope: SessionPickerScope,
  context: SessionPickerDirectoryContext,
  query: string,
  limit: number = MAX_SESSION_PICKER_LIMIT,
): SessionPickerListInput[] {
  const directories = sessionPickerDirectories(scope, context)
  if (scope !== "all" && directories.length === 0) return []
  const search = query.trim()
  const base: SessionPickerListInput = {
    ...(search ? { search } : {}),
    parentID: null,
    archived: false,
    order: "desc",
    limit: Math.max(1, Math.min(MAX_SESSION_PICKER_LIMIT, Math.trunc(limit))),
  }
  if (directories.length === 0) return [base]
  return directories.map((directory) => ({ ...base, directory }))
}

export function normalizeSessionDirectory(directory: string | undefined): string | undefined {
  if (typeof directory !== "string") return undefined
  const trimmed = directory.trim().replace(/[\\/]+$/, "")
  return trimmed.length > 0 ? trimmed : undefined
}

export function sameSessionDirectory(a: string | undefined, b: string | undefined): boolean {
  const left = normalizeSessionDirectory(a)
  const right = normalizeSessionDirectory(b)
  return left !== undefined && left === right
}

export function sessionInPickerScope(
  listing: Pick<NativeSessionListing, "directory">,
  scope: SessionPickerScope,
  context: SessionPickerDirectoryContext,
): boolean {
  if (scope === "all") return true
  const directories = sessionPickerDirectories(scope, context)
  return directories.some((directory) => sameSessionDirectory(directory, listing.directory))
}

function queryTokens(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

/** Basename only: a candidate never carries an absolute directory in its text. */
export function sessionDirectoryName(directory: string | undefined): string | undefined {
  const normalized = normalizeSessionDirectory(directory)
  if (!normalized) return undefined
  const parts = normalized.split(/[\\/]/).filter(Boolean)
  return parts.at(-1)
}

/**
 * Search matches the title, the session id, the location basename, and the
 * conversation it already serves. All tokens must match; an empty query keeps
 * the whole selected scope.
 */
export function sessionMatchesPickerQuery(
  listing: NativeSessionListing,
  query: string,
  binding?: SessionPickerBindingView,
): boolean {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return true
  const haystack = [
    listing.title ?? "",
    listing.sessionID,
    sessionDirectoryName(listing.directory) ?? "",
    binding?.conversation ?? "",
  ]
    .join(" ")
    .toLowerCase()
  return tokens.every((token) => haystack.includes(token))
}

function compareRecent(a: NativeSessionListing, b: NativeSessionListing): number {
  const left = typeof a.updatedAt === "number" ? a.updatedAt : 0
  const right = typeof b.updatedAt === "number" ? b.updatedAt : 0
  if (left !== right) return right - left
  return a.sessionID.localeCompare(b.sessionID)
}

function candidateLabel(listing: NativeSessionListing): string {
  const title = typeof listing.title === "string" ? listing.title.trim() : ""
  return title.length > 0 ? title : listing.sessionID
}

function candidateDetail(listing: NativeSessionListing, binding: SessionPickerBindingView | undefined): string {
  const parts: string[] = []
  if (binding?.current) parts.push("in use")
  else if (binding?.retired) parts.push(`previous · ${binding.conversation}`)
  else if (binding) parts.push(`serves ${binding.conversation}`)
  else parts.push("available")
  const where = sessionDirectoryName(listing.directory)
  if (where) parts.push(where)
  return parts.join(" · ")
}

/**
 * Recent sessions for the selected scope. Archived rows, child sessions, and
 * out-of-scope rows are dropped before search and ranking, so a search cannot
 * surface a session the selected scope excludes.
 */
export function sessionPickerCandidates(
  listings: readonly NativeSessionListing[],
  options: {
    scope: SessionPickerScope
    context: SessionPickerDirectoryContext
    query?: string
    limit?: number
    bindings?: Readonly<Record<string, SessionPickerBindingView | undefined>>
  },
): SessionPickerCandidate[] {
  const query = options.query ?? ""
  const limit = Math.max(1, Math.min(MAX_SESSION_PICKER_LIMIT, Math.trunc(options.limit ?? DEFAULT_SESSION_PICKER_LIMIT)))
  const seen = new Set<string>()
  return listings
    .filter((listing) => {
      if (!listing?.sessionID || seen.has(listing.sessionID)) return false
      seen.add(listing.sessionID)
      if (listing.archived) return false
      if (listing.parentID) return false
      if (!sessionInPickerScope(listing, options.scope, options.context)) return false
      return sessionMatchesPickerQuery(listing, query, options.bindings?.[listing.sessionID])
    })
    .sort(compareRecent)
    .slice(0, limit)
    .map((listing) => {
      const bound = options.bindings?.[listing.sessionID]
      return {
        id: listing.sessionID,
        label: candidateLabel(listing),
        detail: candidateDetail(listing, bound),
        scope: options.scope,
        ...(listing.directory ? { directory: listing.directory } : {}),
        ...(typeof listing.updatedAt === "number" ? { updatedAt: listing.updatedAt } : {}),
        ...(bound ? { bound } : {}),
      }
    })
}

/**
 * Host events that can change a picker row, its title, its archive state, or
 * its location. The service emits one refresh signal per claimed event; the
 * picker never runs on a timer.
 */
export const SESSION_PICKER_EVENT_TYPES = [
  "session.created",
  "session.deleted",
  "session.moved",
  "session.archived",
  "session.unarchived",
  "session.renamed",
  "session.metadata.updated",
  "session.permissions",
  "session.forked",
  // Forward compatibility: earlier host generations used one update event.
  "session.updated",
] as const

export function sessionPickerEventRefresh(type: unknown): boolean {
  return typeof type === "string" && (SESSION_PICKER_EVENT_TYPES as readonly string[]).includes(type)
}

/** True when a refresh revision is newer than the applied one. */
export function sessionPickerRevisionChanged(previous: unknown, next: unknown): boolean {
  return typeof next === "number" && Number.isFinite(next) && (typeof previous !== "number" || next > previous)
}
