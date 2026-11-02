import { For, Show, createSignal } from "solid-js"
import type { Agent, Approval, Memory, SkillOption, SnapshotState } from "../types.ts"
import { approvalSource } from "../types.ts"
import type { Palette } from "./theme.ts"
import { busyCount, fuzzyMatch, missingSkills, short, unreadCount } from "./format.ts"
import { capLineText, capSkills, settingsTabLine, skillAssigned, skillRowLabel, skillToggleMark } from "./skills.ts"
import { memoryNeedsReview, memoryProvenanceLine } from "./memories.ts"
import {
  backupRowLabel,
  generalFieldRows,
  memoriesEmptyLine,
  memoriesNoMatchLine,
  modelSummary,
  modelsEmptyLine,
  railAgentLabel,
  railGroupLine,
  settingsCursorMark,
  settingsDivider,
  settingsFieldRow,
  settingsHeader,
  settingsNoAgentLine,
  settingsSaveFooter,
  settingsSectionHeader,
  settingsTabFooter,
  skillboxEmptyLine,
  skillsUnavailableLine,
} from "./settings.ts"
import {
  approvalResolvingSuffix,
  approvalSourceTag,
  approvalsEmptyLine,
  helpEmptyLine,
  pickerEmptyLine,
  pickerFooter,
  railEmptyLine,
} from "./chrome.ts"
import { platformLabel } from "./platform.ts"
import { helpGroups, helpKeyLabel, shortcutGroups } from "./help.ts"
import { pickerWindow } from "./picker.ts"

export type SettingsTab = "general" | "models" | "memories" | "skillbox"

export type RailItem = {
  kind: "agent" | "workspace"
  id: string
  title: string
  detail?: string
  /** Agent-list description: the agent's title, rendered after the name. */
  description?: string
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
  correlationID?: string
  createdAt: number
}

export function Rail(props: {
  colors: Palette
  items: RailItem[]
  cursor: number
  focus: boolean
  cursorVisible: boolean
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
        const kindHeader = item.kind !== previous?.kind
          ? railGroupLine(item.kind, props.items.filter((entry) => entry.kind === item.kind).length)
          : ""
        const agentCount = props.items.filter((entry) => entry.kind === "agent").length
        const workspaceCount = props.items.length - agentCount
        const groupHeader = item.group && item.group !== previous?.group ? item.group : ""
        const selected = props.cursor === index()
        // Slice E single-cursor rule: the `›` position marker renders only on
        // the surface that owns the focus border, never on two surfaces at once.
        const agent = item.kind === "agent" ? props.state?.agents[item.id] : undefined
        const leader = item.kind === "agent" && props.state?.workspaces[props.activeWorkspaceID ?? ""]?.leaderID === item.id
        const workspace = item.kind === "workspace" ? props.state?.workspaces[item.id] : undefined
        const unread = workspace ? unreadCount(props.state, workspace) : 0
        const busy = workspace ? busyCount(props.state, workspace.id) : 0
        return (
          <>
            <Show when={kindHeader === railGroupLine("workspace", workspaceCount)}>
              <text fg={props.colors.faint} bg={props.colors.bg} width="100%" truncate>────────</text>
            </Show>
            <Show when={kindHeader}>
              <text fg={props.colors.faint} bg={props.colors.bg} width="100%" truncate>{kindHeader}</text>
            </Show>
            <Show when={groupHeader}>
              <text fg={props.colors.faint} bg={props.colors.bg} width="100%" truncate>  {groupHeader}</text>
            </Show>
            <text fg={selected ? props.colors.good : props.colors.text} bg={props.colors.bg} width="100%" truncate>
              {settingsCursorMark(selected && props.cursorVisible)}{item.kind === "workspace" ? `#${item.title}` : railAgentLabel(item.title, item.description ?? "")}
              {leader ? " · leader" : ""}
              {item.detail ? ` · ${item.detail}` : ""}
              {workspace?.paused ? " ⏸" : ""}
              {busy > 0 ? ` ◐${busy}` : ""}
              {unread > 0 ? ` ●${unread}` : ""}
            </text>
          </>
        )
      }}</For>
      <Show when={props.items.length === 0}><text fg={props.colors.muted} bg={props.colors.bg} width="100%" wrapMode="word">{railEmptyLine()}</text></Show>
      <text> </text>
      <text fg={props.colors.accent} bg={props.colors.bg} width="100%" truncate>APPROVALS {props.pendingApprovals > 0 ? `(${props.pendingApprovals})` : ""}</text>
      <text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>v opens inbox</text>
    </box>
  )
}


