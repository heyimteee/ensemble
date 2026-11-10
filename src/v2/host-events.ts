/**
 * Host event identity for realm-wide deduplication (ticket #154).
 *
 * OpenCode sets the plugin up once per location. If the host event bus is
 * global, every location can observe the same event; if it is location-scoped,
 * only the owning location observes it. The realm claims an identity before
 * handling so both host shapes process each event exactly once.
 *
 * Every current `V2Event` carries a host `id`, which is the primary identity.
 * Older or synthetic events may omit it. For the small set of subscribed types
 * we derive a key only from fields that identify that event; when those fields
 * are absent (for example a bare `config.updated` with no timestamp) we return
 * `undefined` and process the event instead of guessing it away.
 */
export const RECENT_HOST_EVENT_LIMIT = 512

export function hostEventKey(event: any): string | undefined {
  const id = event?.id
  if (typeof id === "string" && id.length > 0) return `id:${id}`
  if (typeof id === "number" && Number.isFinite(id)) return `id:${id}`

  const type = typeof event?.type === "string" ? event.type : ""
  if (!type) return undefined
  const data = event?.data ?? {}
  const created = typeof event?.created === "number" ? event.created : undefined
  const sessionID = typeof data?.sessionID === "string" ? data.sessionID : ""

  switch (type) {
    case "session.text.delta": {
      // `ordinal` identifies the delta inside one assistant message.
      if (sessionID && data?.ordinal !== undefined) {
        return `${type}:${sessionID}:${String(data.assistantMessageID ?? "")}:${String(data.ordinal)}`
      }
      if (sessionID && created !== undefined) return `${type}:${sessionID}:${created}:${String(data.delta ?? "")}`
      return undefined
    }
    case "session.idle":
      return sessionID && created !== undefined ? `${type}:${sessionID}:${created}` : undefined
    case "permission.asked":
      return sessionID && data?.id ? `${type}:${sessionID}:${String(data.id)}` : undefined
    case "permission.replied":
      return sessionID && data?.requestID
        ? `${type}:${sessionID}:${String(data.requestID)}:${String(data.reply ?? "")}`
        : undefined
    case "file.edited":
      return created !== undefined ? `${type}:${String(data?.file ?? "")}:${created}` : undefined
    case "session.tool.input.started":
    case "session.tool.called":
    case "session.tool.progress":
    case "session.tool.success":
    case "session.tool.failed":
      return sessionID && data?.id
        ? `${type}:${sessionID}:${String(data.assistantMessageID ?? "")}:${String(data.id)}:${String(created ?? "")}`
        : undefined
    case "session.execution.started":
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      return sessionID && created !== undefined ? `${type}:${sessionID}:${created}` : undefined
    case "session.created":
      return sessionID
        ? `${type}:${sessionID}:${String(data?.parentID ?? "")}:${String(created ?? "")}`
        : undefined
    case "session.deleted":
      return sessionID ? `${type}:${sessionID}:${String(created ?? "")}` : undefined
    case "session.moved":
    case "session.archived":
    case "session.unarchived":
    case "session.renamed":
    case "session.metadata.updated":
    case "session.permissions":
    case "session.forked":
    case "session.updated":
      return sessionID ? `${type}:${sessionID}:${String(created ?? "")}` : undefined
    case "config.updated":
      return created !== undefined ? `${type}:${created}` : undefined
    case "skill.updated":
    case "model.updated":
    case "provider.updated":
      return created !== undefined ? `${type}:${created}` : undefined
    default:
      return undefined
  }
}

/**
 * Retry hooks are not host events, so the host supplies no id. The session,
 * attempt, and error type/message identify one retry decision; a duplicate
 * delivery of that decision must not apply a second policy write.
 */
export function retryEventKey(event: any): string | undefined {
  const sessionID = typeof event?.sessionID === "string" ? event.sessionID : ""
  if (!sessionID) return undefined
  return [
    "session.retry",
    sessionID,
    String(event?.attempt ?? ""),
    String(event?.error?.type ?? ""),
    String(event?.error?.message ?? ""),
  ].join(":")
}

/** Bounded insertion-ordered set of recently claimed host event identities. */
export class RecentHostEvents {
  private readonly seen = new Set<string>()
  private readonly limit: number

  constructor(limit = RECENT_HOST_EVENT_LIMIT) {
    this.limit = limit
  }

  claim(event: any): boolean {
    return this.claimKey(hostEventKey(event))
  }

  claimKey(key: string | undefined): boolean {
    // No safe identity means "handle it"; dedupe must never drop a real event.
    if (!key) return true
    if (this.seen.has(key)) return false
    this.seen.add(key)
    while (this.seen.size > this.limit) {
      const oldest = this.seen.values().next().value
      if (oldest === undefined) break
      this.seen.delete(oldest)
    }
    return true
  }

  clear(): void {
    this.seen.clear()
  }
}
