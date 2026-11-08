/**
 * Reusable Ensemble tool registration (ticket #153).
 *
 * The realm service owns the store and the tool behavior; each host location
 * owns one `ctx.tool.transform` registration. Keeping the declarations separate
 * from both lets the location adapter install the same toolset on every
 * context without treating the first plugin context as the host authority.
 */
type Json = Record<string, any>

export type ToolResult = { content: string }

export interface EnsembleToolHandlers {
  workspaceInfo(context: any): Promise<ToolResult>
  listWorkspaces(): Promise<ToolResult>
  listAgents(): Promise<ToolResult>
  taskStatus(input: Json, context: any): Promise<ToolResult>
  sendMessage(input: Json, context: any): Promise<ToolResult>
  handoff(input: Json, context: any): Promise<ToolResult>
  delegate(input: Json, context: any): Promise<ToolResult>
  review(input: Json, context: any): Promise<ToolResult>
  askPerson(input: Json, context: any): Promise<ToolResult>
  remember(input: Json, context: any): Promise<ToolResult>
  share(input: Json, context: any): Promise<ToolResult>
}

export type EnsembleToolEditor = {
  namespace(definition: { name: string; description: string }): void
  add(tool: {
    name: string
    options: { namespace: string; codemode: boolean }
    description: string
    input: Record<string, unknown>
    execute: (input: any, context: any) => Promise<ToolResult>
  }): void
}

/** The one Ensemble toolset installed on each host location's context. */
export function registerEnsembleTools(editor: EnsembleToolEditor, handlers: EnsembleToolHandlers): void {
  editor.namespace({ name: "ensemble", description: "Ensemble workspace collaboration." })
  editor.add({
    name: "workspace_info",
    options: { namespace: "ensemble", codemode: false },
    description: "Show the current Ensemble workspace, directory, leader, members, and paused state.",
    input: { type: "object", properties: {}, additionalProperties: false },
    execute: async (_input, context) => handlers.workspaceInfo(context),
  })
  editor.add({
    name: "list_workspaces",
    options: { namespace: "ensemble", codemode: false },
    description: "List Ensemble workspaces and their directories, leaders, and members.",
    input: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => handlers.listWorkspaces(),
  })
  editor.add({
    name: "list_agents",
    options: { namespace: "ensemble", codemode: false },
    description: "List the Ensemble roster, workspace membership, and busy state.",
    input: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => handlers.listAgents(),
  })
  editor.add({
    name: "task_status",
    options: { namespace: "ensemble", codemode: false },
    description: "List pending, working, and replied Ensemble subtasks.",
    input: { type: "object", properties: { workspaceID: { type: "string" } }, additionalProperties: false },
    execute: async (input, context) => handlers.taskStatus(input, context),
  })
  editor.add({
    name: "send_message",
    options: { namespace: "ensemble", codemode: false },
    description: "Post a message to the group chat or queue a direct message to an agent.",
    input: {
      type: "object",
      properties: { kind: { type: "string", enum: ["workspace", "agent"] }, id: { type: "string" }, text: { type: "string" } },
      required: ["kind", "text"],
      additionalProperties: false,
    },
    execute: async (input, context) => handlers.sendMessage(input, context),
  })
  editor.add({
    name: "handoff",
    options: { namespace: "ensemble", codemode: false },
    description: "Queue a typed hop to a teammate; the answer is relayed back here. The asking turn stays open until it lands — never follow a handoff with ensemble_delegate. Write a self-authored instruction for the recipient (what to do, context, expected output) — never paste the user's message verbatim; task stays the short display title.",
    input: {
      type: "object",
      properties: { task: { type: "string" }, instruction: { type: "string" }, summary: { type: "string" }, path: { type: "string" }, to: { type: "string" }, constraints: { type: "string" }, expected: { type: "string" } },
      required: ["task", "summary", "path"],
      additionalProperties: false,
    },
    execute: async (input, context) => handlers.handoff(input, context),
  })
  editor.add({
    name: "delegate",
    options: { namespace: "ensemble", codemode: false },
    description: "Delegate a typed subtask to another workspace member and record it on the board. Ensemble leader only — peers hand off with ensemble_handoff, which already queues the hop.",
    input: {
      type: "object",
      properties: {
        assignee: { type: "string" },
        title: { type: "string" },
        instruction: { type: "string" },
        constraints: { type: "string" },
        expected: { type: "string" },
        mode: { type: "string", enum: ["research", "edit"] },
      },
      required: ["assignee", "title", "instruction"],
      additionalProperties: false,
    },
    execute: async (input, context) => handlers.delegate(input, context),
  })
  editor.add({
    name: "review",
    options: { namespace: "ensemble", codemode: false },
    description: "Decide each item in a batch review turn (delegate, start, end, or dismiss). The batch closes only when every item is decided; non-leader reviewers hand it onward to the leader.",
    input: {
      type: "object",
      properties: {
        batch: { type: "string" },
        decisions: {
          type: "array",
          items: {
            type: "object",
            properties: { item: { type: "string" }, action: { type: "string" }, assignee: { type: "string" }, note: { type: "string" } },
            required: ["item", "action"],
            additionalProperties: false,
          },
        },
        hand_to: { type: "string" },
      },
      required: ["batch", "decisions"],
      additionalProperties: false,
    },
    execute: async (input, context) => handlers.review(input, context),
  })
  editor.add({
    name: "ask_person",
    options: { namespace: "ensemble", codemode: false },
    description: "Ask the user for a judgment call and pause this subtask until they answer.",
    input: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false },
    execute: async (input, context) => handlers.askPerson(input, context),
  })
  editor.add({
    name: "remember",
    options: { namespace: "ensemble", codemode: false },
    description: "Save durable project, workspace, or cross-project knowledge. Cross-project knowledge needs approval.",
    input: {
      type: "object",
      properties: { text: { type: "string" }, scope: { type: "string", enum: ["project", "workspace", "global"] } },
      required: ["text", "scope"],
      additionalProperties: false,
    },
    execute: async (input, context) => handlers.remember(input, context),
  })
  editor.add({
    name: "share",
    options: { namespace: "ensemble", codemode: false },
    description: "Request authorization before cross-project or private-transcript disclosure.",
    input: {
      type: "object",
      properties: { text: { type: "string" }, scope: { type: "string", enum: ["cross_project", "private_transcript"] } },
      required: ["text", "scope"],
      additionalProperties: false,
    },
    execute: async (input, context) => handlers.share(input, context),
  })
}
