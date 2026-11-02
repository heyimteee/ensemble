import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

// Solid evaluates createMemo callbacks eagerly at creation, so a memo that
// calls a component-scope `const` declared below it crashes the route with a
// temporal-dead-zone error (`Cannot access 'x' before initialization`). `tsc`
// cannot catch it (use-before-declaration across statements is legal TS when
// the use sits inside a callback), and no harness test mounts the full app
// component, so this test statically pins the declaration order instead:
// every component-local identifier called inside a createMemo body must be
// declared above that memo. Regression test for the v5.4 crash where the
// `staggeringIds` memo called `motionOn()` ~840 lines before its declaration.
test("app.tsx memos only call component-scope identifiers declared above them", () => {
  const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
  const lines = source.split("\n")

  // First top-level `const`/`let` declaration line per name (signals declare
  // both halves via destructuring). Function declarations hoist, so they are
  // exempt from ordering.
  const declLine = new Map<string, number>()
  const hoisted = new Set<string>()
  lines.forEach((line, index) => {
    const fn = line.match(/^\s*function\s+([A-Za-z_$][\w$]*)/)
    if (fn) {
      hoisted.add(fn[1])
      if (!declLine.has(fn[1])) declLine.set(fn[1], index)
      return
    }
    const destructured = line.match(/^\s*(?:const|let)\s+\[([^\]]+)\]/)
    if (destructured) {
      for (const name of destructured[1].split(",")) {
        const id = name.trim().match(/^([A-Za-z_$][\w$]*)/)?.[1]
        if (id && !declLine.has(id)) declLine.set(id, index)
      }
      return
    }
    const single = line.match(/^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)/)
    if (single && !declLine.has(single[1])) declLine.set(single[1], index)
  })

  // Locate each createMemo(...) call span via paren balancing from its opening
  // paren, so multi-line memo bodies are covered in full.
  const spans: Array<{ name: string; startLine: number; body: string }> = []
  const marker = "createMemo"
  let from = 0
  while (true) {
    const at = source.indexOf(marker, from)
    if (at === -1) break
    const open = source.indexOf("(", at + marker.length)
    let depth = 0
    let pos = open
    let inString: string | null = null
    let inLineComment = false
    let inBlockComment = false
    let prev = ""
    for (; pos < source.length; pos++) {
      const ch = source[pos]
      const next = source[pos + 1]
      if (inLineComment) {
        if (ch === "\n") inLineComment = false
      } else if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false
          pos++
        }
      } else if (inString) {
        if (ch === "\\") pos++
        else if (ch === inString && prev !== "\\") inString = null
      } else if (ch === "/" && next === "/") {
        inLineComment = true
        pos++
      } else if (ch === "/" && next === "*") {
        inBlockComment = true
        pos++
      } else if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch
      } else if (ch === "(") {
        depth++
      } else if (ch === ")") {
        depth--
        if (depth === 0) break
      }
      prev = ch
    }
    const body = source.slice(open, pos + 1)
    const startLine = source.slice(0, at).split("\n").length - 1
    const declText = lines[startLine] ?? ""
    const name = declText.match(/^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)/)?.[1] ?? `anonymous@${startLine + 1}`
    spans.push({ name, startLine, body })
    from = pos + 1
  }
  assert.ok(spans.length > 0, "expected to find createMemo calls in app.tsx")

  const violations: string[] = []
  for (const span of spans) {
    const calls = span.body.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)
    const seen = new Set<string>()
    for (const call of calls) {
      const callee = call[1]
      if (seen.has(callee)) continue
      seen.add(callee)
      if (hoisted.has(callee)) continue
      const declared = declLine.get(callee)
      // Imported helpers, globals, and methods (obj.method) never appear in
      // declLine, so they are exempt by construction.
      if (declared === undefined) continue
      if (declared > span.startLine) {
        violations.push(
          `memo '${span.name}' (line ${span.startLine + 1}) calls '${callee}' declared below it (line ${declared + 1})`,
        )
      }
    }
  }
  assert.deepEqual(violations, [], `temporal-dead-zone order hazards in app.tsx:\n${violations.join("\n")}`)
})
