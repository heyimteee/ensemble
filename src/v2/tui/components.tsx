import { For, Show } from "solid-js"
import type { Agent, Approval, Memory, SkillOption, SnapshotState, Subtask } from "../types.ts"
import type { Palette } from "./theme.ts"
import { agentColor, agentName, busyCount, missingSkills, renderMarkdownLines, short, unreadCount } from "./format.ts"

export type SettingsTab = "general" | "models" | "memories" | "skillbox"

export type RailItem = {
  kind: "agent" | "workspace"
  id: string
  title: string
  detail?: string
  group?: string
}

export type ChatLine = {
  id: string
  author: string
  role: "user" | "agent" | "system"
  text: string
  kind?: string
  streaming?: boolean
  interrupted?: boolean
  createdAt: number
}

export function Rail(props: {
  colors: Palette
  items: RailItem[]
  cursor: number
  focus: boolean
  activeWorkspaceID: string | null
  state: SnapshotState | null
  pendingApprovals: number
  width: number
  filter: string
}) {
  return (
    <box width={props.width} border borderStyle="single" borderColor={props.colors.border} backgroundColor={props.colors.bg} flexDirection="column" padding={1}>
      <For each={props.items}>{(item, index) => {
        const previous = index() > 0 ? props.items[index() - 1] : undefined
        const kindHeader = item.kind !== previous?.kind ? item.kind.toUpperCase() + "S" : ""
        const groupHeader = item.group && item.group !== previous?.group ? item.group : ""
        const selected = props.cursor === index()
        const leader = item.kind === "agent" && props.state?.workspaces[props.activeWorkspaceID ?? ""]?.leaderID === item.id
        const workspace = item.kind === "workspace" ? props.state?.workspaces[item.id] : undefined
        const unread = workspace ? unreadCount(props.state, workspace) : 0
        const busy = workspace ? busyCount(props.state, workspace.id) : 0
        return (
          <>
            <Show when={kindHeader === "WORKSPACES"}>
              <text fg={props.colors.faint} bg={props.colors.bg} width="100%" truncate>────────</text>
            </Show>
            <Show when={kindHeader}>
              <text fg={props.colors.faint} bg={props.colors.bg} width="100%" truncate>{kindHeader}</text>
            </Show>
            <Show when={groupHeader}>
              <text fg={props.colors.faint} bg={props.colors.bg} width="100%" truncate>  {groupHeader}</text>
            </Show>
            <text fg={selected ? (props.focus ? props.colors.good : props.colors.warn) : props.colors.text} bg={props.colors.bg} width="100%" truncate>
              {selected ? "› " : "  "}{item.kind === "workspace" ? `#${item.title}` : item.title}
              {leader ? " · leader" : ""}
              {item.detail ? ` · ${item.detail}` : ""}
              {workspace?.paused ? " ⏸" : ""}
              {busy > 0 ? ` ◐${busy}` : ""}
              {unread > 0 ? ` ●${unread}` : ""}
            </text>
          </>
        )
      }}</For>
      <Show when={props.items.length === 0}><text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>No agents or workspaces yet.</text></Show>
      <text> </text>
      <text fg={props.colors.accent} bg={props.colors.bg} width="100%" truncate>APPROVALS {props.pendingApprovals > 0 ? `(${props.pendingApprovals})` : ""}</text>
      <text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>v opens inbox</text>
    </box>
  )
}

export function Transcript(props: {
  colors: Palette
  messages: ChatLine[]
  width: number
  emptyTitle: string
  emptyBody: string
  busy: boolean
  queued: number
}) {
  return (
    <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" width="100%">
      <Show when={props.messages.length > 0} fallback={
        <box flexDirection="column" padding={1}>
          <text fg={props.colors.accent} bg={props.colors.bg} width="100%" truncate>{props.emptyTitle}</text>
          <text fg={props.colors.muted} bg={props.colors.bg} width="100%" wrapMode="word">{props.emptyBody}</text>
        </box>
      }>
        <For each={props.messages}>{(message) => {
          const color = message.role === "user" ? props.colors.good : message.role === "system" ? props.colors.muted : props.colors.accent
          const lines = renderMarkdownLines(message.text || (message.streaming ? "…" : ""), Math.max(16, props.width))
          return (
            <box flexDirection="column" paddingY={0} marginTop={1}>
              <text fg={color} bg={props.colors.bg} width="100%" truncate>
                {message.author}{message.kind === "task" ? " · task" : ""}{message.kind === "approval" ? " · approval · v to resolve" : ""}{message.streaming ? " · streaming…" : ""}{message.interrupted ? " · interrupted" : ""}
              </text>
              <For each={lines}>{(line) => <text fg={message.role === "system" ? props.colors.muted : props.colors.text} bg={props.colors.bg} width="100%" truncate>{line || " "}</text>}</For>
            </box>
          )
        }}</For>
      </Show>
      <Show when={props.busy}><text fg={props.colors.warn} bg={props.colors.bg} width="100%" truncate>▍ working…</text></Show>
      <Show when={props.queued > 0}><text fg={props.colors.warn} bg={props.colors.bg} width="100%" truncate>queued messages: {props.queued}</text></Show>
    </scrollbox>
  )
}

