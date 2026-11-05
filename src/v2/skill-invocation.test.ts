import test from "node:test"
import assert from "node:assert/strict"
import { applySkillPaletteSelection, planSkillInvocation, skillPaletteAt, skillWorkTitle } from "./skill-invocation.ts"
import type { Agent, SkillOption, Workspace } from "./types.ts"

const agent = (patch: Partial<Agent> & Pick<Agent, "id" | "name">): Agent => ({
  title: "",
  role: "",
  mainModel: { providerID: "probe", modelID: "probe-model" },
  backupModels: [],
  skillbox: [],
  color: "cyan",
  archived: false,
  pendingSettings: false,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
})

const workspace = (patch: Partial<Workspace> = {}): Workspace => ({
  id: "w",
  name: "site",
  directory: "/tmp/site",
  leaderID: "nova",
  memberIDs: ["nova", "sage"],
  synthesis: true,
  archived: false,
  paused: false,
  nextSeq: 1,
  createdAt: 1,
  lastActiveAt: 1,
  ...patch,
})

const skills: SkillOption[] = [
  { id: "review", name: "Review", description: "Thorough code review" },
  { id: "deploy", name: "Deploy", description: "Ship the release" },
  { id: "notes", name: "Notes" },
]

const roster = (): Record<string, Agent> => ({
  nova: agent({ id: "nova", name: "Nova", skillbox: ["review"] }),
  sage: agent({ id: "sage", name: "Sage", skillbox: ["deploy"] }),
})

test("an assigned skill under one agent anchor resolves to that owner", () => {
  const text = "$Nova /review please check this"
  const plan = planSkillInvocation({ text, workspace: workspace(), agents: roster(), skills })
  assert.equal(plan.kind, "skills")
  assert.deepEqual(plan.errors, [])
  assert.deepEqual(plan.recipients, [
    { agentID: "nova", assignedSkills: ["review"], generalSkills: [], normal: false, triage: false },
  ])
})

test("multiple assigned skills under one anchor group into one recipient", () => {
  const agentRoster = roster()
  agentRoster.nova.skillbox = ["review", "notes"]
  const plan = planSkillInvocation({ text: "$Nova /review /notes please", workspace: workspace(), agents: agentRoster, skills })
  assert.deepEqual(plan.errors, [])
  assert.deepEqual(plan.recipients, [
    { agentID: "nova", assignedSkills: ["review", "notes"], generalSkills: [], normal: false, triage: false },
  ])
})

test("plain messages and recognized slash commands do not create skill recipients", () => {
  const plain = planSkillInvocation({ text: "$Nova please check this", workspace: workspace(), agents: roster(), skills })
  assert.equal(plain.kind, "message")
  assert.deepEqual(plain.recipients, [])
  assert.deepEqual(plain.errors, [])

  const command = planSkillInvocation({ text: "/help", workspace: workspace(), agents: roster(), skills })
  assert.equal(command.kind, "command")
  assert.deepEqual(command.errors, [])

  const init = planSkillInvocation({ text: ":init", workspace: workspace(), agents: roster(), skills })
  assert.equal(init.kind, "init")
  assert.deepEqual(init.errors, [])

  const bareSlash = planSkillInvocation({ text: "/", workspace: workspace(), agents: roster(), skills })
  assert.equal(bareSlash.kind, "message", "a lone slash is a palette trigger, not a skill")
  assert.deepEqual(bareSlash.errors, [])
})

