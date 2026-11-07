import { Rpc } from "@opencode/plugin"

const directory = {
  type: "object",
  properties: { directory: { type: "string" } },
  required: ["directory"],
  additionalProperties: false,
}

/** Ticket #138/#140: one entity-change set plus its coordination version. */
const changeEntry = {
  type: "object",
  properties: {
    version: { type: "number" },
    changes: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    entities: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    other: { type: "boolean" },
    nonEntity: { type: "boolean" },
  },
  required: ["version", "changes"],
  additionalProperties: false,
}

/** Ticket #140: catalog/config metadata carried beside the entity feed. */
const feedMeta = {
  type: "object",
  properties: {
    catalogRevision: { type: "number" },
    models: { type: "array", items: { type: "object", additionalProperties: true } },
    skills: { type: "array", items: { type: "object", additionalProperties: true } },
    modelsError: { type: "string" },
    directory: { type: "string" },
    configRevision: { type: "number" },
    configError: { type: "string" },
  },
  additionalProperties: false,
}

const patchFields = {
  epoch: { type: "number" },
  from: { type: "number" },
  version: { type: "number" },
  entries: { type: "array", items: changeEntry },
  reset: { type: "boolean" },
  meta: feedMeta,
}

export const EnsembleV2Rpc = Rpc.define({
  id: "ensemble.v2",
  methods: {
    snapshot: {
      input: directory,
      output: {
        type: "object",
        properties: {
          state: { type: "object", additionalProperties: true },
          models: { type: "array", items: { type: "object", additionalProperties: true } },
          skills: { type: "array", items: { type: "object", additionalProperties: true } },
          directory: { type: "string" },
          configError: { type: "string" },
          modelsError: { type: "string" },
          catalogRevision: { type: "number" },
          configRevision: { type: "number" },
          protocol: { type: "number" },
          epoch: { type: "number" },
        },
        required: ["state", "models", "skills", "directory"],
        additionalProperties: false,
      },
    },
    revision: {
      input: directory,
      output: {
        type: "object",
        properties: {
          version: { type: "number" },
          catalogRevision: { type: "number" },
          configRevision: { type: "number" },
          protocol: { type: "number" },
          epoch: { type: "number" },
        },
        required: ["version", "catalogRevision", "configRevision", "protocol", "epoch"],
        additionalProperties: false,
      },
    },
    "changes.since": {
      input: {
        type: "object",
        properties: {
          directory: { type: "string" },
          epoch: { type: "number" },
          version: { type: "number" },
        },
        required: ["directory", "epoch", "version"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          epoch: { type: "number" },
          version: { type: "number" },
          reset: { type: "boolean" },
          entries: { type: "array", items: changeEntry },
          meta: feedMeta,
        },
        required: ["epoch", "version", "reset", "entries"],
        additionalProperties: false,
      },
    },
    diagnostic: {
      input: directory,
      output: {
        type: "object",
        properties: {
          state: { type: "object", additionalProperties: true },
          directory: { type: "string" },
          clones: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              count: { type: "number" },
              totalMs: { type: "number" },
              maxMs: { type: "number" },
              lastMs: { type: "number" },
            },
            required: ["enabled", "count", "totalMs", "maxMs", "lastMs"],
            additionalProperties: false,
          },
        },
        required: ["state", "directory"],
        additionalProperties: false,
      },
    },
    invoke: {
      input: {
        type: "object",
        properties: {
          directory: { type: "string" },
          action: { type: "string" },
          payload: { type: "object", additionalProperties: true },
        },
        required: ["directory", "action"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          result: {},
          error: {
            type: "object",
            properties: { code: { type: "string" }, message: { type: "string" } },
            required: ["code", "message"],
            additionalProperties: false,
          },
        },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {
          version: { type: "number" },
          workspaceID: { type: "string" },
          subtaskID: { type: "string" },
          correlationID: { type: "string" },
          kind: { type: "string" },
        },
        required: ["version"],
        additionalProperties: false,
      },
    },
    patches: {
      schema: {
        type: "object",
        properties: patchFields,
        required: ["epoch", "from", "version", "entries"],
        additionalProperties: false,
      },
    },
    /** Ticket #139: coalesced, version-neutral live text for one row. */
    stream: {
      schema: {
        type: "object",
        properties: {
          epoch: { type: "number" },
          workspaceID: { type: "string" },
          id: { type: "string" },
          text: { type: "string" },
          updatedAt: { type: "number" },
        },
        required: ["epoch", "workspaceID", "id", "text", "updatedAt"],
        additionalProperties: false,
      },
    },
  },
})
