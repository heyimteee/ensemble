import { For, Show, createSignal } from "solid-js"
import { TextAttributes } from "@opentui/core"
import type { Agent, Approval, Memory, SkillOption, SnapshotState } from "../types.ts"
import { approvalSource } from "../types.ts"
import type { Palette } from "./theme.ts"
import { busyCount, fuzzyMatch, missingSkills, short, unreadCount } from "./format.ts"
import { settingsTabLine, skillAssigned, skillPageItems, skillPaginationText, skillToggleMark } from "./skills.ts"
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
  settingsSectionHeader,
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
  /** Agent-list secondary line: the agent's title. */
  description?: string
  /** Agent-list third line: the workspace it belongs to (`#name`) or "homeless". */
  workspace?: string
  /** True when the displayed workspace names this agent as leader. */
  leader?: boolean
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
  taskID?: string
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
      <Show when={props.filter}>
        <text fg={props.colors.warn} bg={props.colors.bg} width="100%" truncate>filter: {props.filter}</text>
      </Show>
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
            <box flexDirection="column">
              <box flexDirection="row" width="100%">
                <text fg={selected ? props.colors.good : props.colors.text} bg={props.colors.bg} flexShrink={1} wrapMode="none" truncate>
                  {settingsCursorMark(selected && props.cursorVisible)}{item.kind === "workspace" ? `#${item.title}` : item.title}
                </text>
                <Show when={item.kind === "agent" && item.leader}>
                  <box marginLeft={1} flexShrink={0} backgroundColor={props.colors.leader} paddingLeft={1} paddingRight={1}>
                    <text fg={props.colors.bg} attributes={TextAttributes.BOLD}>LEADER</text>
                  </box>
                </Show>
                <Show when={workspace?.paused}><text fg={props.colors.warn} bg={props.colors.bg} flexShrink={0}> ⏸</text></Show>
                <Show when={busy > 0}><text fg={props.colors.muted} bg={props.colors.bg} flexShrink={0}> ◐{busy}</text></Show>
                <Show when={unread > 0}><text fg={props.colors.muted} bg={props.colors.bg} flexShrink={0}> ●{unread}</text></Show>
              </box>
              <Show when={item.kind === "agent"}>
                <Show when={item.leader}>
                  <text fg={props.colors.faint} bg={props.colors.bg} attributes={TextAttributes.DIM}>{"  │"}</text>
                </Show>
                <Show when={(item.description ?? "").trim()}>
                  <text fg={props.colors.faint} bg={props.colors.bg} width="100%" wrapMode="none" truncate attributes={TextAttributes.DIM}>
                    {"  ├ "}{short(item.description!, Math.max(8, props.width - 8))}
                  </text>
                </Show>
                <text fg={props.colors.faint} bg={props.colors.bg} width="100%" wrapMode="none" truncate attributes={TextAttributes.DIM}>
                  {"  └ "}{short(item.detail ? `${item.workspace ?? "homeless"} · ${item.detail}` : item.workspace ?? "homeless", Math.max(8, props.width - 8))}
                </text>
              </Show>
            </box>
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
      <text fg={props.colors.muted}>Space opens the leader; Esc goes up one level and never quits.</text>
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
  cursor: number
  memories: Memory[]
  memoryFilter: string
  memoryTotal: number
  skills: SkillOption[]
  skillFilter: string
  skillCatalog: SkillOption[]
  skillPage?: number
  field?: { label: string; value: string } | null
  fieldMode?: "normal" | "insert" | "command"
  fieldRef?: (value: any) => void
  onFieldContentChange?: () => void
  onFieldCursorChange?: () => void
}) {
  const missing = () => props.agent ? missingSkills(props.agent, props.skillCatalog) : []
  // Slice G section counts: the header names the section, the body carries
  // the rows. Backup depth comes from the draft; the rest is already props.
  const sectionCounts = () => ({
    memories: props.memoryTotal,
    backups: props.agent?.backupModels.length ?? 0,
    assigned: props.agent?.skillbox.length ?? 0,
    catalog: props.skillCatalog.length,
  })
  const fieldMode = () => props.fieldMode ?? "normal"
  return (
    <Show when={props.agent} fallback={<text fg={props.colors.muted}>{settingsNoAgentLine()}</text>}>
      <box flexDirection="column">
        <text fg={props.colors.accent} bg={props.colors.bg} width="100%" truncate>{settingsHeader(props.agent!.name, props.dirty, props.agent!.pendingSettings)}</text>
        <text fg={props.colors.muted}>{settingsTabLine(props.tab, props.memoryTotal, props.agent!.skillbox.length, props.skillCatalog.length)}</text>
        <text fg={props.colors.faint} bg={props.colors.bg} width="100%" truncate>{settingsDivider()}</text>
        <text fg={props.colors.text} bg={props.colors.bg} width="100%" truncate>{settingsSectionHeader(props.tab, sectionCounts())}</text>
        <box border borderStyle="single" borderColor={props.colors.border} backgroundColor={props.colors.bg} flexDirection="column" paddingLeft={1} paddingRight={1}>
        <Show when={props.tab === "general"}>
          <For each={generalFieldRows(props.agent!, props.agent!.mainModel)}>{([label, value], index) => (
            <text fg={props.cursor === index() ? props.colors.good : props.colors.text} bg={props.colors.bg} width="100%" truncate>{settingsCursorMark(props.cursor === index())}{settingsFieldRow(label, value)}</text>
          )}</For>
        </Show>
        <Show when={props.tab === "models"}>
          <text fg={props.cursor === 0 ? props.colors.good : props.colors.text} bg={props.colors.bg} width="100%" truncate>{settingsCursorMark(props.cursor === 0)}(•) {settingsFieldRow("Main", modelSummary(props.agent!.mainModel))}</text>
          <For each={props.agent!.backupModels}>{(model, index) => <text fg={props.cursor === index() + 1 ? props.colors.good : props.colors.muted} bg={props.colors.bg} width="100%" truncate>{settingsCursorMark(props.cursor === index() + 1)}( ) {settingsFieldRow(backupRowLabel(index(), model), modelSummary(model))}</text>}</For>
          <Show when={props.agent!.backupModels.length === 0}><text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>{modelsEmptyLine()}</text></Show>
        </Show>
        <Show when={props.tab === "memories"}>
          <text fg={props.colors.muted}>Filter: {props.memoryFilter || "(none)"} · / filter</text>
          <For each={props.memories}>{(memory, index) => (
            <box flexDirection="column">
              <text fg={props.cursor === index() ? props.colors.good : props.colors.text} bg={props.colors.bg} width="100%" wrapMode="word">{settingsCursorMark(props.cursor === index())}{memory.text}</text>
              <text fg={memoryNeedsReview(memory) ? props.colors.warn : props.colors.muted} bg={props.colors.bg} width="100%" truncate>    {memoryProvenanceLine(memory)}{memoryNeedsReview(memory) ? " ◆" : ""}</text>
            </box>
          )}</For>
          <Show when={props.memoryTotal === 0}><text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>{memoriesEmptyLine()}</text></Show>
          <Show when={props.memoryTotal > 0 && props.memories.length === 0}><text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>{memoriesNoMatchLine()}</text></Show>
        </Show>
        <Show when={props.tab === "skillbox"}>
          <Show when={missing().length > 0}><text fg={props.colors.bad}>Missing assigned skills: {missing().join(", ")}</text></Show>
          <text fg={props.colors.muted}>Filter: {props.skillFilter || "(none)"} · / filter{skillPaginationText(props.skills.length, props.skillPage ?? 1) ? ` · ${skillPaginationText(props.skills.length, props.skillPage ?? 1)}` : ""}</text>
          <Show when={props.skillCatalog.length === 0}><text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>{skillsUnavailableLine()}</text></Show>
<Show when={props.skillCatalog.length > 0 && props.skills.length === 0}><text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>{skillboxEmptyLine()}</text></Show>
          <For each={skillPageItems(props.skills, props.skillPage ?? 1)}>{(entry) => (
            <box flexDirection="column">
              <text fg={props.cursor === entry.index ? props.colors.good : props.colors.text} bg={props.colors.bg} width="100%" truncate>{settingsCursorMark(props.cursor === entry.index)}{skillToggleMark(skillAssigned(props.agent!.skillbox, entry.skill.id))} {entry.skill.name}{entry.skill.name !== entry.skill.id ? ` (${entry.skill.id})` : ""}</text>
              <Show when={(entry.skill.description ?? "").trim()}>
                <text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>    {short(entry.skill.description!.replace(/\s+/g, " ").trim(), 120)}</text>
              </Show>
            </box>
          )}</For>
        </Show>
        </box>
        <Show when={props.field}>
          <box flexDirection="column" marginTop={1}>
            <text fg={props.colors.accent} bg={props.colors.bg} width="100%" truncate>
              {props.field!.label} · {fieldMode() === "insert" ? "INSERT · enter done · esc field normal" : "NORMAL · i/a insert · h/j/k/l move · esc settings"}
            </text>
            <box height={3} minHeight={3} flexShrink={0} border borderStyle="single" borderColor={props.colors.focus} backgroundColor={props.colors.bg} paddingLeft={1} paddingRight={1}>
              <input ref={props.fieldRef} value={props.field!.value} width="100%" backgroundColor={props.colors.bg} textColor={props.colors.text} onContentChange={() => props.onFieldContentChange?.()} onCursorChange={() => props.onFieldCursorChange?.()} />
            </box>
          </box>
        </Show>
        <text fg={props.colors.faint} bg={props.colors.bg} width="100%" truncate>{settingsDivider()}</text>
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
