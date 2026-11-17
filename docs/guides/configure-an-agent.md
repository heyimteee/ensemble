---
title: Configure an agent
description: Change an agent's identity, main and backup models, Skillbox, and save behavior.
version: 0.1.x
---

# Configure an agent

Agent settings are a draft until you save them. The tabs cover identity, models,
memories, and the Skillbox; memory management has its own guide.

## Before you start

- The agent exists in the roster.
- OpenCode reports the models you want to choose.
- Read [Agents, workspaces, and the leader](../concepts/agents-and-workspaces.md)
  and [Skills](../concepts/skills.md) for the concepts behind the fields.


<DocsFigure
  src="/media/settings.png"
  alt="Ada's settings surface with General, Models, Memories, and Skillbox tabs, identity rows, model summary, and native-mirror toggle."
  caption="Agent settings open on General and stay a draft until you save. press h or l to switch tabs; j or k to move rows; s to save."
  width="700"
  height="930"
/>

## Steps

1. Select the agent in the rail and press `s`.
   Settings opens on the **General** tab. The header shows the agent name and
   **UNSAVED** after the first edit.

2. Move with `j`/`k`, switch tabs with `h`/`l`, and press `Enter` or `e` on a row
   to edit it. Press `Enter` again to finish a text field.
   General edits the name, title, role, color, main model, and the native-mirror
   toggle. A name must stay unique among active agents.

3. On **Models**, press `Enter` on the main-model row to open the picker. Choose
   a provider and model, then a reasoning effort when variants are offered.
   Backups appear below the main model.

4. Press `a` to add a backup model, `x` to remove one, and `J`/`K` to reorder the
   list. The order is the fallback order.
   Ensemble tries a backup only when the main model has an availability failure.
   It announces a switch in the transcript.

5. On **Skillbox**, press `/` to filter, `j`/`k` to move, and `Space` to assign or
   unassign a skill. See [Use a skill](use-skills.md) for invocation.

6. On **Memories**, add, edit, delete, or promote entries. See
   [Manage memory](manage-memory.md) for the memory workflow.

7. Press `s` to save and close settings.
   Ensemble validates the draft, saves it, closes the surface, and shows one
   `Saved <name>.` confirmation. Pressing `Esc` with unsaved changes asks before
   discarding them.

## Expected result

- The rail and settings show the new name, title, color, and model summary after
  saving.
- A saved role, main model, backup list, or Skillbox applies to the agent's next
  turn in its existing native session. A turn that is already running keeps the
  settings with which it started.
- The native-mirror toggle changes whether prompts typed directly in the
  agent's native session are mirrored into the Ensemble conversation. It does
  not change host tool permissions.
- Unsaved edits do not affect any turn.

## Troubleshooting

- **"Agent name already exists: <name>."** Choose a name no other active agent
  uses.
- **"No models are available."** Check the OpenCode provider configuration and
  reopen the picker.
- **The header still says UNSAVED.** Press `s` to save. Closing with `Esc` asks
  before discarding a dirty draft.
- **A saved Skillbox skill is rejected at invocation.** The host catalog may no
  longer offer it. Remove the stale assignment and choose an available skill.

## Next

- [Manage memory](manage-memory.md): curate what the agent remembers.
- [Use a skill](use-skills.md): invoke an assigned skill.
- [Use the Work pane](use-the-work-pane.md): see the next turn apply the saved
  settings.
- [Configuration reference](../reference/configuration.md): exact stored agent
  and workspace fields.