test("invalid assigned-skill references fail atomically with specific errors", () => {
  const agents = roster()
  agents.echo = agent({ id: "echo", name: "Echo", skillbox: ["review"] })
  agents.retired = agent({ id: "retired", name: "Retired", skillbox: ["review"], archived: true })
  const cases = [
    {
      text: "$Nova /deploy check this",
      code: "skill_not_assigned",
      includes: ["/deploy", "$Sage", "Nova"],
    },
    { text: "$Nova /ghost check this", code: "unknown_skill", includes: ["/ghost"] },
    { text: "$Ghost /review check this", code: "unknown_agent", includes: ["$Ghost"] },
    { text: "$Echo /review check this", code: "not_member", includes: ["$Echo", "member"] },
    { text: "$Retired /review check this", code: "agent_archived", includes: ["$Retired", "archived"] },
    { text: "$Nova /notes check this", code: "skill_not_assigned", includes: ["/notes", "not assigned"] },
  ]
  for (const item of cases) {
    const plan = planSkillInvocation({ text: item.text, workspace: workspace(), agents, skills })
    assert.equal(plan.kind, "skills", item.text)
    assert.deepEqual(plan.recipients, [], `${item.text} must not produce a partial recipient list`)
    assert.equal(plan.errors[0]?.code, item.code, item.text)
    for (const part of item.includes) assert.ok(plan.errors[0]!.message.includes(part), `${item.text}: ${plan.errors[0]!.message}`)
  }
})

test("a message-start skill resolves only when the leader owns it", () => {
  const leaderOwned = planSkillInvocation({ text: "/review check this", workspace: workspace(), agents: roster(), skills })
  assert.deepEqual(leaderOwned.errors, [])
  assert.deepEqual(leaderOwned.recipients, [
    { agentID: "nova", assignedSkills: ["review"], generalSkills: [], normal: false, triage: false },
  ])

  const otherOwner = planSkillInvocation({ text: "/deploy check this", workspace: workspace(), agents: roster(), skills })
  assert.equal(otherOwner.errors[0]?.code, "skill_not_assigned")
  assert.ok(otherOwner.errors[0]?.message.includes("$Sage"), otherOwner.errors[0]?.message)
  assert.ok(otherOwner.errors[0]?.message.includes("mention the owner"), otherOwner.errors[0]?.message)
})

test("multiple anchors route each skill to its own agent", () => {
  const bothSkills = planSkillInvocation({ text: "$Nova /review and $Sage /deploy", workspace: workspace(), agents: roster(), skills })
  assert.deepEqual(bothSkills.errors, [])
  assert.equal(bothSkills.kind, "skills")
  assert.deepEqual(bothSkills.recipients, [
    { agentID: "nova", assignedSkills: ["review"], generalSkills: [], normal: false, triage: false },
    { agentID: "sage", assignedSkills: ["deploy"], generalSkills: [], normal: false, triage: false },
  ])
})

test("a new anchor changes the target for the following skill tokens", () => {
  const agents = roster()
  agents.nova.skillbox = ["review", "notes"]
  const plan = planSkillInvocation({ text: "!Sage /deploy and !Nova /review then !Nova /notes", workspace: workspace(), agents, skills })
  assert.deepEqual(plan.errors, [])
  assert.deepEqual(plan.recipients, [
    { agentID: "sage", assignedSkills: ["deploy"], generalSkills: [], normal: false, triage: false },
    { agentID: "nova", assignedSkills: ["review", "notes"], generalSkills: [], normal: false, triage: false },
  ])
})

test("repeated anchors for one agent group every skill into one recipient", () => {
  const agents = roster()
  agents.nova.skillbox = ["review", "notes"]
  const plan = planSkillInvocation({ text: "$Nova /review and $Sage /deploy and $Nova /notes", workspace: workspace(), agents, skills })
  assert.deepEqual(plan.errors, [])
  assert.deepEqual(plan.recipients, [
    { agentID: "nova", assignedSkills: ["review", "notes"], generalSkills: [], normal: false, triage: false },
    { agentID: "sage", assignedSkills: ["deploy"], generalSkills: [], normal: false, triage: false },
  ])
})

test("mixed normal and skill anchors keep the normal agent as a recipient", () => {
  const plan = planSkillInvocation({ text: "$Nova /review and $Sage please review too", workspace: workspace(), agents: roster(), skills })
  assert.deepEqual(plan.errors, [])
  assert.deepEqual(plan.recipients, [
    { agentID: "nova", assignedSkills: ["review"], generalSkills: [], normal: false, triage: false },
    { agentID: "sage", assignedSkills: [], generalSkills: [], normal: true, triage: false },
  ])
})

