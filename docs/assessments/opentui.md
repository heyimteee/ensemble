# OpenTUI assessment

Status: **decision record**, 2026-10-30. Target: OpenCode 2.2.1.

## Short answer

Ensemble is **already built on OpenTUI**. The plugin page renders Solid components through `@opentui/solid` (`box`, `text`, `input`, keymap, theme tokens). "Moving to OpenTUI" as a standalone app would not add a native composer or native sessions; it would replace the host integration that provides them.

**Recommendation: stay a native OpenCode TUI plugin, and adopt more OpenTUI primitives incrementally.** Do not build a standalone OpenTUI application now.

## What is already OpenTUI

- `src/v2/tui/app.tsx` and `components.tsx` are Solid/OpenTUI JSX rendered inside the OpenCode TUI route.
- Layout, text, input, keymap layers, dialogs, toasts, theme tokens, and navigation come from `@opencode/plugin/tui` + `@opentui/solid`.
- `@opentui/core` is a peer dependency (currently `>=0.7.0`).
- The custom composer is an OpenTUI `input` renderable with `$`/`@`/`/` completion.

## Options

| Option | Benefits | Costs / risks | Verdict |
|---|---|---|---|
| **A. Stay plugin-native, deepen OpenTUI use** | Keeps native sessions, tools, permissions, providers, keymap, dialogs, theme, auth, and updates. Small blast radius. | Host owns some surfaces; native prompt autocomplete cannot be embedded directly. | **Recommended** |
| **B. Standalone OpenTUI app using OpenCode client/SDK** | Full control of composer, layout, markdown, scrolling, and process lifecycle. | Reimplement session tabs, prompt, permissions, provider/auth, theme, updates, and native keymap behavior. Duplicate bug surface. Separate process/window. | Not now |
| **C. Replace the OpenCode TUI** | Maximum control. | Reimplements the entire host; high maintenance and compatibility risk. | Rejected |

## Why a standalone OpenTUI app would not fix the composer

The native OpenCode composer is owned by the host. OpenTUI is the rendering layer, not a drop-in OpenCode prompt. A standalone OpenTUI app would still need its own slash commands, file completion, provider handling, permission prompts, and session routing. Ensemble's current custom composer already implements the useful group-chat subset:

- `$Name` agent mentions with picker
- `!Name` alias
- `@path` workspace file picker
- `/` Ensemble command palette
- literal `~`, `/`, `@`, `$` text while focused
- stable recipient IDs independent of display-name changes

## Recommended incremental OpenTUI work

1. Replace the manual message viewport with `scrollbox` when the host exposes a stable scroll model.
2. Use the OpenTUI markdown renderable for replies if a `SyntaxStyle` can be obtained from the host; otherwise keep the current basic Markdown normalizer.
3. Keep `input` for the composer until OpenCode exposes a native prompt slot or composer API.
4. Keep all host-owned behavior (sessions, approvals, models, permissions) behind the plugin API.

## Decision

No standalone migration. Revisit only if one of these becomes true:

- OpenCode exposes the native prompt/composer as an embeddable slot.
- Ensemble needs windows or surfaces that cannot exist inside the OpenCode TUI.
- The plugin TUI API stops supporting the required route, keymap, or session primitives.

Until then, plugin-native + more OpenTUI primitives is the lower-risk, higher-compatibility path.