export function TaskBoard(props: {
  colors: Palette
  tasks: Subtask[]
  state: SnapshotState | null
  cursor: number
  activeCount: number
  focus: boolean
  width: number
}) {
  const groups = () => [
    { title: "PENDING", tasks: props.tasks.filter((task) => task.state === "pending") },
    { title: "WORKING", tasks: props.tasks.filter((task) => task.state === "working") },
    { title: "REPLIED", tasks: props.tasks.filter((task) => task.state === "replied") },
  ]
  return (
    <box width={props.width} border borderStyle="single" borderColor={props.colors.border} backgroundColor={props.colors.bg} flexDirection="column" padding={1}>
      <text fg={props.colors.accent} bg={props.colors.bg} width="100%" truncate>SUBTASKS {props.activeCount > 0 ? `· ${props.activeCount} working` : ""}</text>
      <TaskGroups colors={props.colors} groups={groups()} state={props.state} cursor={props.cursor} focus={props.focus} />
      <text> </text>
      <text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>d delegate · t reassign · ↵ result</text>
      <text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>r retry · R restart · x cancel · o native</text>
    </box>
  )
}

function TaskGroups(props: { colors: Palette; groups: Array<{ title: string; tasks: Subtask[] }>; state: SnapshotState | null; cursor: number; focus: boolean }) {
  return (
    <For each={props.groups}>{(group, groupIndex) => {
      const base = props.groups.slice(0, groupIndex()).reduce((sum, item) => sum + item.tasks.length, 0)
      return (
        <>
          <text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>{group.title} ({group.tasks.length})</text>
          <For each={group.tasks}>{(task, index) => (
            <text fg={props.cursor === base + index() ? (props.focus ? props.colors.good : props.colors.warn) : task.state === "working" ? props.colors.warn : props.colors.text} bg={props.colors.bg} width="100%" truncate>
              {props.cursor === base + index() ? "› " : "  "}{task.state === "working" ? "◐ " : task.state === "replied" ? "● " : "○ "}
              {short(task.title, 18)} · {agentName(props.state, task.assigneeID)}{task.interrupted ? " · interrupted" : ""}
            </text>
          )}</For>
        </>
      )
    }}</For>
  )
}

export function ApprovalList(props: { colors: Palette; approvals: Approval[]; cursor: number; state: SnapshotState | null; onResolve: (approval: Approval) => Promise<void> }) {
  return (
    <box flexDirection="column">
      <text fg={props.colors.accent} bg={props.colors.bg} width="100%" truncate>Approvals inbox</text>
      <Show when={props.approvals.length === 0}><text fg={props.colors.muted}>Nothing waits for you.</text></Show>
      <For each={props.approvals}>{(approval, index) => (
        <box flexDirection="column">
          <text fg={props.cursor === index() ? props.colors.good : props.colors.warn} bg={props.colors.bg} width="100%" truncate>{props.cursor === index() ? "› " : "  "}{approval.title}</text>
          <text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>{short(approval.detail, 80)}</text>
        </box>
      )}</For>
      <text fg={props.colors.muted}>↑/↓ select · Enter approve/decline · esc close</text>
    </box>
  )
}

const shortcutGroups: Array<{ title: string; entries: Array<[string, string]> }> = [
  { title: "Leader", entries: [["~", "Leader key"], ["~ ?", "This help"], ["~ q", "Leave Ensemble"], ["Esc", "Cancel leader mode"]] },
  { title: "Navigation", entries: [["h / l", "Previous / next column"], ["j / k", "Next / previous item"], ["Enter", "Open selected chat"], ["i", "Focus composer"], ["Esc", "Leave composer"]] },
  { title: "Workspaces", entries: [["n", "New workspace"], ["g", "Edit members and leader"], ["w / W", "Next / previous workspace"], ["/", "Search workspaces"], ["p", "Pause or resume"], ["Ctrl+G", "Init Ensemble in this workspace"]] },
  { title: "Chat", entries: [["$Name", "Mention an agent"], ["@path", "Reference a workspace file"], ["/command", "Ensemble commands"], ["PageUp / PageDown", "Scroll transcript"]] },
  { title: "Subtasks", entries: [["d", "Delegate"], ["t", "Reassign"], ["Enter", "Open result"], ["r", "Retry"], ["R", "Restart"], ["x", "Cancel"], ["o", "Open native session"]] },
  { title: "Agents", entries: [["a", "New agent"], ["z / Z", "Next / previous agent"], ["s", "Agent settings"], ["Ctrl+A", "Archive agent"], ["Ctrl+Shift+A", "Delete agent"]] },
  { title: "Settings", entries: [["Tab", "Cycle tab"], ["e", "Edit"], ["b", "Add backup"], ["Ctrl+↑ / Ctrl+↓", "Move backup"], ["Backspace", "Remove backup"], ["Ctrl+S", "Save"], ["Space", "Toggle skill"], ["Ctrl+F", "Filter skills"]] },
]

