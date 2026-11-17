import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  evaluateDocsRationale,
  extractDocsRationale,
} from "../../scripts/lib/docs-rationale.ts"
import { checkDocsRationaleWorkflow } from "./ci-workflows.ts"

const repoRoot = fileURLToPath(new URL("../..", import.meta.url))

function workflow(): string {
  return readFileSync(join(repoRoot, ".github/workflows/docs-rationale.yml"), "utf8")
}

test("a user-visible source change passes when the PR updates docs", () => {
  const result = evaluateDocsRationale(
    ["src/v2/service.ts", "docs/reference/tools.md"],
    "Documents the new service behavior.",
  )
  assert.equal(result.ok, true)
  assert.equal(result.docsUpdated, true)
  assert.equal(result.requiresDocs, true)
})

test("a user-visible source change passes with an explicit docs-not-needed rationale", () => {
  const result = evaluateDocsRationale(
    ["src/v2/service.ts"],
    "## Summary\n\nInternal only.\n\nDocs-not-needed: Refactor preserves the documented service behavior.",
  )
  assert.equal(result.ok, true)
  assert.equal(result.rationale, "Refactor preserves the documented service behavior.")
})

test("a user-visible source change without docs or a rationale fails", () => {
  const result = evaluateDocsRationale(["src/v2/service.ts"], "Internal change.")
  assert.equal(result.ok, false)
  assert.match(result.message, /docs-not-needed/)
})

test("an empty docs-not-needed rationale does not pass", () => {
  const result = evaluateDocsRationale(["src/v2/service.ts"], "Docs-not-needed:   ")
  assert.equal(result.ok, false)
})

test("test-only changes are exempt as a documented test exception", () => {
  const result = evaluateDocsRationale(["src/v2/service.test.ts"], "")
  assert.equal(result.ok, true)
  assert.equal(result.requiresDocs, false)
  assert.match(result.message, /test-only/)
})

test("docs-only changes satisfy the guard without a rationale", () => {
  const result = evaluateDocsRationale(["README.md", "docs/style-guide.md"], "")
  assert.equal(result.ok, true)
  assert.equal(result.docsUpdated, true)
})

test("workflow and tooling changes that do not ship behavior are exempt", () => {
  const result = evaluateDocsRationale([".github/workflows/docs.yml", "scripts/docs-check.mjs"], "")
  assert.equal(result.ok, true)
  assert.equal(result.requiresDocs, false)
})

test("the docs-not-needed marker is case-insensitive and may be a bullet", () => {
  assert.equal(
    extractDocsRationale("- Docs-Not-Needed: Covered by the existing quickstart."),
    "Covered by the existing quickstart.",
  )
})

test("the PR guard runs from pull_request_target with read-only permissions and no PR checkout", () => {
  assert.deepEqual(checkDocsRationaleWorkflow(workflow()), [])
})

test("the PR guard rejects a pull_request trigger", () => {
  const failures = checkDocsRationaleWorkflow(workflow().replace("  pull_request_target:", "  pull_request:"))
  assert.ok(failures.some((failure) => /pull_request_target/.test(failure)), failures.join("\n"))
})

test("the PR guard rejects write permissions and secret access", () => {
  const write = workflow().replace("  pull-requests: read", "  pull-requests: write")
  assert.ok(checkDocsRationaleWorkflow(write).some((failure) => /read-only|write/.test(failure)))

  const secret = workflow().replace(
    "          PR_BODY: ${{ github.event.pull_request.body }}",
    "          PR_BODY: ${{ github.event.pull_request.body }}\n          TOKEN: ${{ secrets.NPM_TOKEN }}",
  )
  assert.ok(checkDocsRationaleWorkflow(secret).some((failure) => /secret/.test(failure)))
})

test("the PR guard rejects checking out the pull request head", () => {
  const headCheckout = workflow().replace(
    "ref: ${{ github.event.pull_request.base.sha }}",
    "ref: ${{ github.event.pull_request.head.sha }}",
  )
  assert.ok(
    checkDocsRationaleWorkflow(headCheckout).some((failure) => /head|base/.test(failure)),
    checkDocsRationaleWorkflow(headCheckout).join("\n"),
  )
})
