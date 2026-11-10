import test from "node:test"
import assert from "node:assert/strict"
import { assignPeerTurnBudget, parseSafeMentions, PEER_TURN_BUDGET, planMentionRouting, sanitizeMentionText } from "./mention-routing.ts"
import type { MentionConversation, MentionRosterEntry } from "./mention-routing.ts"

test("sanitizer masks fenced code blocks and keeps prose around them", () => {
  const cases = [
    {
      name: "backtick fence",
      text: "$Nova\n```ts\n$Sage\n```\n$Echo",
      live: ["$Nova", "$Echo"],
      excluded: "fenced-code" as const,
    },
    {
      name: "tilde fence",
      text: "$Nova\n~~~\n$Sage\n~~~\n$Echo",
      live: ["$Nova", "$Echo"],
      excluded: "fenced-code" as const,
    },
    {
      name: "indented fence",
      text: "$Nova\n   ```\n$Sage\n   ```\n$Echo",
      live: ["$Nova", "$Echo"],
      excluded: "fenced-code" as const,
    },
    {
      name: "unclosed fence masks to the end",
      text: "$Nova\n```\n$Sage",
      live: ["$Nova"],
      excluded: "fenced-code" as const,
    },
  ]

  for (const table of cases) {
    const sanitized = sanitizeMentionText(table.text)
    assert.equal(sanitized.text.length, table.text.length, `${table.name}: offsets stay stable`)
    for (const live of table.live) assert.ok(sanitized.text.includes(live), `${table.name}: keeps ${live}`)
    assert.ok(!sanitized.text.includes("$Sage"), `${table.name}: masks the fenced mention`)
    assert.ok(sanitized.excluded.some((span) => span.kind === table.excluded), `${table.name}: reports the exclusion kind`)
  }
})

test("sanitizer masks inline code but leaves prose around it", () => {
  const cases = [
    { name: "single backticks", text: "ask `$Sage` then $Echo", live: ["$Echo"] },
    { name: "double backticks with a literal single run", text: "ask ``a ` $Sage` b`` then $Echo", live: ["$Echo"] },
    { name: "multi-line inline code", text: "ask `$Sage\nplease` then $Echo", live: ["$Echo"] },
    { name: "unmatched backtick stays literal", text: "ask ` then $Echo", live: ["$Echo"] },
  ]

  for (const table of cases) {
    const sanitized = sanitizeMentionText(table.text)
    assert.equal(sanitized.text.length, table.text.length, `${table.name}: offsets stay stable`)
    assert.ok(!sanitized.text.includes("$Sage"), `${table.name}: masks the inline mention`)
    for (const live of table.live) assert.ok(sanitized.text.includes(live), `${table.name}: keeps ${live}`)
    if (table.name !== "unmatched backtick stays literal") {
      assert.ok(sanitized.excluded.some((span) => span.kind === "inline-code"), `${table.name}: reports inline-code`)
    }
  }
})

test("sanitizer masks URLs and file paths but keeps prose mentions live", () => {
  const cases = [
    { name: "https url", text: "see https://example.com/$Sage now $Echo", live: ["$Echo"], excluded: "url" as const },
    { name: "url with query", text: "see https://example.com?a=$Sage, then $Echo", live: ["$Echo"], excluded: "url" as const },
    { name: "www url", text: "see www.example.com/$Sage then $Echo", live: ["$Echo"], excluded: "url" as const },
    { name: "bare domain path", text: "see example.com/$Sage then $Echo", live: ["$Echo"], excluded: "url" as const },
    { name: "mailto", text: "mail mailto:$Sage@example.com then $Echo", live: ["$Echo"], excluded: "url" as const },
    {
      name: "markdown destination masks only the destination",
      text: "[ask $Nova](https://example.com/$Sage) then $Echo",
      live: ["$Nova", "$Echo"],
      excluded: "url" as const,
    },
    { name: "absolute path", text: "open /repo/$Sage.ts then $Echo", live: ["$Echo"], excluded: "file-path" as const },
    { name: "home path", text: "open ~/dev/$Sage.md then $Echo", live: ["$Echo"], excluded: "file-path" as const },
    { name: "relative path", text: "open src/$Sage.ts then $Echo", live: ["$Echo"], excluded: "file-path" as const },
    { name: "dot path", text: "open ./$Sage then $Echo", live: ["$Echo"], excluded: "file-path" as const },
    { name: "parent path", text: "open ../$Sage then $Echo", live: ["$Echo"], excluded: "file-path" as const },
    { name: "windows path", text: "open C:\\repo\\$Sage.ts then $Echo", live: ["$Echo"], excluded: "file-path" as const },
    { name: "leading mention inside a path", text: "open $Sage/file.ts then $Echo", live: ["$Echo"], excluded: "file-path" as const },
    { name: "unrelated slash keeps the mention", text: "choose and/or $Echo", live: ["$Echo"], excluded: undefined },
  ]

  for (const table of cases) {
    const sanitized = sanitizeMentionText(table.text)
    assert.equal(sanitized.text.length, table.text.length, `${table.name}: offsets stay stable`)
    for (const live of table.live) assert.ok(sanitized.text.includes(live), `${table.name}: keeps ${live}`)
    if (table.excluded) {
      assert.ok(sanitized.excluded.some((span) => span.kind === table.excluded), `${table.name}: reports ${table.excluded}`)
    }
  }
})

