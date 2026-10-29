# OpenCode 2.2.1 compatibility report

Status: **verified against a real isolated installation**
Tested: 2026-10-29
Target: OpenCode **2.2.1** on Linux, TUI only
Ticket: [#2](https://github.com/heyimteee/ensemble/issues/2)

This report answers one question: can Ensemble be built as a supported TUI extension without patching OpenCode or replacing native behavior? The answer is **yes, with the constraints below**.

## Method

- Used an isolated config, data, state, and project directory under `/tmp/opencode/ensemble-probe`; the user's global configuration and sessions were not changed.
- Loaded a real TUI plugin that registered a route, sidebar content, a command, a toast, and durable storage.
- Loaded real server plugins through `.opencode/plugins/` and verified their APIs.
- Used a local OpenAI-compatible test provider and a scripted model server to exercise actual model requests, tool calls, and permission decisions.
- Created two probe agents with different `skill` permissions over the same two probe skills.
- Closed every TUI while a server-owned request was still running.

The probe code lived outside the repository. No core patch, private API, or global configuration change was used.

## Results

| Area | Result | Evidence |
| --- | --- | --- |
| TUI plugin loading | **Pass** | A local `tui.tsx` loaded under `cli.json`; `setup` ran and durable TUI APIs were present. |
| Custom TUI route | **Pass** | `ui.router.register` plus `navigate({ type: "plugin", name })` rendered a custom page. |
| TUI sidebar content | **Pass** | `ui.slot({ append: "sidebar.content" })` rendered `ENSEMBLE_PROBE_SIDEBAR` inside a native session screen. |
| Commands and toasts | **Pass** | A keymap command with slash/palette metadata registered; a success toast rendered. |
| TUI durable storage | **Pass** | TUI and server storage APIs were present. Server storage retained `{ count: 1 }` across a server restart and read it back as `previous` on the next load. |
| Server plugin loading | **Pass** | Local `.opencode/plugins/*.ts` loaded; plugin status became `active`. |
| Server session API | **Pass** | Created sessions, admitted prompts, waited for idle, and read native context and tool results through the public API. |
| Native permissions | **Pass** | A denied `skill` call produced `permission.rejected: "Permission denied: skill"` and the agent continued with a tool result. |
| Exclusive Skillbox: catalog hiding | **Pass** | The `probe-beta` request contained only `beta` in `<available_skills>`; `alpha` was absent. The `probe-alpha` request contained only `alpha`. |
| Exclusive Skillbox: loading denial | **Pass** | `probe-beta` called `skill({ id: "alpha" })` and received `permission.rejected`; `probe-alpha` loaded `alpha` successfully with its `SKILL.md` content. |
| Per-agent model and variants | **Pass** | The probe model exposed `low`, `medium`, and `high` variants. Sessions selected variants successfully. |
| Model variant validation | **Caveat** | Session creation accepts an unknown variant such as `bogus`; execution fails later with `provider.no-route: Variant unavailable`. Ensemble must validate before saving. |
| Native background work | **Pass (standalone server)** | A prompt was still running when the last TUI was killed; the server completed it about 3.5 seconds later with `outcome: succeeded`. |
| Native queued input | **Pass** | A second prompt admitted with `delivery: "queue"` waited while the first ran, then executed; the inbox drained and the session reached idle. |
| Inter-plugin coexistence | **Pass** | Two local server plugins were active at the same time in the same location. |
| Shared global background service | **Not exercised end to end** | The shared service is running and API-reachable, but tests used an isolated standalone server to avoid touching global data/configuration. The same server engine and native lifecycle are expected. |

## Verified messages and shapes

### Skill catalog hiding

With `probe-beta` configured as `skill * deny`, `skill beta allow`, the outgoing model request contained only:

```xml
<available_skills>
  <skill>
    <id>beta</id>
    <name>Probe Beta</name>
    <description>Probe skill beta for Ensemble compatibility validation.</description>
  </skill>
</available_skills>
```

### Skill loading denial

The native tool result was:

```json
{
  "type": "tool",
  "name": "skill",
  "state": {
    "status": "error",
    "error": {
      "type": "permission.rejected",
      "message": "Permission denied: skill"
    }
  }
}
```

### Allowed skill load

`probe-alpha` loaded `alpha` and received a `<skill_content name="Probe Alpha">` block, including the skill's base directory.

### Unknown model variant

```json
{
  "type": "idle",
  "outcome": "failed",
  "error": {
    "type": "provider.no-route",
    "message": "Variant unavailable for probe-local/probe-model: bogus"
  }
}
```

### Background survival

- TUI killed while the model request was in flight.
- No TUI connected.
- Session reached `outcome: succeeded` with the tool call completed.
- The session and its context were still readable after the TUI was gone.

## Constraints for implementation

### 1. The TUI has no global workspace navigation slot

The supported slot paths are `app`, `home.footer`, `prompt.footer*`, `session.composer.top`, `session.panel`, `sidebar.content`, and `sidebar.footer`.

- `sidebar.content` is rendered **inside a native session screen**; it is not a global sidebar.
- Replacing `app` would take over the whole TUI, which conflicts with the extend-never-replace requirement.
- Native `tabs` are **session tabs**, not a workspace tab type.

**Decision:** build the Ensemble workspace as a plugin page with its own internal navigation (Agents, project-grouped Channels, Approvals), opened by a slash command or palette command. Channel conversations open native sessions in normal session tabs. Do not claim a native global tab that the TUI does not provide.

### 2. Skill enforcement has a bypass on the experimental session API

Native **agent-initiated** skill use is enforced correctly. However, in 2.2.1:

- `POST /api/experimental/session/{id}/skill` appended unassigned skill content without a permission check.
- `POST /api/session/{id}/prompt` with a `skills` attachment also attached skill content without a permission check.

These are user-facing/experimental activation paths, not the `skill` tool path.

**Decision:** Ensemble must not use either path to grant an agent an unassigned skill. Restrict UI skill attachments to the agent's Skillbox, and rely on the native per-agent `skill` permissions for agent-invoked loads. Validate this again in the final integration ticket.

### 3. Registry reads during plugin `setup` can be incomplete

A server plugin that called `ctx.skill.list()` and `ctx.agent.list()` immediately in `setup` saw only built-in skills and no config-defined agents. Later API reads saw the probe agents and project skills. Reading early did not produce a stable snapshot.

**Decision:** load catalogs after location activation, or subscribe to update events and reload. Normalize the list response because the installed API returned `{ location, data }`, not a bare array.

### 4. Use one plugin source per plugin

Configuring the same plugin both through `plugins` and auto-discovery produced:

```text
Duplicate plugin ID: ensemble.probe.server
```

**Decision:** ship Ensemble through one loading path. Do not configure a local plugin path and also place the same plugin under `.opencode/plugins/`.

### 5. Model variants must be validated by Ensemble

Unknown variants are accepted at session creation and fail only at execution.

**Decision:** populate settings from the model's reported variants and reject unknown values before saving. Do not rely on session creation to validate.

## Feature-level verification

The compatibility probe did not implement product features. The implementation verification record covers settings, channel routing, handoffs, approvals, queues, editing locks, chain limits, concurrent work, and background execution on the same isolated 2.2.1 installation:

- [Implementation verification, 2026-10-29](../verification/2026-10-29.md)

Still unverified at the compatibility boundary:

- The shared `opencode service` lifecycle with real Ensemble work (the isolated standalone server was used).
- Multiple TUI clients resolving the same approval.
- Worktree-based parallel editing and cross-checkout coordination beyond the in-process editing queue.
- GUI or web clients; these are out of scope.

## Conclusion

The supported extension surface is sufficient for Ensemble. No core fork or private API is required. Start implementation with the workspace page and native sessions, using native per-agent skill permissions, and keep the bypass paths out of the product.
