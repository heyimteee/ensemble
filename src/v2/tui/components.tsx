import { For, Show } from "solid-js"
import type { Agent, Approval, Memory, Message, SkillOption, SnapshotState, Subtask, Workspace } from "../types.ts"
import type { Palette } from "./theme.ts"
import { agentName, busyCount, missingSkills, short, unreadCount, workspaceGroupLabel } from "./format.ts"

export type SettingsTab = "general" | "models" | "memories" | "skillbox"

export function WorkspaceRail(props: {
  colors: Palette
  groups: Array<{ directory: string; workspaces: Workspace[] }>
  activeWorkspaceID: string | null
  filter: string
  state: SnapshotState | null
  agents: Agent[]
  selectedAgentID: string | null
  pendingApprovals: number
  workspaceCount: number
  skillCatalog: SkillOption[]
}) {
  return (
    <box width={34} border borderStyle="single" borderColor={props.colors.border} backgroundColor={props.colors.bg} flexDirection="column" padding={1}>
      <text fg={props.colors.accent}>WORKSPACES {props.workspaceCount > 0 ? `(${props.workspaceCount})` : ""}</text>
      <Show when={props.filter}><text fg={props.colors.faint}>filter: {props.filter}</text></Show>
      <Show when={props.groups.length === 0}>
        <text fg={props.colors.muted}>No workspaces. Press n.</text>
      </Show>
      <For each={props.groups}>{(group) => (
        <>
          <text fg={props.colors.faint}>{workspaceGroupLabel(group.directory)}</text>
          <For each={group.workspaces}>{(workspace) => {
            const active = () => workspace.id === props.activeWorkspaceID
            const unread = () => unreadCount(props.state, workspace)
            const busy = () => busyCount(props.state, workspace.id)
            return (
              <text fg={active() ? props.colors.good : props.colors.text}>
                {active() ? "› " : "  "}#{workspace.name}
                {busy() > 0 ? ` ◐${busy()}` : ""}
                {unread() > 0 ? ` ●${unread()}` : ""}
              </text>
            )
          }}</For>
        </>
      )}</For>
      <text> </text>
      <text fg={props.colors.accent}>AGENTS</text>
      <For each={props.agents}>{(agent) => {
        const busy = () => Object.values(props.state?.subtasks ?? {}).some((task) => task.assigneeID === agent.id && task.state === "working" && task.workspaceID === props.activeWorkspaceID)
        const missing = () => missingSkills(agent, props.skillCatalog)
        return (
          <text fg={busy() ? props.colors.warn : props.selectedAgentID === agent.id ? props.colors.good : props.colors.text}>
            {busy() ? "◐ " : "  "}{agent.name}
            {props.state?.workspaces[props.activeWorkspaceID ?? ""]?.leaderID === agent.id ? " · leader" : ""}
            {agent.pendingSettings ? " · pending" : ""}
            {missing().length > 0 ? " · !" : ""}
          </text>
        )
      }}</For>
      <text> </text>
      <text fg={props.colors.accent}>APPROVALS {props.pendingApprovals > 0 ? `(${props.pendingApprovals})` : ""}</text>
      <text fg={props.colors.muted}>v opens inbox</text>
    </box>
  )
}

export function MessageList(props: { colors: Palette; messages: Message[]; state: SnapshotState | null; workspace?: Workspace }) {
  return (
    <>
      <For each={props.messages}>{(message) => <MessageLine colors={props.colors} message={message} state={props.state} workspace={props.workspace} />}</For>
      <Show when={props.messages.length === 0}>
        <text fg={props.colors.muted}>{props.workspace ? "Say something to your team." : "Create a workspace with n."}</text>
      </Show>
    </>
  )
}

function MessageLine(props: { colors: Palette; message: Message; state: SnapshotState | null; workspace?: Workspace }) {
  const name = () => props.message.author === "user" ? "You" : props.message.author === "system" ? "Ensemble" : agentName(props.state, props.message.agentID)
  const isLeader = () => props.message.agentID === props.workspace?.leaderID
  const color = () => props.message.author === "user"
    ? props.colors.good
    : props.message.author === "system"
      ? props.colors.muted
      : isLeader()
        ? props.colors.leader
        : props.colors.accent
  const prefix = () => `${name()}${isLeader() ? " · leader" : ""}${props.message.kind === "task" ? " · task" : ""}${props.message.kind === "approval" ? " · approval" : ""}: `
  return (
    <box flexDirection="row" paddingY={0}>
      <text fg={color()}>{prefix()}</text>
      <text fg={props.message.author === "system" ? props.colors.muted : props.colors.text}>{short(props.message.text, Math.max(8, 42 - prefix().length))}</text>
    </box>
  )
}