const roster: MentionRosterEntry[] = [
  { id: "n", name: "Nova" },
  { id: "np", name: "Nova Prime" },
  { id: "n2", name: "Nova-2" },
  { id: "s", name: "Sage" },
  { id: "sj", name: "Sage Jr." },
  { id: "e", name: "Echo" },
  { id: "b", name: "Bolt (Prime)" },
]

test("mention parser recognizes names and IDs only with a live $ or ! operator", () => {
  const cases: Array<{
    name: string
    text: string
    agents: string[]
    unknown?: string[]
    operators?: Array<"$" | "!">
    sources?: Array<"name" | "id">
  }> = [
    { name: "dollar name", text: "$Sage take this", agents: ["s"] },
    { name: "legacy bang name", text: "!Sage take this", agents: ["s"], operators: ["!"] },
    { name: "bare name is a reference", text: "Sage take this", agents: [] },
    { name: "at-name is file-only", text: "@Sage take this", agents: [] },
    { name: "case-insensitive name", text: "$sAgE take this", agents: ["s"] },
    { name: "agent id", text: "$n take this", agents: ["n"], sources: ["id"] },
    { name: "agent id is case-insensitive", text: "!N take this", agents: ["n"], operators: ["!"], sources: ["id"] },
    { name: "punctuation around mentions", text: '($Sage), "$Echo".', agents: ["s", "e"] },
    { name: "possessive punctuation", text: "$Sage's turn", agents: ["s"] },
    { name: "sentence period is punctuation", text: "ask $Sage.", agents: ["s"] },
    { name: "dot continuation is not a boundary", text: "$Sage.com ships", agents: [], unknown: ["$Sage.com"] },
    { name: "overlapping names choose the longest", text: "$Nova Prime and $Nova", agents: ["np", "n"] },
    { name: "hyphenated name wins over its prefix", text: "$Nova-2 ships", agents: ["n2"] },
    { name: "punctuated roster name", text: "$Sage Jr. please", agents: ["sj"] },
    { name: "paren roster name", text: "$Bolt (Prime) please", agents: ["b"] },
    { name: "partial name is unknown", text: "$NovaPrime ships", agents: [], unknown: ["$NovaPrime"] },
    { name: "word continuation is not a boundary", text: "$SageX ships", agents: [], unknown: ["$SageX"] },
    { name: "underscore continuation is not a boundary", text: "$Sage_ ships", agents: [], unknown: ["$Sage_"] },
    { name: "digit continuation is not a boundary", text: "$Sage2 ships", agents: [], unknown: ["$Sage2"] },
    { name: "left word boundary is required", text: "foo$Sage ships", agents: [] },
    { name: "double operator is not a mention", text: "$$Sage ships", agents: [] },
    { name: "money is not an unknown reference", text: "it costs $5 today", agents: [] },
    { name: "environment variables are ignored", text: "$HOME and $PATH and $API_KEY", agents: [] },
    { name: "lowercase unknown is reported", text: "$ghost take a look", agents: [], unknown: ["$ghost"] },
    { name: "bang unknown keeps its operator", text: "!Ghost take a look", agents: [], unknown: ["!Ghost"] },
    { name: "unknown punctuation is trimmed", text: "$Ghost, take a look", agents: [], unknown: ["$Ghost"] },
    { name: "unknown duplicates collapse", text: "$Ghost $Ghost $Ghost", agents: [], unknown: ["$Ghost"] },
    {
      name: "prose around a fenced code block still routes",
      text: "$Sage\n```ts\n$Echo\n```\nopen src/$Bolt.ts then $Nova",
      agents: ["s", "n"],
    },
    { name: "url contents never route", text: "$Sage see https://example.com/$Echo then $Nova", agents: ["s", "n"] },
    { name: "inline code contents never route", text: "$Sage and `$Echo` and $Nova", agents: ["s", "n"] },
  ]

  for (const table of cases) {
    const parsed = parseSafeMentions(table.text, roster)
    assert.deepEqual(parsed.mentions.map((mention) => mention.agentID), table.agents, `${table.name}: recipients`)
    if (table.operators) {
      assert.deepEqual(parsed.mentions.map((mention) => mention.operator), table.operators, `${table.name}: operators`)
    }
    if (table.sources) {
      assert.deepEqual(parsed.mentions.map((mention) => mention.source), table.sources, `${table.name}: sources`)
    }
    if (table.unknown) {
      assert.deepEqual(parsed.unknown.map((mention) => `${mention.operator}${mention.token}`), table.unknown, `${table.name}: unknown`)
    } else {
      assert.deepEqual(parsed.unknown, [], `${table.name}: no unknown`)
    }
  }
})