export function ApprovalList(props: { colors: Palette; approvals: Approval[]; cursor: number; resolvingID: string | null; state: SnapshotState | null; onResolve: (approval: Approval) => Promise<void> }) {
  return (
    <box flexDirection="column">
      <text fg={props.colors.accent} bg={props.colors.bg} width="100%" truncate>Approvals inbox</text>
      <Show when={props.approvals.length === 0}><text fg={props.colors.muted}>{approvalsEmptyLine()}</text></Show>
      <For each={props.approvals}>{(approval, index) => (
        <box flexDirection="column">
          <text fg={props.cursor === index() ? props.colors.good : props.colors.warn} bg={props.colors.bg} width="100%" truncate>{props.cursor === index() ? "› " : "  "}[{approvalSourceTag(approvalSource(approval))}] {approval.title}{approvalResolvingSuffix(props.resolvingID === approval.id)}</text>
          <text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>{short(approval.detail, 80)}</text>
        </box>
      )}</For>
      <text fg={props.colors.muted}>↑/↓ select · Enter approve/decline · esc cancel</text>
    </box>
  )
}

function HelpEntries(props: { colors: Palette; groups: Array<{ title: string; entries: Array<[string, string]> }> }) {
  return (
    <box flexDirection="column">
      <For each={props.groups}>{(group) => (
        <>
          <text fg={props.colors.muted}>{group.title}</text>
          <For each={group.entries}>{(entry) => <text fg={props.colors.text}>{helpKeyLabel(entry[0]).padEnd(16)} {platformLabel(entry[1])}</text>}</For>
        </>
      )}</For>
      <Show when={props.groups.length === 0}><text fg={props.colors.muted}>{helpEmptyLine()}</text></Show>
      <text fg={props.colors.muted}>~ is disabled while the composer or a dialog is active.</text>
    </box>
  )
}

