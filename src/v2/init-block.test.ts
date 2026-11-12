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

/** Collapse rendered line breaks so a copy assertion is one exact sentence. */
function prose(text: string): string {
  return text.replace(/\s+/g, " ")
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

test("ticket238: v7 contract keeps the native-first rules and retires the mandatory handoff", () => {
  const block = ensembleBlock()
  const contract = prose(block)
  // External contract: the rendered marker names version 7. Other version
  // checks in this file derive from ENSEMBLE_BLOCK_VERSION.
  assert.match(block, /ensemble:start v7/)
  assert.ok(contract.includes("final native text is the group message"))
  assert.ok(contract.includes("`$Name` routes work to that roster agent: they get a turn and answer in the group."))
  assert.ok(contract.includes("A bare name is a reference only; it creates no work."))
  assert.ok(contract.includes("`@path` is a workspace file reference, never an agent or a skill."))
  assert.ok(contract.includes("Code spans, URLs, and paths are literal"))
  assert.ok(contract.includes("Direct conversations are one-to-one"))
  assert.ok(contract.includes("The server owns routing, budgets, and completion."))
  assert.ok(contract.includes("until their turn is visible in the conversation"))
  assert.ok(contract.includes("second completion loop"))
  assert.ok(contract.includes("migration and rollback tools, not the normal chat path"))
  assert.doesNotMatch(block, /Every non-leader turn ends with a handoff/i)
  assert.doesNotMatch(block, /^## Team roster$/m, "the generic identity block carries no roster")
})

test("ticket253: v7 contract explains root-only synthesis and terminal-turn continuation", () => {
  const block = ensembleBlock()
  const contract = prose(block)
  assert.ok(contract.includes("One synthesis per command: the command root writes it."))
  assert.ok(contract.includes("Intermediate hops relay their child's result upward"))
  assert.ok(contract.includes("Synthesis, completion-review, and batch-review turns are terminal."))
  assert.ok(contract.includes("In a terminal turn `$Name` is only a reference"))
  assert.ok(
    contract.includes(
      "`ensemble_dispatch` from a terminal turn with a title, an instruction, and an assignment batch. It creates a new command root with a fresh group and command budget",
    ),
  )
  assert.ok(contract.includes("One terminal turn starts at most one new command"))
  assert.ok(contract.includes("a retry returns the existing command and assignments"))
  assert.ok(
    contract.includes(
      "Normal worker, handoff, and peer turns are not terminal: `$Name` there routes work to a different teammate as usual.",
    ),
  )
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