test("mention parser honors escaped operators and reports original offsets", () => {
  const cases = [
    { name: "escaped dollar", text: "\\$Sage and $Echo", agents: ["e"] },
    { name: "escaped bang", text: "\\!Sage and $Echo", agents: ["e"] },
    { name: "even backslashes leave the operator live", text: "\\\\$Sage", agents: ["s"] },
    { name: "escaped unknown is not reported", text: "\\$Ghost and $Echo", agents: ["e"] },
  ]

  for (const table of cases) {
    const parsed = parseSafeMentions(table.text, roster)
    assert.deepEqual(parsed.mentions.map((mention) => mention.agentID), table.agents, table.name)
    if (table.name === "escaped unknown is not reported") assert.deepEqual(parsed.unknown, [], table.name)
  }

  const parsed = parseSafeMentions("say $Sage, then $Echo.", roster)
  const [sage, echo] = parsed.mentions
  assert.equal("say $Sage, then $Echo.".slice(sage.start, sage.end), "$Sage")
  assert.equal("say $Sage, then $Echo.".slice(echo.start, echo.end), "$Echo")
})

const policyRoster: MentionRosterEntry[] = [
  { id: "n", name: "Nova", member: true },
  { id: "s", name: "Sage", member: true },
  { id: "e", name: "Echo", member: true },
  { id: "b", name: "Bolt", member: true },
  { id: "a", name: "Archived", member: true, archived: true },
  { id: "o", name: "Outside", member: false },
]
const groupConversation: MentionConversation = { kind: "group", workspaceID: "w", sessionAgentID: "n" }

test("routing policy suppresses self and duplicate recipients", () => {
  const cases: Array<{
    name: string
    text: string
    routes: string[]
    suppressed: Array<[string, string]>
    refusals: string[]
  }> = [
    { name: "legacy bang routes like dollar", text: "!Sage take this", routes: ["s"], suppressed: [], refusals: [] },
    { name: "single peer", text: "$Sage take this", routes: ["s"], suppressed: [], refusals: [] },
    { name: "implicit addressee needs no mention", text: "take this", routes: [], suppressed: [], refusals: [] },
    { name: "self mention is suppressed", text: "$Nova $Sage take this", routes: ["s"], suppressed: [["n", "self"]], refusals: [] },
    {
      name: "duplicate recipients collapse",
      text: "$Sage $Sage $Echo take this",
      routes: ["s", "e"],
      suppressed: [["s", "duplicate"]],
      refusals: [],
    },
    {
      name: "name and id resolve to one recipient",
      text: "$Sage $s take this",
      routes: ["s"],
      suppressed: [["s", "duplicate"]],
      refusals: [],
    },
    {
      name: "self duplicate removes both occurrences",
      text: "$Nova $Nova $Sage",
      routes: ["s"],
      suppressed: [["n", "self"], ["n", "duplicate"]],
      refusals: [],
    },
  ]

  for (const table of cases) {
    const plan = planMentionRouting({
      text: table.text,
      conversation: groupConversation,
      roster: policyRoster,
      fanOutCap: 8,
    })
    assert.deepEqual(plan.routes.map((route) => route.agentID), table.routes, `${table.name}: routes`)
    assert.deepEqual(plan.suppressed.map((item) => [item.agentID, item.reason]), table.suppressed, `${table.name}: suppressed`)
    assert.deepEqual(plan.refusals.map((item) => item.reason), table.refusals, `${table.name}: refusals`)
  }
})

