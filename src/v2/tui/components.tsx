import { For, Show, createSignal } from "solid-js"
import type { Agent, Approval, Memory, SkillOption, SnapshotState } from "../types.ts"
import type { Palette } from "./theme.ts"
import { busyCount, fuzzyMatch, missingSkills, short, unreadCount } from "./format.ts"
import { platformLabel } from "./platform.ts"
import { helpGroups, helpKeyLabel, shortcutGroups } from "./help.ts"
import { pickerWindow } from "./picker.ts"

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
  agentID?: string
  text: string
  kind?: string
  streaming?: boolean
  interrupted?: boolean
  queued?: boolean
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
    <box width={props.width} border borderStyle="single" borderColor={props.focus ? props.colors.focus : props.colors.border} backgroundColor={props.colors.bg} flexDirection="column" padding={1}>
      <For each={props.items}>{(item, index) => {
        const previous = index() > 0 ? props.items[index() - 1] : undefined
        const kindHeader = item.kind !== previous?.kind ? item.kind.toUpperCase() + "S" : ""
        const groupHeader = item.group && item.group !== previous?.group ? item.group : ""
        const selected = props.cursor === index()
        const agent = item.kind === "agent" ? props.state?.agents[item.id] : undefined
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
            <text fg={selected ? props.colors.good : props.colors.text} bg={props.colors.bg} width="100%" truncate>
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

function HelpEntries(props: { colors: Palette; groups: Array<{ title: string; entries: Array<[string, string]> }> }) {
  return (
    <box flexDirection="column">
      <For each={props.groups}>{(group) => (
        <>
          <text fg={props.colors.leader}>{group.title}</text>
          <For each={group.entries}>{(entry) => <text fg={props.colors.text}>{helpKeyLabel(entry[0]).padEnd(16)} {platformLabel(entry[1])}</text>}</For>
        </>
      )}</For>
      <Show when={props.groups.length === 0}><text fg={props.colors.muted}>No matching shortcuts.</text></Show>
      <text fg={props.colors.muted}>~ is disabled while the composer or a dialog is active.</text>
    </box>
  )
}

export function HelpView(props: { colors: Palette; scrollRef?: (value: any) => void }) {
  const [query, setQuery] = createSignal("")
  return (
    <box flexGrow={1} flexDirection="column" minHeight={0}>
      <text fg={props.colors.accent} flexShrink={0}>Keyboard shortcuts</text>
      <box height={3} minHeight={3} flexShrink={0} border borderStyle="single" borderColor={props.colors.focus} backgroundColor={props.colors.bg} paddingLeft={1} paddingRight={1}>
        <input ref={(value: any) => queueMicrotask(() => value?.focus?.())} placeholder="search shortcuts by key or action…" onInput={(value: string) => setQuery(value)} />
      </box>
      <scrollbox ref={(value: any) => props.scrollRef?.(value)} flexGrow={1} minHeight={0} stickyScroll stickyStart="top" width="100%">
        <Show when={query()} keyed fallback={<HelpEntries colors={props.colors} groups={shortcutGroups} />}>
          <HelpEntries colors={props.colors} groups={helpGroups(query())} />
        </Show>
      </scrollbox>
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
  backupCursor: number
  skills: SkillOption[]
  skillCursor: number
  skillFilter: string
  filterEditing: boolean
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
          <text fg={props.colors.muted}>{platformLabel("e edits a field · Ctrl+S saves")}</text>
        </Show>
        <Show when={props.tab === "models"}>
          <text>Main: {props.agent!.mainModel.providerID}/{props.agent!.mainModel.modelID}{props.agent!.mainModel.variant ? `#${props.agent!.mainModel.variant}` : ""}</text>
          <For each={props.agent!.backupModels}>{(model, index) => <text fg={props.backupCursor === index() ? props.colors.good : props.colors.muted}>{props.backupCursor === index() ? "› " : "  "}Backup {index() + 1}: {model.providerID}/{model.modelID}</text>}</For>
          <text fg={props.colors.muted}>{platformLabel("e main · b add · Ctrl+↑/↓ move · Backspace remove")}</text>
        </Show>
        <Show when={props.tab === "memories"}>
          <For each={props.memories}>{(memory, index) => (
            <text fg={props.memoryCursor === index() ? props.colors.good : props.colors.text}>[{memory.origin}/{memory.scope}] {short(memory.text, 80)} · {memory.source}</text>
          )}</For>
          <Show when={props.memories.length === 0}><text fg={props.colors.muted}>No memories.</text></Show>
          <text fg={props.colors.muted}>{platformLabel("e add · Ctrl+D delete · Ctrl+P promote")}</text>
        </Show>
        <Show when={props.tab === "skillbox"}>
          <Show when={missing().length > 0}><text fg={props.colors.bad}>Missing assigned skills: {missing().join(", ")}</text></Show>
          <text fg={props.colors.muted}>Filter: {props.skillFilter || "(none)"} · {platformLabel("Ctrl+F")}{props.filterEditing ? " · typing… enter done · esc cancel" : ""}</text>
          <For each={props.skills.slice(0, 40)}>{(skill, index) => (
            <text fg={props.skillCursor === index() ? props.colors.good : props.colors.text}>{props.agent!.skillbox.includes(skill.id) ? "[x]" : "[ ]"} {skill.name} ({skill.id})</text>
          )}</For>
          <text fg={props.colors.muted}>Space toggles · empty means no optional skills</text>
        </Show>
        <text fg={props.colors.muted}>{platformLabel("Ctrl+S save · Esc cancel")}</text>
      </box>
    </Show>
  )
}

export type PickerItem = { id: string; label: string; selected: boolean }

export function PickerOverlay(props: {
  colors: Palette
  title: () => string
  query: () => string
  items: () => PickerItem[]
  cursor: () => number
  multiple: () => boolean
}) {
  const slots = Array.from({ length: 8 }, (_, index) => index)
  const solid = (value: string) => value.replaceAll(" ", "\u00A0")
  return (
    <box width="100%" height={16} minHeight={16} flexShrink={0} border borderStyle="double" borderColor={props.colors.focus} backgroundColor={props.colors.panel} flexDirection="column" padding={1}>
      <text fg={props.colors.focus} bg={props.colors.bg} width="100%" truncate>{solid(props.title())}</text>
      <text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>{solid(`search: ${props.query() || "type to filter"} · ${props.items().length} matches`)}</text>
      <text fg={props.colors.faint} bg={props.colors.bg} width="100%" truncate>────────────────────────────────────────────────────────────</text>
      <For each={slots}>{(slot) => (
        <text fg={props.colors.text} bg={props.colors.bg} width="100%" truncate>{(() => {
          const items = props.items()
          const cursor = props.cursor()
          const offset = pickerWindow(cursor, items.length).start
          const item = items[offset + slot]
          if (!item) return ""
          const marker = props.multiple() ? (item.selected ? "[x] " : "[ ] ") : (item.selected ? "(•) " : "( ) ")
          return solid(`${offset + slot === cursor ? "›" : " "} ${marker}${item.label}`)
        })()}</text>
      )}</For>
      <text fg={props.colors.faint} bg={props.colors.bg} width="100%" truncate>{solid(`↑/↓ move · ${props.multiple() ? "space toggle · " : ""}enter confirm · esc cancel`)}</text>
    </box>
  )
}
