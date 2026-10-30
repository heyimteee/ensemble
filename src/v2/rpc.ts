import { Rpc } from "@opencode/plugin"

const directory = {
  type: "object",
  properties: { directory: { type: "string" } },
  required: ["directory"],
  additionalProperties: false,
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
        },
        required: ["state", "models", "skills", "directory"],
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
        properties: { version: { type: "number" } },
        required: ["version"],
        additionalProperties: false,
      },
    },
  },
})