test("routing policy refuses unknown, archived, outside, and over-cap recipients visibly", () => {
  const cases: Array<{
    name: string
    text: string
    fanOutCap: number
    routes: string[]
    refusals: Array<[string, string]>
  }> = [
    { name: "archived member", text: "$Archived $Sage", fanOutCap: 8, routes: ["s"], refusals: [["Archived", "archived"]] },
    { name: "outside roster", text: "$Outside $Sage", fanOutCap: 8, routes: ["s"], refusals: [["Outside", "not-a-member"]] },
    { name: "unknown name", text: "$Ghost $Sage", fanOutCap: 8, routes: ["s"], refusals: [["Ghost", "unknown"]] },
    {
      name: "per-message fan-out cap",
      text: "$Sage $Echo $Bolt",
      fanOutCap: 2,
      routes: ["s", "e"],
      refusals: [["Bolt", "fan-out"]],
    },
    { name: "zero cap still admits one", text: "$Sage $Echo", fanOutCap: 0, routes: ["s"], refusals: [["Echo", "fan-out"]] },
    { name: "negative cap still admits one", text: "$Sage $Echo", fanOutCap: -3, routes: ["s"], refusals: [["Echo", "fan-out"]] },
  ]

  for (const table of cases) {
    const plan = planMentionRouting({
      text: table.text,
      conversation: groupConversation,
      roster: policyRoster,
      fanOutCap: table.fanOutCap,
    })
    assert.deepEqual(plan.routes.map((route) => route.agentID), table.routes, `${table.name}: routes`)
    assert.deepEqual(
      plan.refusals.map((item) => [item.agentName ?? item.token.replace(/^[$!]/, ""), item.reason]),
      table.refusals,
      `${table.name}: refusals`,
    )
  }
})

test("routing policy keeps direct conversations one-to-one and honors the kill switch", () => {
  const direct: MentionConversation = { kind: "direct", agentID: "n", workspaceID: "w" }
  const directPlan = planMentionRouting({ text: "$Sage and $Ghost", conversation: direct, roster: policyRoster, fanOutCap: 8 })
  assert.deepEqual(directPlan.routes, [])
  assert.deepEqual(directPlan.refusals.map((item) => item.reason), ["direct-conversation", "unknown"])
  assert.equal(directPlan.addressee, "n")

  const offPlan = planMentionRouting({
    text: "$Sage $Ghost",
    conversation: groupConversation,
    roster: policyRoster,
    fanOutCap: 8,
    enabled: false,
  })
  assert.deepEqual(offPlan.routes, [])
  assert.deepEqual(offPlan.refusals.map((item) => item.reason), ["routing-disabled", "unknown"])
})

test("routing policy suppresses an immediate reply-to-sender and refuses a group cycle", () => {
  const plan = planMentionRouting({
    text: "$Sage $Echo $Nova",
    conversation: groupConversation,
    roster: policyRoster,
    fanOutCap: 8,
    replyToSenderID: "s",
    groupTrail: ["e"],
  })
  assert.deepEqual(plan.routes.map((route) => route.agentID), [], "every candidate is guarded")
  assert.deepEqual(plan.suppressed.map((item) => [item.agentID, item.reason]), [
    ["s", "reply-to-sender"],
    ["n", "self"],
  ])
  assert.deepEqual(plan.refusals.map((item) => [item.agentID, item.reason]), [["e", "cycle"]])

  const allowed = planMentionRouting({
    text: "$Echo",
    conversation: groupConversation,
    roster: policyRoster,
    fanOutCap: 8,
    replyToSenderID: "s",
    groupTrail: ["s"],
  })
  assert.deepEqual(allowed.routes.map((route) => route.agentID), ["e"])
})