export function TaskBoard(props: {
  colors: Palette
  tasks: Subtask[]
  state: SnapshotState | null
  cursor: number
  activeCount: number
}) {
  const pending = () => props.tasks.filter((task) => task.state === "pending").slice(-5)
  const working = () => props.tasks.filter((task) => task.state === "working").slice(-5)
  const replied = () => props.tasks.filter((task) => task.state === "replied").slice(-5)
  return (
    <box width={40} border borderStyle="single" borderColor={props.colors.border} backgroundColor={props.colors.bg} flexDirection="column" padding={1}>
      <text fg={props.colors.accent}>SUBTASKS {props.activeCount > 0 ? `· ${props.activeCount} working` : ""}</text>
      <TaskGroup colors={props.colors} title="PENDING" tasks={pending()} state={props.state} cursor={props.cursor} offset={0} />
      <TaskGroup colors={props.colors} title="WORKING" tasks={working()} state={props.state} cursor={props.cursor} offset={pending().length} />
      <TaskGroup colors={props.colors} title="REPLIED" tasks={replied()} state={props.state} cursor={props.cursor} offset={pending().length + working().length} />
      <text> </text>
      <text fg={props.colors.muted}>d delegate · t reassign · ↵ result</text>
      <text fg={props.colors.muted}>r retry · R restart · x cancel · o native</text>
    </box>
  )
}

function TaskGroup(props: { colors: Palette; title: string; tasks: Subtask[]; state: SnapshotState | null; cursor: number; offset: number }) {
  return (
    <>
      <text fg={props.colors.muted}>{props.title} ({props.tasks.length})</text>
      <For each={props.tasks}>{(task, index) => (
        <text fg={props.cursor === props.offset + index() ? props.colors.good : task.state === "working" ? props.colors.warn : task.state === "replied" ? props.colors.text : props.colors.muted}>
          {props.cursor === props.offset + index() ? "› " : "  "}
          {task.state === "working" ? "◐ " : task.state === "replied" ? "● " : "○ "}
          {short(task.title, 17)} · {agentName(props.state, task.assigneeID)}
          {task.interrupted ? " · interrupted" : ""}
        </text>
      )}</For>
    </>
  )
}

export function ApprovalList(props: {
  colors: Palette
  approvals: Approval[]
  cursor: number
  state: SnapshotState | null
  onResolve: (approval: Approval) => Promise<void>
}) {
  return (
    <box flexDirection="column">
      <text fg={props.colors.accent}>Approvals inbox</text>
      <Show when={props.approvals.length === 0}><text fg={props.colors.muted}>Nothing waits for you.</text></Show>
      <For each={props.approvals}>{(approval, index) => (
        <box flexDirection="column">
          <text fg={props.cursor === index() ? props.colors.good : props.colors.warn}>
            {props.cursor === index() ? "› " : "  "}{approval.title}{approval.kind === "interrupted" ? " · interrupted" : ""}
          </text>
          <text fg={props.colors.muted}>{short(approval.detail, 100)}</text>
        </box>
      )}</For>
      <text fg={props.colors.muted}>↑/↓ select · Enter approve/decline · esc close</text>
    </box>
  )
}

