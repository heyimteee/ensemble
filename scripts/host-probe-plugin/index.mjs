// Ticket #210: host event-contract recorder.
//
// This plugin is loaded only by the isolated probe host. It subscribes through
// the same plugin context the Ensemble service uses and appends every selected
// host event, plus a readiness marker per location, to a JSONL file. The probe
// driver owns orchestration and normalization; this module records raw events
// so the driver can deduplicate them against its own HTTP subscription.

import { appendFileSync } from "node:fs"

const file = process.env.ENSEMBLE_HOST_PROBE_EVENTS
const TYPES = [
  "session.created",
  "session.deleted",
  "session.moved",
  "session.archived",
  "session.unarchived",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.inbox.delivery.changed",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.retry.scheduled",
  "session.status",
  "session.idle",
  "session.synthetic",
]

function append(value) {
  if (!file) return
  try {
    appendFileSync(file, JSON.stringify(value) + "\n")
  } catch {
    // A probe must never break the host it measures.
  }
}

export default {
  id: "ensemble.host-probe",
  async setup(ctx) {
    append({ kind: "ready", directory: ctx.location?.directory })
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ types: TYPES, signal: controller.signal })) {
          append({ kind: "event", observer: ctx.location?.directory, event })
        }
      } catch {
        // Disposal or host teardown closes the iterator.
      }
    })()
    return () => controller.abort()
  },
}
