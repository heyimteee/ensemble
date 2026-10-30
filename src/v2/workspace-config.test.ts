import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ensureEnsembleDirectory, readInitMetadata, readWorkspaceConfig, stripEnsembleBlock, writeAgentsBlock, writeHandoff, writeInitMetadata, writeWorkspaceConfig } from "./workspace-config.ts"
import type { Agent, Workspace } from "./types.ts"

const agent = (id: string, name: string): Agent => ({
  id, name, title: "", role: "", mainModel: { providerID: "p", modelID: "m" },
  backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1,
})
const workspace = (directory: string): Workspace => ({
  id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a", "b"], synthesis: true,
  archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1,
})

test("workspace config round-trips and .ensemble is gitignored", () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-config-"))
  ensureEnsembleDirectory(directory)
  writeWorkspaceConfig(workspace(directory), { a: agent("a", "Nova"), b: agent("b", "Sage") })
  const config = readWorkspaceConfig(directory)
  assert.equal(config?.name, "site")
  assert.equal(config?.leader, "Nova")
  assert.deepEqual(config?.members, ["Nova", "Sage"])
  assert.match(readFileSync(join(directory, ".gitignore"), "utf8"), /\.ensemble\//)
})

test("AGENTS.md block is inserted at the top and replaced without duplication", () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-agents-"))
  writeFileSync(join(directory, "AGENTS.md"), "# Existing\n\nKeep me.\n")
  writeAgentsBlock(directory, "<!-- ensemble:start v1 -->\nNEW\n<!-- ensemble:end -->")
  let content = readFileSync(join(directory, "AGENTS.md"), "utf8")
  assert.ok(content.startsWith("<!-- ensemble:start v1 -->"))
  assert.ok(content.includes("# Existing"))
  writeAgentsBlock(directory, "<!-- ensemble:start v2 -->\nUPDATED\n<!-- ensemble:end -->")
  content = readFileSync(join(directory, "AGENTS.md"), "utf8")
  assert.equal((content.match(/ensemble:start/g) ?? []).length, 1)
  assert.ok(content.includes("UPDATED"))
  assert.equal(stripEnsembleBlock(content).trim(), "# Existing\n\nKeep me.")
})

test("init metadata is readable", () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-init-"))
  writeInitMetadata(directory, 3)
  const value = JSON.parse(readFileSync(join(directory, ".ensemble", "init.json"), "utf8"))
  assert.equal(value.version, 3)
})


test("invalid or wrong-version config is ignored", () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-config-"))
  mkdirSync(join(directory, ".ensemble"), { recursive: true })
  writeFileSync(join(directory, ".ensemble", "config.json"), "{oops")
  assert.equal(readWorkspaceConfig(directory), undefined)
  writeFileSync(join(directory, ".ensemble", "config.json"), JSON.stringify({ version: 99, name: "x", leader: "a", members: ["a"] }))
  assert.equal(readWorkspaceConfig(directory), undefined)
  writeFileSync(join(directory, ".ensemble", "init.json"), "{oops")
  assert.deepEqual(readInitMetadata(directory), {})
})

test("handoff files are written under .ensemble/handoffs", () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-handoff-"))
  const path = writeHandoff(directory, "task-nova-sage-1.md", "---\nensemble: handoff\n---\n# Handoff\n")
  assert.ok(path.endsWith("task-nova-sage-1.md"))
  assert.match(readFileSync(path, "utf8"), /ensemble: handoff/)
})