const shortcutGroups: Array<{ title: string; entries: Array<[string, string]> }> = [
  { title: "Leader", entries: [["~", "Leader key"], ["~ ?", "This help"], ["~ q", "Leave Ensemble"], ["Esc", "Cancel leader mode"]] },
  { title: "Workspaces", entries: [["n", "New workspace"], ["w / W", "Next / previous workspace"], ["/", "Search workspaces"], ["Ctrl+W", "Archive workspace"], ["Ctrl+Shift+W", "Delete workspace"]] },
  { title: "Chat", entries: [["i", "Compose a message"], ["m", "Mention an agent"], ["@Name / !Name", "Address a message"]] },
  { title: "Subtasks", entries: [["d", "Delegate selected subtask"], ["t", "Reassign selected subtask"], ["Enter", "Open selected result"], ["r", "Retry selected subtask"], ["R", "Stop and restart selected subtask"], ["x", "Cancel selected subtask"], ["o", "Open native session"]] },
  { title: "Agents", entries: [["a", "New agent"], ["z / Z", "Next / previous agent"], ["s", "Agent settings"], ["Ctrl+A", "Archive selected agent"], ["Ctrl+Shift+A", "Delete selected agent"]] },
  { title: "Settings", entries: [["Tab", "Cycle settings tab"], ["e", "Edit setting"], ["b", "Add backup model"], ["Ctrl+↑ / Ctrl+↓", "Reorder last backup"], ["Ctrl+S", "Save settings"], ["Space", "Toggle skill"], ["Ctrl+F", "Filter skills"], ["Ctrl+D", "Delete memory"], ["Ctrl+P", "Promote memory"]] },
  { title: "Approvals", entries: [["v", "Open approvals inbox"], ["↑ / ↓", "Select approval"], ["Enter", "Approve or decline"]] },
]

export function HelpView(props: { colors: Palette }) {
  return (
    <box flexDirection="column">
      <text fg={props.colors.accent} bg={props.colors.bg} width="100%" truncate>Keyboard shortcuts</text>
      <For each={shortcutGroups}>{(group) => (
        <>
          <text fg={props.colors.leader} bg={props.colors.bg} width="100%" truncate>{group.title}</text>
          <For each={group.entries}>{(entry) => <text fg={props.colors.text} bg={props.colors.bg} width="100%" truncate>{entry[0].padEnd(16)} {entry[1]}</text>}</For>
        </>
      )}</For>
      <text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>~ is disabled while a dialog or text entry is active.</text>
    </box>
  )
}

export function SettingsView(props: {
  colors: Palette
  agent: Agent | null
  tab: SettingsTab
  dirty: boolean
  memories: Memory[]
  memoryCursor: number
  skills: SkillOption[]
  skillCursor: number
  skillFilter: string
  skillCatalog: SkillOption[]
}) {
  const missing = () => props.agent ? missingSkills(props.agent, props.skillCatalog) : []
  return (
    <Show when={props.agent} fallback={<text fg={props.colors.muted}>Select an agent and press s.</text>}>
      <box flexDirection="column">
        <text fg={props.colors.accent}>{props.agent!.name} · settings {props.dirty ? "· UNSAVED" : ""}{props.agent!.pendingSettings ? " · pending next task" : ""}</text>
        <text fg={props.colors.muted}>General · Models · Memories · Skillbox (Tab)</text>
        <Show when={props.tab === "general"}>
          <text>Name: {props.agent!.name}</text>
          <text>Title: {props.agent!.title}</text>
          <text>Role: {short(props.agent!.role || "(empty)", 100)}</text>
          <text fg={props.colors.muted}>e edits a field · Ctrl+S saves</text>
        </Show>
        <Show when={props.tab === "models"}>
          <text>Main: {props.agent!.mainModel.providerID}/{props.agent!.mainModel.modelID}{props.agent!.mainModel.variant ? `#${props.agent!.mainModel.variant}` : ""}</text>
          <For each={props.agent!.backupModels}>{(model, index) => <text fg={props.colors.muted}>Backup {index() + 1}: {model.providerID}/{model.modelID}</text>}</For>
          <text fg={props.colors.muted}>e main model · b add backup · ctrl+↑/↓ reorder last</text>
        </Show>
        <Show when={props.tab === "memories"}>
          <For each={props.memories}>{(memory, index) => (
            <text fg={props.memoryCursor === index() ? props.colors.good : props.colors.text}>[{memory.origin}/{memory.scope}] {short(memory.text, 80)} · {memory.source}</text>
          )}</For>
          <Show when={props.memories.length === 0}><text fg={props.colors.muted}>No memories.</text></Show>
          <text fg={props.colors.muted}>e add · Ctrl+D delete · Ctrl+P promote</text>
        </Show>
        <Show when={props.tab === "skillbox"}>
          <Show when={missing().length > 0}>
            <text fg={props.colors.bad}>Missing assigned skills: {missing().join(", ")}</text>
          </Show>
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
