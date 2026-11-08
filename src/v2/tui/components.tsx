import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { StyledText, TextAttributes, bg as bgStyle, fg as fgStyle } from "@opentui/core"
import type { Agent, Approval, Memory, SkillOption, SnapshotState } from "../types.ts"
import { approvalSource } from "../types.ts"
import type { DispatchLimits } from "../dispatch-budget.ts"
import { limitsPanelFooter, limitsPanelRows, limitsPanelSubtitle, limitsPanelTitle } from "./limits.ts"
import type { InteractionMode } from "./interaction.ts"
import { contrastText, type Palette, type ThemeColor } from "./theme.ts"
import { missingSkills, short } from "./format.ts"
import { settingsTabLine, skillAssigned, skillPageItems, skillPaginationText, skillToggleMark } from "./skills.ts"
import { memoryNeedsReview, memoryProvenanceLine } from "./memories.ts"
import {
  backupRowLabel,
  generalFieldRows,
  memoriesEmptyLine,
  memoriesNoMatchLine,
  modelSummary,
  modelsEmptyLine,
  settingsCursorMark,
  settingsDivider,
  settingsFieldRow,
  settingsHeader,
  settingsNoAgentLine,
  settingsSectionHeader,
  skillboxEmptyLine,
  skillsUnavailableLine,
} from "./settings.ts"
import { settingsRowFlash, type SettingsAcknowledgement } from "./settings-feedback.ts"
import {
  approvalResolvedLine,
  approvalResolvingSuffix,
  approvalSourceTag,
  approvalsEmptyLine,
  helpEmptyLine,
  pickerEmptyLine,
  railBusyMark,
  railEmptyLine,
} from "./chrome.ts"
import { helpEntryKey, type HelpEntry, type HelpSection } from "./help.ts"
import { pickerWindow } from "./picker.ts"
import { railRowKey, type RailEmphasis } from "./rail.ts"
import { railGroupHeading, type RailSection } from "./railmodel.ts"
import { MOUSE_PANE_IDS } from "./mouse.ts"
import { statuslineHints } from "./keymap.ts"
import { displayWidth, fitStatuslineSegments, type StatuslinePart, type StatuslineSegment, type StatuslineTone } from "./statusline.ts"
import { chromeJoin, chromeSeparator, chromeSeparatorParts } from "./separators.ts"
import { isReducedMotion } from "./motion.ts"
import type { ToastNotice, ToastTone } from "./toast.ts"
import { approvalResolvedTone, type ApprovalResolvedSettle } from "./approvals.ts"
import { tideRowParts, tideTone } from "./tide.ts"
import type { WorkCard, WorkCardTide, WorkCardTones, WorkCompactRow } from "./workrows.ts"
import type { InitRow } from "./initrow.ts"
import { SYSTEM_AGENT_NAME } from "../system-agent.ts"

export type SettingsTab = "general" | "models" | "memories" | "skillbox"

