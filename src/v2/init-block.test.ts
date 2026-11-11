import test from "node:test"
import assert from "node:assert/strict"
import { ENSEMBLE_BLOCK_VERSION, ensembleBlock, initInstruction, initInstructions, onboardingPrompt, teamRosterTable } from "./init-block.ts"

const roster = {
  leaderID: "a",
  memberIDs: ["a", "b", "c"],
  agents: {
    a: { name: "Nova", title: "Lead | Engineer", role: "You own architecture.\nSecond line." },
    b: { name: "Sage", title: "", role: "You own research." },
    c: { name: "Echo", title: "Analyst", role: "You own QA.\n\nYou sign off releases." },
    d: { name: "Iris", title: "Archived", role: "You are no longer active.", archived: true },
  },
}

test("agent onboarding includes the persona and the full Ensemble contract", () => {
  const prompt = onboardingPrompt({ name: "Nova", title: "Frontend Engineer", role: "You own the React frontend." })
  assert.match(prompt, /You are Nova, Frontend Engineer\./)
  assert.match(prompt, /You own the React frontend\./)
  assert.match(prompt, /You are one member of an Ensemble team/)
  assert.ok(prompt.includes(ensembleBlock()))
  assert.ok(prompt.includes("ensemble_handoff"))
  assert.match(prompt, /\$Name/)
  assert.match(prompt, /@.*file reference/)
  assert.match(prompt, /ensemble_delegate/)
  assert.match(prompt, /maxHops/)
  assert.match(prompt, /maxHops: 0/)
  assert.match(prompt, /Task/i)
  assert.match(prompt, /Group/i)
  assert.match(prompt, /Command/i)
  assert.match(prompt, /Depth/i)
  assert.match(prompt, /cannot raise a ceiling/i)
  assert.match(prompt, /continuationOf/)
  assert.match(prompt, /groupMaxHops/)
  assert.match(prompt, /new command/)
  assert.match(prompt, new RegExp(`ensemble:start v${ENSEMBLE_BLOCK_VERSION}`))
})

test("ticket238: v6 contract describes native-first rules and retires the mandatory handoff", () => {
  const block = ensembleBlock()
  // External contract: the rendered marker names version 6. Other version
  // checks in this file derive from ENSEMBLE_BLOCK_VERSION.
  assert.match(block, /ensemble:start v6/)
  assert.match(block, /final native text is the group message/i)
  assert.match(block, /\$Name.*routes work/is)
  assert.match(block, /bare name is a reference only/i)
  assert.match(block, /`@path` is a workspace file reference/i)
  assert.match(block, /Code spans, URLs, and paths are literal/)
  assert.match(block, /Direct conversations are one-to-one/)
  assert.match(block, /The server owns routing, budgets, and completion/)
  assert.match(block, /synthesis or review turn is terminal/i)
  assert.match(block, /ensemble_dispatch/)
  assert.match(block, /terminal continuation/i)
  assert.match(block, /until their turn is\s+visible in the conversation/i)
  assert.match(block, /second completion loop/i)
  assert.match(block, /migration and\s+rollback tools, not the normal chat path/i)
  assert.doesNotMatch(block, /Every non-leader turn ends with a handoff/i)
  assert.doesNotMatch(block, /^## Team roster$/m, "the generic identity block carries no roster")
})

test("ticket238: team roster lists the active leader first, then memberIDs order", () => {
  const table = teamRosterTable(roster)
  const lines = table.split("\n")
  assert.equal(lines[0], "| Member | Title | Role |")
  assert.equal(lines[1], "|---|---|---|")
  assert.equal(lines[2], "| **Nova** (leader) | Lead \\| Engineer | You own architecture.<br>Second line. |")
  assert.equal(lines[3], "| Sage |  | You own research. |")
  assert.equal(lines[4], "| Echo | Analyst | You own QA.<br><br>You sign off releases. |")
  assert.equal(lines.length, 5)
  assert.doesNotMatch(table, /Iris/, "archived members are excluded")

  const reordered = teamRosterTable({ ...roster, leaderID: "c", memberIDs: ["a", "b", "c"] })
  const order = reordered.split("\n").slice(2).map((line) => line.split(" | ")[0])
  assert.deepEqual(order, ["| **Echo** (leader)", "| Nova", "| Sage"])
})

test("ticket238: roster keeps title and role exactly as stored, escaping only table syntax", () => {
  const table = teamRosterTable({
    leaderID: "a",
    memberIDs: ["a"],
    agents: {
      a: { name: "Nova", title: "Research | Analysis", role: "Line one | pipe.\nLine two.\r\nLine three." },
    },
  })
  assert.equal(table.split("\n")[2], "| **Nova** (leader) | Research \\| Analysis | Line one \\| pipe.<br>Line two.<br>Line three. |")
  assert.doesNotMatch(table, /\nLine two/, "newlines never break the table row")
})

test("ticket238: workspace block carries the roster table once, not in every turn block", () => {
  const block = ensembleBlock(roster)
  assert.equal((block.match(/^## Team roster$/gm) ?? []).length, 1)
  assert.ok(block.includes(teamRosterTable(roster)))
})

test("init instruction replaces an existing Ensemble block instead of duplicating", () => {
  const text = initInstruction()
  assert.match(text, /replace that block in place/)
  assert.match(text, /never add a second Ensemble block/)
  assert.match(text, /stale, duplicated, or overlapping/)
  assert.match(text, /ensemble:start/)
  assert.match(text, /ensemble:end/)
})

test("native init receives the full detailed workspace initialization instructions", () => {
  const text = initInstructions()
  assert.ok(text.includes(initInstruction()), "the replace policy is part of the full instructions")
  assert.match(text, /Inspect the repository/i)
  assert.match(text, /build, test, and lint/i)
  assert.match(text, /Preserve the project's own guidance/i)
  assert.match(text, /exactly one current Ensemble block/i)
  assert.match(text, /Do not edit \.ensemble\/init\.json/i)
  assert.match(text, /Report what you inspected/i)
})