test("a normal anchor with a skill later in the message stays one skilled recipient", () => {
  const plan = planSkillInvocation({ text: "$Sage please look, and $Sage /deploy this", workspace: workspace(), agents: roster(), skills })
  assert.deepEqual(plan.errors, [])
  assert.deepEqual(plan.recipients, [
    { agentID: "sage", assignedSkills: ["deploy"], generalSkills: [], normal: false, triage: false },
  ])
})

test("the skill batch cap rejects the whole message", () => {
  const agentRoster = roster()
  agentRoster.nova.skillbox = ["review", "notes", "deploy"]
  const plan = planSkillInvocation({
    text: "$Nova /review /notes /deploy",
    workspace: workspace(),
    agents: agentRoster,
    skills,
    maxSkills: 2,
  })
  assert.deepEqual(plan.recipients, [])
  assert.equal(plan.errors[0]?.code, "skill_limit")
  assert.ok(plan.errors[0]?.message.includes("at most 2"), plan.errors[0]?.message)
})

test("the skill batch cap never exceeds eight regardless of the configured limit", () => {
  const many = Array.from({ length: 9 }, (_, index) => ({ id: `s${index}`, name: `Skill ${index}` }))
  const agentRoster = roster()
  agentRoster.nova.skillbox = many.map((skill) => skill.id)
  const plan = planSkillInvocation({
    text: `$Nova ${many.map((skill) => `/${skill.id}`).join(" ")}`,
    workspace: workspace(),
    agents: agentRoster,
    skills: many,
    maxSkills: 20,
  })
  assert.deepEqual(plan.recipients, [])
  assert.equal(plan.errors[0]?.code, "skill_limit")
  assert.ok(plan.errors[0]?.message.includes("at most 8"), plan.errors[0]?.message)
})

test("the work title names only this agent's resolved skills and the request", () => {
  const text = "$Nova /review /notes and $Sage /deploy please check"
  const plan = planSkillInvocation({
    text,
    workspace: workspace(),
    agents: { ...roster(), nova: agent({ id: "nova", name: "Nova", skillbox: ["review", "notes"] }) },
    skills,
  })
  assert.deepEqual(plan.errors, [])
  assert.equal(skillWorkTitle(text, plan.recipients[0]!), "/review /notes — $Nova /review /notes and $Sage /deploy please check")
  const normal = { agentID: "sage", assignedSkills: [], generalSkills: [], normal: true, triage: false }
  assert.equal(skillWorkTitle(text, normal), text.slice(0, 80))
})

test("message-start slash shows commands and assigned skills with flags", () => {
  const palette = skillPaletteAt({ text: "/", cursor: 1, workspace: workspace(), agents: roster(), skills })
  assert.ok(palette)
  assert.equal(palette.scope, "start")
  const command = palette.rows.find((row) => row.kind === "command" && row.id === "workspace")
  assert.ok(command)
  assert.equal(command.flag, "Command")
  assert.ok(command.label.includes("/workspace"), command.label)
  const review = palette.rows.find((row) => row.skillID === "review")
  assert.ok(review)
  assert.equal(review.flag, "Skill | Nova")
  assert.equal(review.insert, "/review ")
  const deploy = palette.rows.find((row) => row.skillID === "deploy")
  assert.ok(deploy)
  assert.equal(deploy.flag, "Skill | Sage")
  assert.equal(deploy.insert, "$Sage /deploy ")
  assert.ok(!palette.rows.some((row) => row.skillID === "notes"), "general skills are not shown in this slice")
  for (const row of palette.rows) assert.ok(!row.flag.includes("·"), `flags never use a middle dot: ${row.flag}`)
})

