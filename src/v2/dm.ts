import type { ChatMessage } from "./types.ts"

/**
 * Direct-conversation transcript merge.
 *
 * The durable per-binding stored lines are authoritative for role "user":
 * native user messages are never rendered, so queue backlogs, onboarding
 * steer prompts, or dropped shapes can neither duplicate the user line nor
 * appear as phantom "You" lines. Assistant replies continue to come from
 * the native session; empty text never renders.
 */
export function mapNativeChat(messages: any[], agentName: string): ChatMessage[] {
  if (!Array.isArray(messages)) return []
  const mapped: ChatMessage[] = []
  for (const message of messages) {
    if (message?.type !== "user" && message?.type !== "assistant") continue
    const text = Array.isArray(message.content)
      ? message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n").trim()
      : ""
    if (!text) continue
    mapped.push({
      id: String(message.id ?? `chat_${mapped.length}`),
      role: message.type === "user" ? "user" : "assistant",
      author: message.type === "user" ? "You" : agentName,
      text,
      createdAt: Number(message.time?.created ?? 0),
    })
  }
  return mapped
}

export function mergeDmTranscript(stored: ChatMessage[], native: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = []
  for (const message of stored) {
    if (!message?.text || typeof message.text !== "string" || !message.text.trim()) continue
    merged.push({ ...message })
  }
  for (const message of native) {
    if (message?.role === "user") continue
    if (!message?.text || typeof message.text !== "string" || !message.text.trim()) continue
    if (message.role !== "assistant" && message.role !== "system") continue
    merged.push({ ...message })
  }
  merged.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    if (a.role !== b.role) return a.role === "user" ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return merged
}