export function HelpView(props: { colors: Palette }) {
  return (
    <scrollbox flexGrow={1} stickyScroll stickyStart="top" width="100%">
      <box flexDirection="column">
        <text fg={props.colors.accent}>Keyboard shortcuts</text>
        <For each={shortcutGroups}>{(group) => (
          <>
            <text fg={props.colors.leader}>{group.title}</text>
            <For each={group.entries}>{(entry) => <text fg={props.colors.text}>{entry[0].padEnd(16)} {entry[1]}</text>}</For>
          </>
        )}</For>
        <text fg={props.colors.muted}>~ is disabled while the composer or a dialog is active.</text>
      </box>
    </scrollbox>
  )
}

export function SettingsView(props: {
  colors: Palette
  agent: Agent | null
  tab: SettingsTab
  dirty: boolean
  memories: Memory[]
  memoryCursor: number
  backupCursor: number
  skills: SkillOption[]
  skillCursor: number
  skillFilter: string
  skillCatalog: SkillOption[]
}) {
  const missing = () => props.agent ? missingSkills(props.agent, props.skillCatalog) : []
  return (
    <Show when={props.agent} fallback={<text fg={props.colors.muted}>Select an agent and press s.</text>}>
      <box flexDirection="column">
        <text fg={props.colors.accent} bg={props.colors.bg} width="100%" truncate>{props.agent!.name} · settings {props.dirty ? "· UNSAVED" : ""}{props.agent!.pendingSettings ? " · pending next task" : ""}</text>
        <text fg={props.colors.muted}>General · Models · Memories · Skillbox (Tab)</text>
        <Show when={props.tab === "general"}>
          <text>Name: {props.agent!.name}</text>
          <text>Title: {props.agent!.title}</text>
          <text>Role: {short(props.agent!.role || "(empty)", 100)}</text>
          <text fg={props.colors.muted}>e edits a field · Ctrl+S saves</text>
        </Show>
        <Show when={props.tab === "models"}>
          <text>Main: {props.agent!.mainModel.providerID}/{props.agent!.mainModel.modelID}{props.agent!.mainModel.variant ? `#${props.agent!.mainModel.variant}` : ""}</text>
          <For each={props.agent!.backupModels}>{(model, index) => <text fg={props.backupCursor === index() ? props.colors.good : props.colors.muted}>{props.backupCursor === index() ? "› " : "  "}Backup {index() + 1}: {model.providerID}/{model.modelID}</text>}</For>
          <text fg={props.colors.muted}>e main · b add · ctrl+↑/↓ move · backspace remove</text>
        </Show>
        <Show when={props.tab === "memories"}>
          <For each={props.memories}>{(memory, index) => (
            <text fg={props.memoryCursor === index() ? props.colors.good : props.colors.text}>[{memory.origin}/{memory.scope}] {short(memory.text, 80)} · {memory.source}</text>
          )}</For>
          <Show when={props.memories.length === 0}><text fg={props.colors.muted}>No memories.</text></Show>
          <text fg={props.colors.muted}>e add · Ctrl+D delete · Ctrl+P promote</text>
        </Show>
        <Show when={props.tab === "skillbox"}>
          <Show when={missing().length > 0}><text fg={props.colors.bad}>Missing assigned skills: {missing().join(", ")}</text></Show>
          <text fg={props.colors.muted}>Filter: {props.skillFilter || "(none)"} · Ctrl+F</text>
          <For each={props.skills.slice(0, 40)}>{(skill, index) => (
            <text fg={props.skillCursor === index() ? props.colors.good : props.colors.text}>{props.agent!.skillbox.includes(skill.id) ? "[x]" : "[ ]"} {skill.name} ({skill.id})</text>
          )}</For>
          <text fg={props.colors.muted}>Space toggles · empty means no optional skills</text>
        </Show>
        <text fg={props.colors.muted}>Ctrl+S save · Esc cancel</text>
      </box>
    </Show>
  )
}
