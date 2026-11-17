---
title: Initialize a workspace
description: Run Ensemble init, read its report, and understand the generated AGENTS.md block and .ensemble metadata.
version: 0.1.x
---

# Initialize a workspace

Init inspects the project and writes two things: a canonical Ensemble block in
`AGENTS.md` and init metadata under `.ensemble/`. It also runs a native `/init`
turn so the agent can add verified project guidance around that block.

## Before you start

- The workspace is open on its group chat. Init is workspace-only and does not
  run from a direct chat.
- The workspace leader exists, is not archived, and is a member.
- You can write `AGENTS.md` and `.ensemble/` in the workspace directory.
- Commit or stash current work so you can compare the generated files.
- Read [Data classes and retention](../privacy/data-and-retention.md) for the
  roster disclosure in `AGENTS.md`.

## Steps

1. Open the workspace group chat and press `I`.
   `:init` on the command line and `/init` by itself in the composer start the
   same job. `/init` must be sent alone: no agent mention, extra text, or other
   skill.

2. Watch the **System Agent** row in the transcript.
   It reports the stages `Initializing workspace…`, `Inspecting AGENTS.md and
   .ensemble/init.json with native /init…`, `Writing AGENTS.md and
   .ensemble/init.json…`, and `Preparing the init report…`. The native stage is
   indeterminate, so there is no percentage.

3. Read the settled report. A success starts with `Ensemble init complete.`,
   includes the native init report, and names the inspected directory and both
   written files.

4. Inspect `AGENTS.md`.
   The generated block starts with `<!-- ensemble:start v7 -->` and ends with
   `<!-- ensemble:end -->`. It holds the team contract and a roster table of
   active members, leader first. Project-owned guidance stays below the block.

5. Inspect `.ensemble/`.
   `config.json` records the workspace name, leader, members, synthesis, and
   paused state. `init.json` records the accepted contract version and install
   time, for example:

   ```json
   {
     "version": 7,
     "installedAt": 1700000000000
   }
   ```

   The directory also holds `handoffs/`, and Ensemble adds `.ensemble/` to
   `.gitignore` on first use.

6. Leave the generated block in place. A later workspace or roster change
   refreshes the block in place instead of adding a second copy.

## Expected result

- `AGENTS.md` contains exactly one current Ensemble block at the top, followed
  by the project's own guidance.
- `.ensemble/init.json` records the current contract version and an install
  time. `.ensemble/config.json` remains the workspace's config record.
- The report names what was inspected and what changed. Init is a System Agent
  job, so it does not create a work item or spend a dispatch hop.
- Re-running init replaces the block in place and never leaves two Ensemble
  blocks behind.

## Troubleshooting

- **"Init is workspace-only. Open a workspace and rerun /init."** You are in a
  direct chat. Open the workspace group chat first.
- **"Init is solo-only. Send /init by itself; remove agent mentions, skills, and
  extra text."** Send exactly `/init`.
- **"An init is already running for this workspace."** Wait for the System Agent
  report, then rerun if needed.
- **"The workspace leader is missing or archived."** Restore an active leader in
  the workspace editor before running init.
- **The report says init failed, was cancelled, or was interrupted.** Ensemble
  restores the previous `AGENTS.md` or removes a file it created, and removes
  unaccepted `init.json` metadata. Rerun init after fixing the cause. If the
  report says the restore could not be confirmed, compare `AGENTS.md` with your
  commit before rerunning.
- **The native report is missing.** The block write still completes; the report
  says the native init returned no text. Rerun init if you need the project
  guidance regenerated.

## Next

- [Edit members and the leader](edit-members-and-leader.md): the generated roster
  follows the workspace configuration.
- [Route messages](route-messages.md): put the initialized guidance to work.
- [Back up or restore](back-up-or-restore.md): protect durable state and
  workspace config.
- [Files and storage reference](../reference/files.md): exact `.ensemble`,
  `AGENTS.md`, and plugin-storage paths.