export type ChatLine = {
  id: string
  /** Final rendered author name (the System Agent uses its display name here). */
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

function toneColor(colors: Palette, tone: StatuslineTone): ThemeColor {
  switch (tone) {
    case "muted":
      return colors.muted
    case "faint":
      return colors.faint
    case "accent":
      return colors.accent
    case "info":
      return colors.info
    case "good":
      return colors.good
    case "warn":
      return colors.warn
    case "bad":
      return colors.bad
    case "leader":
      return colors.leader
    default:
      return colors.text
  }
}


type StyledLinePart = { text: string; fg: ThemeColor; bg?: ThemeColor; attributes?: number }

/**
 * Build a native StyledText line. Nested span children inside a
 * `<text>` do not keep their foreground/background on every OpenTUI build,
 * so the statusline and chrome rows use styled chunks instead. This is the
 * public text-content API and preserves colors under `truncate`.
 */
function styledLine(parts: StyledLinePart[]): StyledText {
  return new StyledText(parts.map((part) => {
    let chunk = fgStyle(part.fg)(part.text)
    if (part.bg) chunk = bgStyle(part.bg)(chunk)
    if (part.attributes) chunk = { ...chunk, attributes: (chunk.attributes ?? 0) | part.attributes }
    return chunk
  }))
}

/**
 * Render a StyledText line through the native content setter. Solid's JSX
 * `content` prop stringifies an object on some OpenTUI builds, which showed
 * `[object Object]` instead of the statusline; setting the property after
 * mount keeps the chunks and their colors.
 */
function StyledLineText(props: {
  parts: () => StyledLinePart[]
  fg?: ThemeColor
  bg?: ThemeColor
  width?: number | string
  truncate?: boolean
  attributes?: number
  flexShrink?: number
  wrapMode?: "none" | "char" | "word"
}) {
  let ref: any
  const content = () => styledLine(props.parts())
  createEffect(() => {
    if (ref) ref.content = content()
  })
  return (
    <text
      ref={(value: any) => { ref = value; if (value) value.content = content() }}
      fg={props.fg}
      bg={props.bg}
      width={props.width as any}
      truncate={props.truncate}
      attributes={props.attributes}
      flexShrink={props.flexShrink}
      wrapMode={props.wrapMode}
    />
  )
}

/**
 * Chrome text with faint separators. Content keeps the row tone; the shared
 * ` │ ` separators paint faint so chrome reads quieter than the words.
 */
export function ChromeText(props: {
  colors: Palette
  text: string
  fg: ThemeColor
  bg: ThemeColor
  width?: number | string
  truncate?: boolean
  attributes?: number
  flexShrink?: number
  /** Keep spaces visible in fixed-width overlay rows. */
  nbsp?: boolean
}) {
  const text = (value: string) => (props.nbsp ? value.replaceAll(" ", "\u00A0") : value)
  const parts = () => chromeSeparatorParts(props.text).map((part) => ({
    text: text(part.text),
    fg: part.separator ? props.colors.faint : props.fg,
    attributes: props.attributes,
  }))
  return (
    <StyledLineText parts={parts} fg={props.fg} bg={props.bg} width={props.width} truncate={props.truncate} attributes={props.attributes} flexShrink={props.flexShrink} />
  )
}

/**
 * Filled mode chip plus the typed row-one segments. Fitting happens before
 * render: hints drop from the right first, and the chip never leaves.
 */
export function StatuslineRow(props: {
  colors: Palette
  segments: StatuslineSegment[]
  width: number
  bg: ThemeColor
}) {
  const parts = () => {
    const next: StyledLinePart[] = []
    fitStatuslineSegments(props.segments, props.width).forEach((segment, index) => {
      if (index > 0) next.push({ text: ` ${chromeSeparator()} `, fg: props.colors.faint })
      for (const part of segment.parts) {
        if (part.chip) {
          const background = props.colors[part.chip]
          // Normal mode uses the muted grey chip; the user wants black text
          // there even when luminance contrast would pick white. Other modes
          // keep automatic contrast.
          const foreground = part.chip === "muted" ? "#000000" : contrastText(background)
          const padding = " ".repeat(part.padding ?? 0)
          if (padding) next.push({ text: padding, fg: foreground, bg: background, attributes: TextAttributes.BOLD })
          next.push({ text: part.text, fg: foreground, bg: background, attributes: TextAttributes.BOLD })
          if (padding) next.push({ text: padding, fg: foreground, bg: background, attributes: TextAttributes.BOLD })
        } else {
          next.push({ text: part.text, fg: toneColor(props.colors, part.tone) })
        }
      }
    })
    return next
  }
  return (
    <StyledLineText parts={parts} fg={props.colors.text} bg={props.bg} width="100%" truncate />
  )
}

/**
 * Row two: the fixed Command/Search prompt cell plus the scrolling input or a
 * success/error/info message. The prompt renders outside the input so it can
 * never be scrolled away or truncated; the input was already laid out around
 * its caret by `statuslineRow2Parts`.
 */
export function StatuslineMessage(props: { colors: Palette; prompt: StatuslinePart[]; parts: StatuslinePart[]; width: number; bg: ThemeColor }) {
  const promptWidth = () => props.prompt.reduce((total, part) => total + displayWidth(part.text), 0)
  const inputWidth = () => Math.max(1, props.width - promptWidth())
  const promptParts = () => props.prompt.map((part) => ({ text: part.text, fg: toneColor(props.colors, part.tone) }))
  const inputParts = () => props.parts.map((part) => ({ text: part.text, fg: toneColor(props.colors, part.tone) }))
  return (
    <box flexDirection="row" width="100%">
      <Show when={props.prompt.length > 0}>
        <StyledLineText parts={promptParts} fg={props.colors.accent} bg={props.bg} flexShrink={0} wrapMode="none" />
      </Show>
      <StyledLineText parts={inputParts} fg={props.colors.faint} bg={props.bg} width={inputWidth()} wrapMode="none" truncate={props.prompt.length === 0} />
    </box>
  )
}

/**
 * App-owned feedback toast (ticket #119). One non-focusable card anchored by
 * the app at a bounded top-right position. The tone owns the border and title
 * color; the body stays readable text. It never mounts a text editor or takes
 * part in the focus/key layers.
 */
export function ToastOverlay(props: { colors: Palette; toast: ToastNotice; top: number; left: number; width: number }) {
  // One-shot presence settle. Reduced motion mounts at the final opacity and
  // unmounting is always instant, so the toast never animates under
  // ENSEMBLE_REDUCED_MOTION or NO_COLOR.
  const [settled, setSettled] = createSignal(isReducedMotion())
  onMount(() => {
    if (settled()) return
    const timer = setTimeout(() => setSettled(true), 50)
    onCleanup(() => clearTimeout(timer))
  })
  const tone = (): ToastTone => props.toast.tone
  const accent = () => {
    switch (tone()) {
      case "success": return props.colors.good
      case "warning": return props.colors.warn
      case "error": return props.colors.bad
      default: return props.colors.info
    }
  }
  return (
    <box
      position="absolute"
      top={props.top}
      left={props.left}
      width={props.width}
      height={4}
      zIndex={80}
      border
      borderStyle="rounded"
      borderColor={accent()}
      backgroundColor={props.colors.panel}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      flexShrink={0}
      opacity={settled() ? 1 : 0.72}
    >
      <text fg={accent()} bg={props.colors.panel} width="100%" truncate>{props.toast.title}</text>
      <text fg={props.colors.text} bg={props.colors.panel} width="100%" truncate>{props.toast.message}</text>
    </box>
  )
}

export function Rail(props: {
  colors: Palette
  /** Ticket #171: pure sections; the app owns grouping, counts, and collapse state. */
  sections: readonly RailSection[]
  cursor: number
  focus: boolean
  cursorVisible: boolean
  pendingApprovals: number
  width: number
  filter: string
  motionTick?: number
  /** One-shot unread/approval pulses and quiet row arrivals from ticket #121. */
  emphasis?: RailEmphasis
  /** Mouse and keyboard both route through this; a group header toggles its rows. */
  onToggleGroup: (groupID: string) => void
}) {
  const approvalCountParts = (): StyledLinePart[] => {
    const parts: StyledLinePart[] = [{ text: "APPROVALS", fg: props.colors.accent }]
    if (props.pendingApprovals > 0) {
      const pulse = Boolean(props.emphasis?.approval)
      parts.push({
        text: ` (${props.pendingApprovals})`,
        fg: pulse ? props.colors.warn : props.colors.accent,
        attributes: pulse ? TextAttributes.BOLD : undefined,
      })
    }
    return parts
  }
  const sectionBorder = () => props.focus ? props.colors.focus : props.colors.border
  const sectionOffset = (sectionIndex: number) =>
    props.sections.slice(0, sectionIndex).reduce((total, section) => total + section.rows.length, 0)
  return (
    <box id={MOUSE_PANE_IDS.rail} width={props.width} backgroundColor={props.colors.bg} flexDirection="column">
      <Show when={props.filter}>
        <text fg={props.colors.warn} bg={props.colors.bg} width="100%" truncate>filter: {props.filter}</text>
      </Show>
      <For each={props.sections}>{(section, sectionIndex) => (
        <box width="100%" flexGrow={section.id === "agents" ? 2 : 1} minHeight={0} border borderStyle="single" borderColor={sectionBorder()} backgroundColor={props.colors.bg} flexDirection="column" paddingLeft={1} paddingRight={1} overflow="hidden">
          <text fg={props.colors.faint} bg={props.colors.bg} width="100%" truncate>{section.heading}</text>
          <For each={section.rows}>{(row, rowIndex) => {
            // Read the cursor inside the rendered expression: a plain const
            // here captures the value once per row and feels a tick late.
            const index = () => sectionOffset(sectionIndex()) + rowIndex()
            const selected = () => props.cursor === index()
            if (row.kind === "group") {
              return (
                <box flexDirection="row" width="100%" onMouseDown={(event: any) => {
                  if (Number(event?.button) !== 0) return
                  // A header click toggles collapse; the drag-selection owner
                  // still sees the gesture and keeps clipboard behavior.
                  event?.preventDefault?.()
                  props.onToggleGroup(row.id)
                }}>
                  <text fg={selected() ? props.colors.good : props.colors.muted} bg={props.colors.bg} width="100%" wrapMode="none" truncate>
                    {settingsCursorMark(selected() && props.cursorVisible)}{railGroupHeading(row)}
                  </text>
                </box>
              )
            }
            if (row.kind === "agent") {
              // Ticket #121: arrival settles quietly; selection always wins the tone.
              const arriving = () => Boolean(props.emphasis?.arrivals.has(railRowKey("agent", row.id)))
              const rowTone = () => selected() ? props.colors.good : arriving() ? props.colors.muted : props.colors.text
              return (
                <box flexDirection="column">
                  <box flexDirection="row" width="100%">
                    <text fg={rowTone()} bg={props.colors.bg} flexShrink={1} wrapMode="none" truncate>
                      {"  "}{settingsCursorMark(selected() && props.cursorVisible)}{row.title}
                    </text>
                    <Show when={row.leader}>
                      <text fg={props.colors.faint} bg={props.colors.bg} flexShrink={0}> {chromeSeparator()} </text>
                      <text fg={props.colors.leader} bg={props.colors.bg} flexShrink={0} attributes={TextAttributes.BOLD}>LEADER</text>
                    </Show>
                    <Show when={row.guest}>
                      <text fg={props.colors.faint} bg={props.colors.bg} flexShrink={0}> {chromeSeparator()} guest</text>
                    </Show>
                  </box>
                  <Show when={row.role.trim()}>
                    <text fg={props.colors.faint} bg={props.colors.bg} width="100%" wrapMode="none" truncate attributes={TextAttributes.DIM}>
                      {"    ├ "}{short(row.role, Math.max(8, props.width - 10))}
                    </text>
                  </Show>
                </box>
              )
            }
            // Ticket #121: unread growth pulses the count once; a newly arrived
            // row settles without movement. Active selection keeps its accent.
            const unreadPulse = () => Boolean(props.emphasis?.unread.has(row.id))
            const arriving = () => Boolean(props.emphasis?.arrivals.has(railRowKey("workspace", row.id)))
            const rowTone = () => selected() ? props.colors.good : row.active ? props.colors.accent : arriving() ? props.colors.muted : props.colors.text
            return (
              <box flexDirection="column">
                <box flexDirection="row" width="100%">
                  <text fg={rowTone()} bg={props.colors.bg} flexShrink={1} wrapMode="none" truncate>
                    {"  "}{settingsCursorMark(selected() && props.cursorVisible)}#{row.title}
                  </text>
                  <Show when={row.paused}><text fg={props.colors.warn} bg={props.colors.bg} flexShrink={0}> ⏸</text></Show>
                  <Show when={row.busy > 0}><text fg={props.colors.muted} bg={props.colors.bg} flexShrink={0}> {railBusyMark(row.busy, props.motionTick ?? 0, process.env)}</text></Show>
                  <Show when={row.unread > 0}><text fg={unreadPulse() ? props.colors.info : props.colors.muted} bg={props.colors.bg} flexShrink={0} attributes={unreadPulse() ? TextAttributes.BOLD : undefined}> ●{row.unread}</text></Show>
                </box>
                <text fg={props.colors.faint} bg={props.colors.bg} width="100%" wrapMode="none" truncate attributes={TextAttributes.DIM}>
                  {"    ├ "}{short(row.group, Math.max(8, props.width - 10))}
                </text>
              </box>
            )
          }}</For>
          <Show when={section.id === "agents" && props.sections.every((entry) => entry.rows.length === 0)}>
            <text fg={props.colors.muted} bg={props.colors.bg} width="100%" wrapMode="word">{railEmptyLine()}</text>
          </Show>
          <Show when={section.id === "workspaces" && Boolean(props.filter) && section.rows.length === 0}>
            <text fg={props.colors.muted} bg={props.colors.bg} width="100%" wrapMode="word">No workspaces match.</text>
          </Show>
        </box>
      )}</For>
      <text> </text>
      <StyledLineText parts={approvalCountParts} fg={props.colors.accent} bg={props.colors.bg} width="100%" truncate />
      <text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>v opens inbox</text>
    </box>
  )
}


export function WorkCardView(props: {
  colors: Palette
  card: WorkCard
  /** Ticket #142: animated mark; only this cell reads the 8 fps clock. */
  glyph: string
  /** Ticket #142: animated strip; only this row reads the 15 fps clock. */
  tide: WorkCardTide
  selected: boolean
  width: number
  /** Ticket #172 basic mouse selection; full card actions belong to #173. */
  onSelect?: () => void
}) {
  const terminal = () => props.card.terminal
  const tone = (key: WorkCard["tones"]["glyph"]) => props.colors[key]
  // Ticket #137: name left in pale blue, then the right-aligned Braille and
  // uppercase status. Selection is a focus border only; green stays reserved
  // for REPLIED and no state color is painted on the rounded border.
  const header = (): StyledLinePart[] => [
    { text: props.card.header.name, fg: props.colors.paleBlue },
    { text: props.card.header.gap, fg: props.colors.text },
    { text: props.card.header.budget, fg: props.colors.faint },
    { text: props.glyph, fg: tone(props.card.tones.glyph) },
    { text: " ", fg: tone(props.card.tones.status) },
    { text: props.card.header.status, fg: tone(props.card.tones.status) },
  ]
  // Ticket #156: one styled chunk per exact-width tide part. Every sample but
  // the last is one glyph plus the approved Sub-Cell Tide blank; the final
  // sample is the glyph alone, and an even row starts with one padding blank.
  // Terminal cards arrive with a flat settled strip, so this row stops moving.
  const tide = (): StyledLinePart[] => tideRowParts(props.tide.tideLevels, props.card.width).map((part) => ({
    text: part.text,
    fg: part.level === undefined
      ? props.colors.faint
      : terminal()
        ? props.colors.faint
        : props.card.needsYou
          ? props.colors.warn
          : props.colors[tideTone(part.level)],
  }))
  return (
    <box
      width={props.width}
      flexShrink={0}
      flexDirection="row"
      border
      borderStyle="rounded"
      borderColor={props.selected ? props.colors.focus : props.colors.border}
      backgroundColor={props.colors.panel}
      onMouseDown={(event: any) => {
        if (Number(event?.button) !== 0) return
        // Keep the root pane marker: a drag that starts on a card is still a
        // pane-bounded text selection, while a plain click selects the card.
        event?.preventDefault?.()
        props.onSelect?.()
      }}
    >
      <box width={1} flexShrink={0} alignSelf="stretch" backgroundColor={tone(props.card.tones.bar)} />
      <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
        <StyledLineText parts={header} fg={props.colors.text} bg={props.colors.panel} width="100%" wrapMode="none" flexShrink={0} />
        <text fg={terminal() ? props.colors.muted : props.colors.text} bg={props.colors.panel} width="100%" wrapMode="none" truncate>{props.card.title}</text>
        <text fg={terminal() ? props.colors.faint : props.colors.muted} bg={props.colors.panel} width="100%" wrapMode="none" truncate>{props.card.detail}</text>
        <StyledLineText parts={tide} fg={props.colors.faint} bg={props.colors.panel} width="100%" wrapMode="none" truncate flexShrink={0} />
      </box>
    </box>
  )
}

/**
 * Ticket #137: compact Work fallback. It keeps the card grammar (pale-blue
 * name left, Braille and right-aligned status) in one row, with the title
 * truncating before the status word.
 */
export function WorkCompactRowView(props: {
  colors: Palette
  row: WorkCompactRow
  tones: WorkCardTones
  selected: boolean
  terminal: boolean
  /** Ticket #172 basic mouse selection; full card actions belong to #173. */
  onSelect?: () => void
}) {
  const tone = (key: WorkCardTones["glyph"]) => props.colors[key]
  const parts = (): StyledLinePart[] => [
    { text: props.selected ? "› " : "  ", fg: props.selected ? props.colors.focus : props.colors.faint },
    { text: props.row.name, fg: props.colors.paleBlue },
    { text: props.row.separator, fg: props.colors.faint },
    { text: props.row.title, fg: props.terminal ? props.colors.muted : props.colors.text },
    { text: props.row.gap, fg: props.colors.text },
    { text: props.row.budget, fg: props.colors.faint },
    { text: props.row.glyph, fg: tone(props.tones.glyph) },
    { text: " ", fg: tone(props.tones.status) },
    { text: props.row.status, fg: tone(props.tones.status) },
  ]
  return (
    <box
      width="100%"
      flexShrink={0}
      onMouseDown={(event: any) => {
        if (Number(event?.button) !== 0) return
        event?.preventDefault?.()
        props.onSelect?.()
      }}
    >
      <StyledLineText
        parts={parts}
        fg={props.colors.text}
        bg={props.colors.bg}
        width="100%"
        wrapMode="none"
        flexShrink={0}
      />
    </box>
  )
}

/**
 * Ticket #118: one live System Agent init row. The phase word, four discrete
 * stage marks, and the opaque-native detail are all explicit; there is no
 * progress percentage and no fake within-stage precision.
 */
export function InitRowView(props: { colors: Palette; row: InitRow }) {
  const parts = (): StyledLinePart[] => [
    { text: `${props.row.glyph} `, fg: props.colors.info ?? props.colors.accent },
    { text: SYSTEM_AGENT_NAME, fg: props.colors.info ?? props.colors.accent },
    { text: ` ${chromeSeparator()} `, fg: props.colors.faint },
    { text: props.row.label, fg: props.row.phase === "running" ? props.colors.accent : props.colors.muted },
    { text: ` ${chromeSeparator()} `, fg: props.colors.faint },
    { text: props.row.stage, fg: props.colors.muted },
    { text: ` ${chromeSeparator()} `, fg: props.colors.faint },
    { text: props.row.detail, fg: props.colors.muted },
  ]
  return (
    <StyledLineText parts={parts} fg={props.colors.text} bg={props.colors.bg} width="100%" wrapMode="none" truncate flexShrink={0} />
  )
}

export function ApprovalList(props: {
  colors: Palette
  approvals: Approval[]
  cursor: number
  resolvingID: string | null
  state: SnapshotState | null
  onResolve: (approval: Approval) => Promise<void>
  motionTick?: number
  emphasized: ReadonlySet<string>
  resolved: readonly ApprovalResolvedSettle[]
}) {
  return (
    <box flexDirection="column">
      <text fg={props.colors.accent} bg={props.colors.bg} width="100%" truncate>Approvals inbox</text>
      <Show when={props.approvals.length === 0 && props.resolved.length === 0}><text fg={props.colors.muted}>{approvalsEmptyLine()}</text></Show>
      <For each={props.approvals}>{(approval, index) => {
        const selected = () => props.cursor === index()
        const emphasized = () => props.emphasized.has(approval.id)
        return (
          <box flexDirection="column">
            <text fg={selected() ? props.colors.good : emphasized() ? props.colors.accent : props.colors.warn} bg={props.colors.bg} width="100%" truncate attributes={emphasized() ? TextAttributes.BOLD : undefined}>{selected() ? "› " : "  "}[{approvalSourceTag(approvalSource(approval))}] {approval.title}{approvalResolvingSuffix(props.resolvingID === approval.id, props.motionTick ?? 0, process.env)}</text>
            <text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>{short(approval.detail, 80)}</text>
          </box>
        )
      }}</For>
      <For each={props.resolved}>{(entry) => (
        <box flexDirection="column">
          <text fg={approvalResolvedTone(entry.ageMs, process.env) === "good" ? props.colors.good : props.colors.muted} bg={props.colors.bg} width="100%" truncate>{approvalResolvedLine(entry.approval)}</text>
          <text fg={props.colors.faint} bg={props.colors.bg} width="100%" truncate>{short(entry.approval.detail, 80)}</text>
        </box>
      )}</For>
    </box>
  )
}

function helpRowText(entry: HelpEntry, selected: boolean): string {
  const prefix = selected ? "› " : "  "
  if (!entry.keys) return `${prefix}${entry.title}`
  return `${prefix}${entry.keys.padEnd(18)} ${entry.title}`
}

function HelpEntries(props: { colors: Palette; sections: readonly HelpSection[]; matchKey?: string | null }) {
  return (
    <box flexDirection="column">
      <For each={props.sections}>{(section) => (
        <>
          <text fg={props.colors.muted}>{section.title}</text>
          <For each={section.entries}>{(entry) => {
            const selected = () => props.matchKey === helpEntryKey(section, entry)
            return (
              <text id={`help-${helpEntryKey(section, entry)}`} fg={selected() ? props.colors.accent : props.colors.text}>
                {helpRowText(entry, selected())}
              </text>
            )
          }}</For>
        </>
      )}</For>
      <Show when={props.sections.length === 0}><text fg={props.colors.muted}>{helpEmptyLine()}</text></Show>
    </box>
  )
}

export function HelpView(props: {
  colors: Palette
  sections: readonly HelpSection[]
  query: string
  filtering: boolean
  matchKey?: string | null
  scrollRef?: (value: any) => void
}) {
  const hasMatches = () => props.sections.some((section) => section.entries.length > 0)
  return (
    <box flexGrow={1} flexDirection="column" minHeight={0}>
      <text fg={props.colors.text} flexShrink={0}>Keyboard shortcuts</text>
      <ChromeText
        colors={props.colors}
        fg={props.filtering ? props.colors.focus : props.colors.muted}
        bg={props.colors.bg}
        width="100%"
        truncate
        flexShrink={0}
        text={props.filtering
          ? `/${props.query}`
          : props.query
            ? chromeJoin([`/ ${props.query}`, "n/N match", "esc close"])
            : chromeJoin(["? help", "/ filter", "n/N match", "j/k scroll", "ctrl+d/u", "gg/G", "esc close"])}
      />
      <scrollbox ref={(value: any) => props.scrollRef?.(value)} flexGrow={1} minHeight={0} stickyScroll stickyStart="top" width="100%">
        <Show when={hasMatches()} fallback={<text fg={props.colors.muted}>{helpEmptyLine()}</text>}>
          <HelpEntries colors={props.colors} sections={props.sections} matchKey={props.matchKey} />
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
  /** Ticket #124 one-shot feedback view; absent means no acknowledgement. */
  acknowledgement?: SettingsAcknowledgement
  field?: { kind: "agent" | "memory"; label: string; value: string } | null
  fieldMode?: InteractionMode
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
  // Ticket #124: the header keeps the saved state word and flashes its color
  // once; a dirty draft always supersedes it.
  const saved = () => props.acknowledgement?.saved ?? false
  const headerColor = () =>
    props.acknowledgement?.savedFlash ? props.colors.text : saved() ? props.colors.good : props.colors.accent
  // A new memory or changed skill row acknowledges once. Bold is the flash:
  // the selected row is already green, so color alone would not read. One
  // predicate and one color rule serve both row families.
  const rowFlash = (kind: "memory" | "skill", id: string) => settingsRowFlash(props.acknowledgement, kind, id)
  const rowColor = (selected: boolean, flash: boolean) =>
    selected || flash ? props.colors.good : props.colors.text
  const fieldMode = () => props.fieldMode ?? "normal"
  const fieldHints = () => {
    const memory = props.field?.kind === "memory"
    if (fieldMode() === "insert") return statuslineHints(memory ? "settingsMemoryField" : "settingsField")
    if (fieldMode() === "visual") return statuslineHints("composerVisual")
    return statuslineHints(memory ? "settingsMemoryText" : "settingsText")
  }
  return (
    <Show when={props.agent} fallback={<text fg={props.colors.muted}>{settingsNoAgentLine()}</text>}>
      <box flexDirection="column">
        <ChromeText colors={props.colors} fg={headerColor()} bg={props.colors.bg} width="100%" truncate attributes={props.acknowledgement?.savedFlash ? TextAttributes.BOLD : undefined} text={settingsHeader(props.agent!.name, props.dirty, props.agent!.pendingSettings, saved())} />
        <ChromeText colors={props.colors} fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate text={settingsTabLine(props.tab, props.memoryTotal, props.agent!.skillbox.length, props.skillCatalog.length)} />
        <text fg={props.colors.faint} bg={props.colors.bg} width="100%" truncate>{settingsDivider()}</text>
        <ChromeText colors={props.colors} fg={props.colors.text} bg={props.colors.bg} width="100%" truncate text={settingsSectionHeader(props.tab, sectionCounts())} />
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
          <ChromeText colors={props.colors} fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate text={chromeJoin([`Filter: ${props.memoryFilter || "(none)"}`, "/ filter"])} />
          <For each={props.memories}>{(memory, index) => (
            <box flexDirection="column">
              <text fg={rowColor(props.cursor === index(), rowFlash("memory", memory.id))} bg={props.colors.bg} width="100%" wrapMode="word" attributes={rowFlash("memory", memory.id) ? TextAttributes.BOLD : undefined}>{settingsCursorMark(props.cursor === index())}{memory.text}</text>
              <ChromeText colors={props.colors} fg={memoryNeedsReview(memory) ? props.colors.warn : props.colors.muted} bg={props.colors.bg} width="100%" truncate text={`    ${memoryProvenanceLine(memory)}${memoryNeedsReview(memory) ? " ◆" : ""}`} />
            </box>
          )}</For>
          <Show when={props.memoryTotal === 0}><text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>{memoriesEmptyLine()}</text></Show>
          <Show when={props.memoryTotal > 0 && props.memories.length === 0}><text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>{memoriesNoMatchLine()}</text></Show>
        </Show>
        <Show when={props.tab === "skillbox"}>
          <Show when={missing().length > 0}><text fg={props.acknowledgement?.missingFlash ? props.colors.bad : props.colors.warn} attributes={props.acknowledgement?.missingFlash ? TextAttributes.BOLD : undefined}>Missing assigned skills: {missing().join(", ")}</text></Show>
          <ChromeText colors={props.colors} fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate text={chromeJoin([`Filter: ${props.skillFilter || "(none)"}`, "/ filter", ...(skillPaginationText(props.skills.length, props.skillPage ?? 1) ? [skillPaginationText(props.skills.length, props.skillPage ?? 1)] : [])])} />
          <Show when={props.skillCatalog.length === 0}><text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>{skillsUnavailableLine()}</text></Show>
<Show when={props.skillCatalog.length > 0 && props.skills.length === 0}><text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>{skillboxEmptyLine()}</text></Show>
          <For each={skillPageItems(props.skills, props.skillPage ?? 1)}>{(entry) => (
            <box flexDirection="column">
              <text fg={rowColor(props.cursor === entry.index, rowFlash("skill", entry.skill.id))} bg={props.colors.bg} width="100%" truncate attributes={rowFlash("skill", entry.skill.id) ? TextAttributes.BOLD : undefined}>{settingsCursorMark(props.cursor === entry.index)}{skillToggleMark(skillAssigned(props.agent!.skillbox, entry.skill.id))} {entry.skill.name}{entry.skill.name !== entry.skill.id ? ` (${entry.skill.id})` : ""}</text>
              <Show when={(entry.skill.description ?? "").trim()}>
                <text fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate>    {short(entry.skill.description!.replace(/\s+/g, " ").trim(), 120)}</text>
              </Show>
            </box>
          )}</For>
        </Show>
        </box>
        <Show when={props.field}>
          <box flexDirection="column" marginTop={1}>
            <ChromeText colors={props.colors} fg={props.colors.accent} bg={props.colors.bg} width="100%" truncate text={chromeJoin([props.field!.label, fieldMode() === "insert" ? "INSERT" : fieldMode() === "visual" ? "VISUAL" : "NORMAL", fieldHints()])} />
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

/**
 * Workspace-level dispatch Limits panel (ticket #160). It is deliberately
 * separate from the per-agent settings tabs: these are the user's ceilings for
 * every new command, not agent identity.
 */
export function LimitsView(props: {
  colors: Palette
  workspaceName?: string
  limits: DispatchLimits
  cursor: number
  error?: string
}) {
  const rows = () => limitsPanelRows(props.limits, props.cursor)
  return (
    <box flexDirection="column" padding={1} flexGrow={1}>
      <ChromeText colors={props.colors} fg={props.colors.accent} bg={props.colors.bg} width="100%" truncate text={limitsPanelTitle(props.workspaceName)} />
      <text fg={props.colors.muted} bg={props.colors.bg} width="100%" wrapMode="word">{limitsPanelSubtitle()}</text>
      <text fg={props.colors.faint} bg={props.colors.bg} width="100%" truncate>{settingsDivider()}</text>
      <box border borderStyle="single" borderColor={props.colors.border} backgroundColor={props.colors.bg} flexDirection="column" paddingLeft={1} paddingRight={1}>
        <For each={rows()}>{(row) => (
          <text fg={row.selected ? props.colors.good : props.colors.text} bg={props.colors.bg} width="100%" truncate>{row.text}</text>
        )}</For>
      </box>
      <text fg={props.error ? props.colors.bad : props.colors.faint} bg={props.colors.bg} width="100%" wrapMode="word">{props.error || limitsPanelFooter()}</text>
    </box>
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
  footer: () => string
}) {
  const slots = Array.from({ length: 8 }, (_, index) => index)
  const solid = (value: string) => value.replaceAll(" ", "\u00A0")
  return (
    <box width="100%" height={16} minHeight={16} flexShrink={0} border borderStyle="double" borderColor={props.colors.focus} backgroundColor={props.colors.panel} flexDirection="column" padding={1}>
      <text fg={props.colors.focus} bg={props.colors.bg} width="100%" truncate>{solid(props.title())}</text>
      <ChromeText colors={props.colors} fg={props.colors.muted} bg={props.colors.bg} width="100%" truncate nbsp text={chromeJoin([`filter: ${props.query() || "(none)"}`, `${props.items().length} matches`])} />
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
      <ChromeText colors={props.colors} fg={props.colors.faint} bg={props.colors.bg} width="100%" truncate nbsp text={props.footer()} />
    </box>
  )
}