test("an agent-scoped slash shows only that agent's assigned skills", () => {
  const nova = skillPaletteAt({ text: "$Nova /", cursor: 7, workspace: workspace(), agents: roster(), skills })
  assert.ok(nova)
  assert.equal(nova.scope, "agent")
  assert.deepEqual(nova.rows.map((row) => row.skillID), ["review"])
  assert.ok(!nova.rows.some((row) => row.kind === "command"), "commands belong to message start only")

  const sage = skillPaletteAt({ text: "$Sage /", cursor: 7, workspace: workspace(), agents: roster(), skills })
  assert.deepEqual(sage?.rows.map((row) => row.skillID), ["deploy"])

  const echo = roster()
  echo.echo = agent({ id: "echo", name: "Echo", skillbox: ["review"] })
  const nonMember = skillPaletteAt({ text: "$Echo /", cursor: 7, workspace: workspace(), agents: echo, skills })
  assert.deepEqual(nonMember?.rows, [], "a non-member never gets a skill palette")
})

test("moving the cursor between anchors recomputes the palette", () => {
  const text = "$Nova /re and $Sage /de"
  const agents = roster()
  const onSage = skillPaletteAt({ text, cursor: text.length, workspace: workspace(), agents, skills })
  assert.deepEqual(onSage?.rows.map((row) => row.skillID), ["deploy"])

  const novaToken = text.indexOf("/re")
  const onNova = skillPaletteAt({ text, cursor: novaToken + 3, workspace: workspace(), agents, skills })
  assert.equal(onNova?.scope, "agent")
  assert.deepEqual(onNova?.rows.map((row) => row.skillID), ["review"])
})

test("every slash after one anchor keeps that agent's skill scope", () => {
  const agents = roster()
  agents.nova.skillbox = ["review", "notes"]
  const text = "$Nova /review /note"
  const palette = skillPaletteAt({ text, cursor: text.length, workspace: workspace(), agents, skills })
  assert.ok(palette)
  assert.equal(palette.scope, "agent")
  assert.equal(palette.ownerID, "nova")
  assert.deepEqual(palette.rows.map((row) => row.skillID), ["notes"])
})

test("slash completion stays scoped and leaves ordinary prose alone", () => {
  const start = skillPaletteAt({ text: "/rev", cursor: 4, workspace: workspace(), agents: roster(), skills })
  assert.deepEqual(start?.rows.map((row) => row.skillID), ["review"])

  assert.equal(skillPaletteAt({ text: "hello /review", cursor: 13, workspace: workspace(), agents: roster(), skills }), undefined)
  assert.equal(skillPaletteAt({ text: "$Nova please", cursor: 12, workspace: workspace(), agents: roster(), skills }), undefined)
  assert.equal(skillPaletteAt({ text: "$Nova /review ", cursor: 15, workspace: workspace(), agents: roster(), skills }), undefined)
})

test("selecting an assigned skill inserts the right template and keeps the request", () => {
  const leaderText = "/rev please check"
  const leaderPalette = skillPaletteAt({ text: leaderText, cursor: 4, workspace: workspace(), agents: roster(), skills })
  const leaderRow = leaderPalette!.rows.find((row) => row.skillID === "review")!
  assert.deepEqual(applySkillPaletteSelection(leaderText, leaderPalette!, leaderRow), {
    text: "/review please check",
    cursor: "/review ".length,
  })

  const ownerText = "/dep please ship"
  const ownerPalette = skillPaletteAt({ text: ownerText, cursor: 4, workspace: workspace(), agents: roster(), skills })
  const ownerRow = ownerPalette!.rows.find((row) => row.skillID === "deploy")!
  assert.deepEqual(applySkillPaletteSelection(ownerText, ownerPalette!, ownerRow), {
    text: "$Sage /deploy please ship",
    cursor: "$Sage /deploy ".length,
  })

  const anchoredText = "$Nova /rev please check"
  const anchoredPalette = skillPaletteAt({ text: anchoredText, cursor: 10, workspace: workspace(), agents: roster(), skills })
  const anchoredRow = anchoredPalette!.rows.find((row) => row.skillID === "review")!
  assert.deepEqual(applySkillPaletteSelection(anchoredText, anchoredPalette!, anchoredRow), {
    text: "$Nova /review please check",
    cursor: "$Nova /review ".length,
  })
})
