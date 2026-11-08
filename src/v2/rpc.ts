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

/** Ticket #141: server-derived unread/busy counts, never client scans. */
const counts = {
  type: "object",
  additionalProperties: {
    type: "object",
    properties: {
      unread: { type: "number" },
      busy: { type: "number" },
    },
    required: ["unread", "busy"],
    additionalProperties: false,
  },
}

const scopeVersions = {
  type: "object",
  properties: {
    shell: { type: "number" },
    work: { type: "number" },
    transcript: { type: "number" },
  },
  required: ["shell", "work", "transcript"],
  additionalProperties: false,
}

const transcriptWindow = {
  type: "object",
  properties: {
    workspaceID: { type: "string" },
    messages: { type: "array", items: { type: "object", additionalProperties: true } },
    oldestSeq: { type: "number" },
    newestSeq: { type: "number" },
    hasMoreOlder: { type: "boolean" },
    limit: { type: "number" },
  },
  required: ["messages", "hasMoreOlder", "limit"],
  additionalProperties: false,
}

const tier3Gate = {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
    reason: { type: "string" },
    messageCount: { type: "number" },
    taskCount: { type: "number" },
    snapshotBytes: { type: "number" },
    snapshotMs: { type: "number" },
  },
  required: ["enabled", "reason", "messageCount", "taskCount"],
  additionalProperties: false,
}

const patchFields = {
  epoch: { type: "number" },
  from: { type: "number" },
  version: { type: "number" },
  entries: { type: "array", items: changeEntry },
  reset: { type: "boolean" },
  meta: feedMeta,
  counts,
  scopeVersions,
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
          counts,
        },
        required: ["state", "models", "skills", "directory"],
        additionalProperties: false,
      },
    },
    /** Ticket #141: gated scoped bootstrap. Same shape as a snapshot, with read models. */
    bootstrap: {
      input: {
        type: "object",
        properties: { directory: { type: "string" }, workspaceID: { type: "string" } },
        required: ["directory"],
        additionalProperties: false,
      },
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
          scoped: { type: "boolean" },
          window: {
            type: "object",
            properties: {
              oldestSeq: { type: "number" },
              newestSeq: { type: "number" },
              hasMoreOlder: { type: "boolean" },
              limit: { type: "number" },
            },
            required: ["hasMoreOlder", "limit"],
            additionalProperties: false,
          },
          counts,
          gate: tier3Gate,
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
          counts,
          scopeVersions,
          gate: tier3Gate,
        },
        required: ["version", "catalogRevision", "configRevision", "protocol", "epoch"],
        additionalProperties: false,
      },
    },
    /** Ticket #141: visible Work projection only; no long-retained terminal rows. */
    "work.project": {
      input: directory,
      output: {
        type: "object",
        properties: {
          version: { type: "number" },
          epoch: { type: "number" },
          counts,
          tasks: { type: "object", additionalProperties: true },
          groups: { type: "object", additionalProperties: true },
        },
        required: ["version", "epoch", "counts", "tasks", "groups"],
        additionalProperties: false,
      },
    },
    /** Ticket #141: one paginated durable transcript window. */
    "transcript.window": {
      input: {
        type: "object",
        properties: {
          directory: { type: "string" },
          workspaceID: { type: "string" },
          beforeSeq: { type: "number" },
          limit: { type: "number" },
        },
        required: ["directory"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          version: { type: "number" },
          epoch: { type: "number" },
          ...transcriptWindow.properties,
        },
        required: ["version", "epoch", "workspaceID", "messages", "hasMoreOlder", "limit"],
        additionalProperties: false,
      },
    },
    /** Ticket #141: fetch one durable message (for example a result outside the window). */
    "message.get": {
      input: {
        type: "object",
        properties: {
          directory: { type: "string" },
          workspaceID: { type: "string" },
          messageID: { type: "string" },
        },
        required: ["directory", "messageID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          found: { type: "boolean" },
          message: { type: "object", additionalProperties: true },
        },
        required: ["found"],
        additionalProperties: false,
      },
    },
    /** Ticket #141: repair only the scopes whose durable state moved. */
    resync: {
      input: {
        type: "object",
        properties: {
          directory: { type: "string" },
          workspaceID: { type: "string" },
          scopes: { type: "array", items: { type: "string" } },
        },
        required: ["directory", "scopes"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          epoch: { type: "number" },
          version: { type: "number" },
          scopeVersions,
          shell: { type: "object", additionalProperties: true },
          work: { type: "object", additionalProperties: true },
          dispatchGroups: { type: "object", additionalProperties: true },
          transcript: transcriptWindow,
          counts,
          gate: tier3Gate,
          meta: feedMeta,
        },
        required: ["epoch", "version", "scopeVersions", "counts"],
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
          reason: { type: "string" },
          entries: { type: "array", items: changeEntry },
          meta: feedMeta,
          counts,
          scopeVersions,
        },
        required: ["epoch", "version", "reset", "entries"],
        additionalProperties: false,
      },
    },
    /** Ticket #145: bounded recent service log entries plus sink metadata. */
    "logs.recent": {
      input: {
        type: "object",
        properties: {
          directory: { type: "string" },
          limit: { type: "number" },
          level: { type: "string" },
          cat: { type: "string" },
          event: { type: "string" },
          taskID: { type: "string" },
          instanceID: { type: "string" },
        },
        required: ["directory"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          entries: { type: "array", items: { type: "object", additionalProperties: true } },
          stats: { type: "object", additionalProperties: true },
        },
        required: ["entries", "stats"],
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
          dispatch: {
            type: "object",
            properties: {
              summary: { type: "object", additionalProperties: true },
              groups: { type: "array", items: { type: "object", additionalProperties: true } },
            },
            required: ["summary", "groups"],
            additionalProperties: false,
          },
          logs: { type: "object", additionalProperties: true },
          service: { type: "object", additionalProperties: true },
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
    /**
     * Ticket #155: coalesced, version-neutral native tool activity for one
     * Work card. Empty `label` with an idle/terminal status clears the card.
     */
    "work.activity": {
      schema: {
        type: "object",
        properties: {
          epoch: { type: "number" },
          workspaceID: { type: "string" },
          taskID: { type: "string" },
          sessionID: { type: "string" },
          label: { type: "string" },
          tool: { type: "string" },
          status: { type: "string" },
          updatedAt: { type: "number" },
        },
        required: ["epoch", "workspaceID", "taskID", "sessionID", "label", "status", "updatedAt"],
        additionalProperties: false,
      },
    },
  },
})