test("routing policy preflights the ledger before any route is admitted", () => {
  const cases: Array<{
    name: string
    ledger: { groupUsed: number; groupMax: number; depth: number; depthMax: number; commandUsed?: number; commandMax?: number; closed?: boolean }
    layer: string
  }> = [
    { name: "closed group", ledger: { groupUsed: 1, groupMax: 8, depth: 1, depthMax: 8, closed: true }, layer: "closed" },
    { name: "group hops", ledger: { groupUsed: 8, groupMax: 8, depth: 1, depthMax: 8 }, layer: "group" },
    { name: "depth", ledger: { groupUsed: 1, groupMax: 8, depth: 9, depthMax: 8 }, layer: "depth" },
    { name: "command", ledger: { groupUsed: 1, groupMax: 8, depth: 1, depthMax: 8, commandUsed: 24, commandMax: 24 }, layer: "command" },
  ]

  for (const table of cases) {
    const plan = planMentionRouting({
      text: "$Sage $Echo",
      conversation: groupConversation,
      roster: policyRoster,
      fanOutCap: 8,
      ledger: table.ledger,
    })
    assert.deepEqual(plan.routes, [], `${table.name}: no work`)
    assert.deepEqual(plan.refusals.map((item) => item.reason), ["budget", "budget"], `${table.name}: one refusal per recipient`)
    assert.deepEqual(plan.refusals.map((item) => item.layer), [table.layer, table.layer], `${table.name}: layer`)
  }

  const open = planMentionRouting({
    text: "$Sage",
    conversation: groupConversation,
    roster: policyRoster,
    fanOutCap: 8,
    ledger: { groupUsed: 7, groupMax: 8, depth: 1, depthMax: 8, commandUsed: 23, commandMax: 24 },
  })
  assert.deepEqual(open.routes.map((route) => route.agentID), ["s"], "the last hop and exact depth are allowed")
})

test("server budget assignment is deterministic and never exceeds the ledger", () => {
  const cases: Array<{ name: string; groupRemaining: number; commandRemaining?: number; expected: number }> = [
    { name: "group is the binding layer", groupRemaining: 8, commandRemaining: 24, expected: 8 },
    { name: "group remaining", groupRemaining: 2, commandRemaining: 24, expected: 2 },
    { name: "command is the binding layer", groupRemaining: 8, commandRemaining: 3, expected: 3 },
    { name: "exhausted command", groupRemaining: 8, commandRemaining: 0, expected: 0 },
    { name: "no command ledger", groupRemaining: 5, expected: 5 },
    { name: "exhausted", groupRemaining: 0, commandRemaining: 24, expected: 0 },
    { name: "negative clamps to zero", groupRemaining: -4, commandRemaining: -2, expected: 0 },
    { name: "fractional values truncate", groupRemaining: 3.9, commandRemaining: 2.1, expected: 2 },
    { name: "not a number clamps to zero", groupRemaining: Number.NaN, expected: 0 },
  ]

  for (const table of cases) {
    const assigned = assignPeerTurnBudget({
      groupRemaining: table.groupRemaining,
      commandRemaining: table.commandRemaining,
    })
    assert.equal(assigned.delegationTaskMaxHops, table.expected, table.name)
    assert.deepEqual(assigned.route, PEER_TURN_BUDGET, `${table.name}: a peer turn consumes no hop and carries no task budget`)
  }
})

test("routing plan exposes the turn budget for workspace and home-direct conversations", () => {
  const groupPlan = planMentionRouting({ text: "$Sage", conversation: groupConversation, roster: policyRoster, fanOutCap: 8 })
  assert.equal(groupPlan.budget.kind, "workspace")
  assert.deepEqual(groupPlan.routes[0].budget, PEER_TURN_BUDGET)
  if (groupPlan.budget.kind === "workspace") {
    assert.equal(groupPlan.budget.groupRemaining, 8)
    assert.equal(groupPlan.budget.commandRemaining, 24)
    assert.equal(groupPlan.budget.delegationTaskMaxHops, 8)
  }

  const workspaceDirect = planMentionRouting({
    text: "hello",
    conversation: { kind: "direct", agentID: "n", workspaceID: "w" },
    roster: policyRoster,
    fanOutCap: 8,
  })
  assert.equal(workspaceDirect.budget.kind, "workspace")

  const homeDirect = planMentionRouting({
    text: "hello",
    conversation: { kind: "direct", agentID: "n" },
    roster: policyRoster,
    fanOutCap: 8,
  })
  assert.equal(homeDirect.budget.kind, "none")
})
