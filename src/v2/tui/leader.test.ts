import test from "node:test"
import assert from "node:assert/strict"
import { LEADER_POPUP_DELAY_MS, leaderPopupVisible } from "./leader.ts"
import { resolveLeaderKey } from "./keymap.ts"

test("the which-key popup waits a short beat after the leader key", () => {
  assert.equal(leaderPopupVisible(null, 1_000), false)
  assert.equal(leaderPopupVisible(1_000, 1_000), false)
  assert.equal(leaderPopupVisible(1_000, 1_000 + LEADER_POPUP_DELAY_MS - 1), false)
  assert.equal(leaderPopupVisible(1_000, 1_000 + LEADER_POPUP_DELAY_MS), true)
  assert.equal(leaderPopupVisible(1_000, 2_000, 0), true, "a zero delay reveals immediately")
})

test("the leader catalog remains immediately actionable while the popup waits", () => {
  // The delay is presentation-only: resolution never consults the timer, so
  // Space q acts on the first keypress even though the menu is still hidden.
  assert.equal(LEADER_POPUP_DELAY_MS > 0, true)
  assert.equal(leaderPopupVisible(1_000, 1_050), false)
  assert.equal(resolveLeaderKey("q").type, "action")
  assert.equal(resolveLeaderKey("?").type, "action")
})
