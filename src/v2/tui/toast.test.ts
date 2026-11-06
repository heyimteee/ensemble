import test from "node:test"
import assert from "node:assert/strict"
import {
  TOAST_QUEUE_LIMIT,
  clearToasts,
  createToastState,
  dismissToast,
  expireToasts,
  feedbackChannel,
  initToast,
  nextToastDeadline,
  pushToast,
  toastDuration,
  toastPlacement,
} from "./toast.ts"

const notice = (message: string, tone: "info" | "success" | "warning" | "error" = "info") => ({
  title: "Ensemble",
  message,
  tone,
})

test("toasts show immediately, queue in order, and bound the queue", () => {
  let state = createToastState()
  state = pushToast(state, notice("first"), 1_000)
  assert.equal(state.visible?.message, "first")
  assert.deepEqual(state.queue, [])
  assert.equal(state.visible?.expiresAt, 1_000 + toastDuration("info"))

  state = pushToast(state, notice("second", "success"), 1_010)
  state = pushToast(state, notice("third", "warning"), 1_020)
  state = pushToast(state, notice("fourth", "error"), 1_030)
  assert.equal(state.visible?.message, "first", "the current toast stays visible")
  assert.deepEqual(
    state.queue.map((toast) => toast.message),
    ["second", "third", "fourth"],
    "toasts queue in arrival order",
  )

  state = pushToast(state, notice("fifth"), 1_040)
  assert.deepEqual(
    state.queue.map((toast) => toast.message),
    ["third", "fourth", "fifth"],
    `the queue keeps at most ${TOAST_QUEUE_LIMIT} waiting toasts and drops the oldest`,
  )
  assert.equal(new Set([state.visible?.id, ...state.queue.map((toast) => toast.id)]).size, 4, "every toast id is unique")
})

test("a toast auto-dismisses at its deadline and promotes the next with a fresh deadline", () => {
  let state = createToastState()
  state = pushToast(state, notice("first"), 5_000)
  state = pushToast(state, notice("second", "success"), 5_100)
  assert.equal(nextToastDeadline(state), 5_000 + toastDuration("info"))

  state = expireToasts(state, 5_000 + toastDuration("info") - 1)
  assert.equal(state.visible?.message, "first", "a toast stays until its deadline")

  const promotedAt = 5_000 + toastDuration("info")
  state = expireToasts(state, promotedAt)
  assert.equal(state.visible?.message, "second", "the queued toast takes over")
  assert.deepEqual(state.queue, [])
  assert.equal(
    state.visible?.expiresAt,
    promotedAt + toastDuration("success"),
    "the promoted toast gets a full display window at promotion time",
  )
  assert.equal(nextToastDeadline(state), state.visible?.expiresAt)

  state = expireToasts(state, promotedAt + toastDuration("success"))
  assert.equal(state.visible, null)
  assert.equal(nextToastDeadline(state), undefined)
})

test("manual dismiss advances the queue and clearing removes everything", () => {
  let state = createToastState()
  state = pushToast(state, notice("first"), 1_000)
  state = pushToast(state, notice("second"), 1_100)
  state = pushToast(state, notice("third"), 1_200)

  state = dismissToast(state, 1_500)
  assert.equal(state.visible?.message, "second")
  assert.deepEqual(state.queue.map((toast) => toast.message), ["third"])

  state = clearToasts(state)
  assert.equal(state.visible, null)
  assert.deepEqual(state.queue, [])
  assert.equal(nextToastDeadline(state), undefined)
})

test("error toasts stay longer than info, success, and warning", () => {
  assert.equal(toastDuration("info"), toastDuration("success"))
  assert.equal(toastDuration("info"), toastDuration("warning"))
  assert.ok(toastDuration("error") > toastDuration("info"), "errors get extra reading time")
})

test("toast placement is top-right, width-bounded, and leaves a margin", () => {
  for (const [viewWidth, expectedWidth] of [
    [80, 36],
    [100, 36],
    [120, 42],
    [160, 56],
    [240, 56],
  ] as const) {
    const placement = toastPlacement(viewWidth)
    assert.equal(placement.width, expectedWidth, `width at ${viewWidth} columns`)
    assert.equal(placement.top, 2, "toasts anchor near the top")
    assert.ok(placement.left >= 1, "the toast never touches the left edge")
    assert.equal(placement.left + placement.width, viewWidth - 2, "the toast keeps a right margin")
    assert.ok(placement.width <= 56, "the toast width is bounded on wide terminals")
  }
})

test("modal feedback uses the statusline instead of covering the dialog", () => {
  assert.equal(feedbackChannel(false), "toast")
  assert.equal(feedbackChannel(true), "statusline")
})

test("terminal init states map to app toast feedback", () => {
  assert.equal(initToast("running"), undefined)
  assert.deepEqual(initToast("succeeded"), { title: "Ensemble init", message: "Workspace init complete.", tone: "success" })
  assert.deepEqual(initToast("failed", "native /init exited 1"), {
    title: "Ensemble init",
    message: "Init failed: native /init exited 1",
    tone: "error",
  })
  assert.deepEqual(initToast("cancelled"), { title: "Ensemble init", message: "Init cancelled.", tone: "warning" })
  assert.deepEqual(initToast("interrupted"), { title: "Ensemble init", message: "Init interrupted; rerun /init.", tone: "warning" })
})