export function HelpView(props: { colors: Palette; scrollRef?: (value: any) => void }) {
  const [query, setQuery] = createSignal("")
  return (
    <box flexGrow={1} flexDirection="column" minHeight={0}>
      <text fg={props.colors.text} flexShrink={0}>Keyboard shortcuts</text>
      <box height={3} minHeight={3} flexShrink={0} border borderStyle="single" borderColor={props.colors.border} backgroundColor={props.colors.bg} paddingLeft={1} paddingRight={1}>
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
  memoryFilter: string
  memoryFilterEditing: boolean
  memoryTotal: number
  backupCursor: number
  skills: SkillOption[]
  skillCursor: number
  skillFilter: string
  filterEditing: boolean
  skillCatalog: SkillOption[]
}) {
  const missing = () => props.agent ? missingSkills(props.agent, props.skillCatalog) : []
  const capped = () => capSkills(props.skills)
  // Slice G section counts: the header names the section, the body carries
  // the rows. Backup depth comes from the draft; the rest is already props.
  const sectionCounts = () => ({
    memories: props.memoryTotal,
    backups: props.agent?.backupModels.length ?? 0,
    assigned: props.agent?.skillbox.length ?? 0,
    catalog: props.skillCatalog.length,
  })
  return (
    <Show when={props.agent} fallback={<text fg={props.colors.muted}>{settingsNoAgentLine()}</text>}>
      <box flexDirection="column">
        <text fg={props.colors.accent} bg={props.colors.bg} width="100%" truncate>{settingsHeader(props.agent!.name, props.dirty, props.agent!.pendingSettings)}</text>
        <text fg={props.colors.muted}>{settingsTabLine(props.tab, props.memoryTotal, props.agent!.skillbox.length, props.skillCatalog.length)}</text>
        <text fg={props.colors.faint} bg={props.colors.bg} width="100%" truncate>{settingsDivider()}</text>
        <text fg={props.colors.text} bg={props.colors.bg} width="100%" truncate>{settingsSectionHeader(props.tab, sectionCounts())}</text>
        <box border borderStyle="single" borderColor={props.colors.border} backgroundColor={props.colors.bg} flexDirection="column" paddingLeft={1} paddingRight={1}>
        <Show when={props.tab === "general"}>
          <For each={generalFieldRows(props.agent!, props.agent!.mainModel)}>{([label, value]) => (
            <text fg={props.colors.text} bg={props.colors.bg} width="100%" truncate>{settingsFieldRow(label, value)}</text>
          )}</For>
        </Show>
        <Show when={props.tab === "models"}>
          <text fg={props.colors.text} bg={props.colors.bg} width="100%" truncate>{settingsCursorMark(false)}(•) {settingsFieldRow("Main", modelSummary(props.agent!.mainModel))}</text>
          <For each={props.agent!.backupModels}>{(model, index) => <text fg={props.backupCursor === index() ? props.colors.good : props.colors.muted} bg={props.colors.bg} width="100%" truncate>{settingsCursorMark(props.backupCursor === index())}( ) {settingsFieldRow(backupRowLabel(index(), model), modelSummary(model))}</text>}</For>
          <Show when={props.agent!.backupModels.length === 0}><text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>{modelsEmptyLine()}</text></Show>
        </Show>
        <Show when={props.tab === "memories"}>
          <text fg={props.colors.muted}>Filter: {props.memoryFilter || "(none)"} · {platformLabel("/ filter · Ctrl+F")}{props.memoryFilterEditing ? " · typing… enter done · esc cancel" : ""}</text>
          <For each={props.memories}>{(memory, index) => (
            <box flexDirection="column">
              <text fg={props.memoryCursor === index() ? props.colors.good : props.colors.text} bg={props.colors.bg} width="100%" wrapMode="word">{settingsCursorMark(props.memoryCursor === index())}{memory.text}</text>
              <text fg={memoryNeedsReview(memory) ? props.colors.warn : props.colors.muted} bg={props.colors.bg} width="100%" truncate>    {memoryProvenanceLine(memory)}{memoryNeedsReview(memory) ? " ◆" : ""}</text>
            </box>
          )}</For>
          <Show when={props.memoryTotal === 0}><text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>{memoriesEmptyLine()}</text></Show>
          <Show when={props.memoryTotal > 0 && props.memories.length === 0}><text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>{memoriesNoMatchLine()}</text></Show>
        </Show>
        <Show when={props.tab === "skillbox"}>
          <Show when={missing().length > 0}><text fg={props.colors.bad}>Missing assigned skills: {missing().join(", ")}</text></Show>
          <text fg={props.colors.muted}>Filter: {props.skillFilter || "(none)"} · {platformLabel("Ctrl+F")}{props.filterEditing ? " · typing… enter done · esc cancel" : ""}</text>
          <Show when={props.skillCatalog.length === 0}><text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>{skillsUnavailableLine()}</text></Show>
<Show when={props.skillCatalog.length > 0 && props.skills.length === 0}><text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>{skillboxEmptyLine()}</text></Show>
          <For each={capped().visible}>{(skill, index) => (
            <text fg={props.skillCursor === index() ? props.colors.good : props.colors.text}>{settingsCursorMark(props.skillCursor === index())}{skillToggleMark(skillAssigned(props.agent!.skillbox, skill.id))} {skillRowLabel(skill)}</text>
          )}</For>
          <Show when={capped().overflow > 0}><text fg={props.colors.faint}>{capLineText(capped().overflow)}</text></Show>
        </Show>
        </box>
        <text fg={props.colors.faint} bg={props.colors.bg} width="100%" truncate>{settingsDivider()}</text>
        <text fg={props.colors.muted}>{platformLabel(settingsTabFooter(props.tab))}</text>
        <text fg={props.colors.muted}>{platformLabel(settingsSaveFooter())}</text>
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
          if (items.length === 0 && slot === 0) return solid(pickerEmptyLine())
          const cursor = props.cursor()
          const offset = pickerWindow(cursor, items.length).start
          const item = items[offset + slot]
          if (!item) return ""
          const marker = props.multiple() ? (item.selected ? "[x] " : "[ ] ") : (item.selected ? "(•) " : "( ) ")
          return solid(`${offset + slot === cursor ? "›" : " "} ${marker}${item.label}`)
        })()}</text>
      )}</For>
      <text fg={props.colors.faint} bg={props.colors.bg} width="100%" truncate>{solid(pickerFooter(props.multiple()))}</text>
    </box>
  )
}
