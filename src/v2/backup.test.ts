import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_ROLLBACK_KEY,
  BackupError,
  applyBackup,
  collectBackup,
  readRollbackStatus,
  rollbackBackup,
  sealBackup,
  validateBackup,
  type BackupStorage,
} from "./backup.ts"
import { workspaceConfigPath, writeWorkspaceConfigValue } from "./workspace-config.ts"
import { V2Store } from "./store.ts"
import type { Agent, Workspace } from "./types.ts"

const header = { protocol: 4, contractVersion: 7 }

function memoryStorage(seed: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(seed).map(([key, value]) => [key, structuredClone(value)]))
  const storage: BackupStorage = {
    get: async (key) => structuredClone(values.get(key)),
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    remove: async (key) => { values.delete(key) },
    scan: async ({ prefix, after, limit }) => {
      const entries = [...values.entries()]
        .filter(([key]) => key.startsWith(prefix) && (!after || key > after))
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, limit ?? 500)
        .map(([key, value]) => ({ key, value: structuredClone(value) }))
      const page = entries.length === (limit ?? 500) ? entries.at(-1)?.key : undefined
      return { entries, next: page }
    },
  }
  return { values, storage }
}

const agent = (id: string, name: string): Agent => ({
  id,
  name,
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
})

const workspace = (id: string, directory: string, memberIDs: string[] = ["a"]): Workspace => ({
  id,
  name: `team-${id}`,
  directory,
  leaderID: memberIDs[0] ?? "a",
  memberIDs,
  synthesis: true,
  archived: false,
  paused: false,
  configVersion: 1,
  nextSeq: 1,
  createdAt: 1,
  lastActiveAt: 1,
})

function seed(snapshot: {
  agents?: Agent[]
  workspaces?: Workspace[]
  entries?: Record<string, unknown>
  meta?: Record<string, unknown>
}): Record<string, unknown> {
  const values: Record<string, unknown> = { ...(snapshot.entries ?? {}) }
  for (const item of snapshot.agents ?? []) values[`v2/agent/${item.id}`] = item
  for (const item of snapshot.workspaces ?? []) values[`v2/workspace/${item.id}`] = item
  values["v2/meta"] = {
    version: 7,
    updatedAt: 7,
    settings: { nativeFirst: "on", synthesis: true },
    ui: { activeWorkspaceID: "w" },
    ...(snapshot.meta ?? {}),
  }
  return values
}

function tempDirectory(name: string): string {
  return mkdtempSync(join(tmpdir(), `ensemble-backup-${name}-`))
}

function writeConfig(directory: string, id: string, name: string, leader: string, members: string[]): void {
  writeWorkspaceConfigValue(directory, {
    version: 1,
    id,
    name,
    leader,
    members,
    synthesis: true,
    paused: false,
  })
}

test("ticket273: export captures durable state and workspace config without duplicating paths", async () => {
  const directory = tempDirectory("export")
  const second = tempDirectory("export-empty")
  try {
    writeConfig(directory, "w", "site", "Nova", ["Nova", "Sage"])
    writeFileSync(join(directory, ".ensemble", "init.json"), JSON.stringify({ version: 7, installedAt: 11 }))
    const { storage } = memoryStorage(seed({
      agents: [agent("a", "Nova"), agent("b", "Sage")],
      workspaces: [workspace("w", directory, ["a", "b"]), workspace("x", second)],
      entries: {
        "v2/message/w/00000001": { id: "m1", workspaceID: "w", seq: 1, createdAt: 1 },
        "v2/subtask/t": { id: "t", workspaceID: "w", createdAt: 1 },
        "v2/dispatchgroup/g": { id: "g", workspaceID: "w", rootID: "g", maxHops: 2, usedHops: 0, depthMax: 2, createdAt: 1 },
        "v2/init/i": { id: "i", workspaceID: "w", messageID: "m1", state: "succeeded", startedAt: 1 },
        "v2/native-subagent/c": { childSessionID: "c", parentSessionID: "s", state: "replied", source: "session-created" },
        "v2/binding/w/a": { workspaceID: "w", agentID: "a", sessionID: "s", agentVersion: 1 },
        "v2/memory/mem": { id: "mem", scope: "project", text: "note", source: "manual", createdAt: 1, updatedAt: 1, history: [] },
        "v2/approval/ap": { id: "ap", kind: "ask_person", title: "Question", detail: "Details", status: "pending", createdAt: 1 },
        "v2/dmqueue/q": { id: "q", agentID: "a", text: "queued", status: "queued", createdAt: 1 },
        "v2/dm/w/a/1": { id: "legacy", role: "user", author: "User", text: "old line", createdAt: 1 },
      },
    }))
    const backup = await collectBackup(storage, { ...header, now: 1_000 })
    assert.equal(backup.format, BACKUP_FORMAT)
    assert.equal(backup.formatVersion, BACKUP_FORMAT_VERSION)
    assert.equal(backup.createdAt, 1_000)
    assert.equal(backup.counts.agents, 2)
    assert.equal(backup.counts.workspaces, 2)
    for (const name of ["messages", "subtasks", "dispatchGroups", "initJobs", "nativeSubagents", "bindings", "memories", "approvals", "dmQueue", "legacyDirect"]) {
      assert.equal(backup.counts[name], 1, name)
    }
    assert.equal(backup.payload.meta?.settings.nativeFirst, "on")
    const captured = backup.payload.workspaceConfigs.find((item) => item.workspaceID === "w")
    assert.equal(captured?.config?.name, "site")
    assert.equal(captured?.config?.leader, "Nova")
    assert.deepEqual(captured?.init, { version: 7, installedAt: 11 })
    // The document carries the workspace ID join key, never a filesystem path.
    assert.equal(JSON.stringify(backup.payload.workspaceConfigs).includes(directory), false)
    assert.equal(backup.payload.workspaceConfigs.find((item) => item.workspaceID === "x")?.config, undefined)
    assert.equal(validateBackup(backup).digest, backup.digest)
  } finally {
    rmSync(directory, { recursive: true, force: true })
    rmSync(second, { recursive: true, force: true })
  }
})

test("ticket273: restore replaces state, restores workspace config, and advances the version", async () => {
  const source = tempDirectory("source")
  const target = tempDirectory("target")
  try {
    writeConfig(source, "w", "site", "Nova", ["Nova"])
    const origin = memoryStorage(seed({ agents: [agent("a", "Nova")], workspaces: [workspace("w", source)] }))
    const backup = await collectBackup(origin.storage, { ...header, now: 2_000 })

    const empty = memoryStorage({
      "v2/agent/stale": agent("stale", "Old"),
      "ensemble.state": { agents: { stale: { id: "stale", name: "Old" } } },
    })
    const report = await applyBackup(empty.storage, backup, { ...header, versionFloor: 40, now: 3_000 })
    assert.equal(report.version, 41)
    assert.equal(report.workspaces.restored, 1)
    const state = await collectBackup(empty.storage, { ...header, now: 4_000 })
    assert.equal(state.payload.meta?.version, 41)
    // A pre-v2 migration source the backup does not contain cannot re-add agents.
    assert.equal(empty.values.has("ensemble.state"), false)
    assert.equal(state.payload.meta?.settings.nativeFirst, "on")
    assert.deepEqual(state.payload.entries.map((entry) => entry.key), ["v2/agent/a", "v2/workspace/w"])
    const config = JSON.parse(readFileSync(workspaceConfigPath(source), "utf8"))
    assert.equal(config.name, "site")
    assert.equal(config.leader, "Nova")
    // The target directory was never part of the source state.
    assert.equal(JSON.stringify(state.payload.workspaceConfigs).includes(target), false)
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  }
})

test("ticket273: restore removes state and config the backup does not contain", async () => {
  const kept = tempDirectory("kept")
  const dropped = tempDirectory("dropped")
  try {
    writeConfig(kept, "w1", "kept", "Nova", ["Nova"])
    writeConfig(dropped, "x", "dropped", "Old", ["Old"])
    const { storage } = memoryStorage(seed({
      agents: [agent("a", "Nova")],
      workspaces: [workspace("w1", kept, ["a"]), workspace("x", dropped, ["a"])],
    }))
    const backup = await collectBackup(storage, { ...header, now: 5_000 })
    const later = structuredClone(backup)
    later.payload.entries = later.payload.entries.filter((entry) => entry.key !== "v2/workspace/x")
    later.counts = { ...later.counts, workspaces: 1 }
    later.payload.workspaceConfigs = later.payload.workspaceConfigs.filter((item) => item.workspaceID === "w1")
    // Rebuild the digest for the deliberately narrowed fixture.
    const narrowed = sealBackup(later)
    assert.equal(validateBackup(narrowed).counts.workspaces, 1)

    const report = await applyBackup(storage, narrowed, { ...header, versionFloor: 1, now: 6_000 })
    assert.equal(report.workspaces.removed, 1)
    assert.equal(report.workspaces.restored, 1)
    const state = await collectBackup(storage, { ...header, now: 7_000 })
    assert.equal(state.payload.entries.some((entry) => entry.key === "v2/workspace/x"), false)
    assert.throws(() => readFileSync(workspaceConfigPath(dropped), "utf8"), /ENOENT/)
  } finally {
    rmSync(kept, { recursive: true, force: true })
    rmSync(dropped, { recursive: true, force: true })
  }
})

test("ticket273: validation rejects a foreign, newer, truncated, or malformed document", async () => {
  const directory = tempDirectory("validate")
  try {
    writeConfig(directory, "w", "site", "Nova", ["Nova"])
    const { storage } = memoryStorage(seed({ agents: [agent("a", "Nova")], workspaces: [workspace("w", directory)] }))
    const backup = await collectBackup(storage, { ...header, now: 8_000 })
    const reject = (value: unknown, code: string) => {
      assert.throws(() => validateBackup(value), (error: any) => error instanceof BackupError && error.code === code)
    }
    reject({}, "invalid_backup")
    reject({ ...backup, format: "other" }, "invalid_backup")
    reject({ ...backup, formatVersion: 99 }, "unsupported_backup")
    reject({ ...backup, digest: "0".repeat(32) }, "backup_corrupt")
    reject({ ...backup, counts: { ...backup.counts, agents: 9 } }, "invalid_backup")
    reject({ ...backup, payload: { ...backup.payload, entries: [...backup.payload.entries, { key: "v2/agent/a", value: agent("a", "Nova") }] } }, "invalid_backup")
    reject({ ...backup, payload: { ...backup.payload, entries: [{ key: "v2/secrets/a", value: {} }] } }, "invalid_backup")
    reject({ ...backup, payload: { ...backup.payload, entries: [{ key: "v2/agent/a", value: { id: "a" } }] } }, "invalid_backup")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket273: a failed restore recovers the previous state and keeps a rollback slot", async () => {
  const directory = tempDirectory("failure")
  try {
    writeConfig(directory, "w", "site", "Nova", ["Nova"])
    const priorSeed = seed({ agents: [agent("a", "Nova")], workspaces: [workspace("w", directory)] })
    const { storage, values } = memoryStorage(priorSeed)
    const before = new Map(values)
    const next = await collectBackup(storage, { ...header, now: 9_000 })
    const changed = sealBackup({
      ...next,
      createdAt: 10_000,
      payload: {
        ...next.payload,
        entries: next.payload.entries.map((entry) => entry.key === "v2/agent/a"
          ? { key: entry.key, value: { ...(entry.value as Agent), name: "Changed" } }
          : entry),
      },
    })

    let writes = 0
    const failing: BackupStorage = {
      ...storage,
      set: async (key, value) => {
        writes += 1
        // 1: rollback slot, 2: first restored entity.
        if (writes === 2) throw new Error("disk full")
        values.set(key, structuredClone(value))
      },
    }
    await assert.rejects(
      applyBackup(failing, changed, { ...header, versionFloor: 7, now: 11_000 }),
      (error: any) => error instanceof BackupError && error.code === "restore_failed_rolled_back",
    )
    // Acceptance: the previous durable state is recoverable and actually restored.
    for (const [key, value] of before) assert.deepEqual(values.get(key), value, key)
    assert.equal((values.get("v2/agent/a") as Agent).name, "Nova")
    assert.equal(JSON.parse(readFileSync(workspaceConfigPath(directory), "utf8")).leader, "Nova")
    const status = await readRollbackStatus(storage)
    assert.equal(status.present, true)
    assert.equal(status.present && status.valid, true)

    const report = await rollbackBackup(storage, { ...header, versionFloor: 20, now: 12_000 })
    assert.equal(report.version, 21)
    assert.equal(report.rollbackSlot.written, false)
    assert.equal((values.get("v2/agent/a") as Agent).name, "Nova")
    assert.equal((values.get("v2/meta") as any).version, 21)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket273: an unrecoverable apply still leaves the previous state in the slot", async () => {
  const directory = tempDirectory("crash")
  try {
    writeConfig(directory, "w", "site", "Nova", ["Nova"])
    const priorSeed = seed({ agents: [agent("a", "Nova")], workspaces: [workspace("w", directory)] })
    const { storage, values } = memoryStorage(priorSeed)
    const before = new Map(values)
    const next = await collectBackup(storage, { ...header, now: 13_000 })
    const changed = sealBackup({
      ...next,
      createdAt: 14_000,
      payload: {
        ...next.payload,
        entries: next.payload.entries.map((entry) => entry.key === "v2/agent/a"
          ? { key: entry.key, value: { ...(entry.value as Agent), name: "Changed" } }
          : entry),
      },
    })
    let writes = 0
    const failing: BackupStorage = {
      ...storage,
      set: async (key, value) => {
        writes += 1
        if (writes >= 2) throw new Error("disk full")
        values.set(key, structuredClone(value))
      },
    }
    await assert.rejects(
      applyBackup(failing, changed, { ...header, versionFloor: 7, now: 15_000 }),
      (error: any) => error instanceof BackupError && error.code === "restore_failed",
    )
    // The live store is partial, but the slot holds a complete prior document.
    const slot = await storage.get(BACKUP_ROLLBACK_KEY)
    assert.ok(slot)
    const recovered = memoryStorage()
    await applyBackup(recovered.storage, slot, { ...header, versionFloor: 30, now: 16_000 })
    for (const [key, value] of before) {
      if (key === "v2/meta") continue
      assert.deepEqual(recovered.values.get(key), value, key)
    }
    assert.equal((recovered.values.get("v2/agent/a") as Agent).name, "Nova")
    assert.equal((recovered.values.get("v2/meta") as any).settings.nativeFirst, "on")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket273: a workspace config write failure rolls durable state back", async () => {
  const good = tempDirectory("config-good")
  const bad = tempDirectory("config-bad")
  try {
    writeConfig(good, "a", "Old Team", "Nova", ["Nova"])
    // A file where the `.ensemble` directory must be makes the write fail.
    writeFileSync(join(bad, ".ensemble"), "not a directory")
    const priorSeed = seed({
      agents: [agent("a", "Nova")],
      workspaces: [workspace("a", good), workspace("b", bad)],
    })
    const { storage, values } = memoryStorage(priorSeed)
    const before = new Map(values)
    const next = await collectBackup(storage, { ...header, now: 17_000 })
    const changed = sealBackup({
      ...next,
      createdAt: 18_000,
      payload: {
        ...next.payload,
        workspaceConfigs: next.payload.workspaceConfigs.map((item) => item.workspaceID === "a"
          ? { ...item, config: { ...item.config!, name: "New Team" } }
          : item),
      },
    })
    await assert.rejects(
      applyBackup(storage, changed, { ...header, versionFloor: 7, now: 19_000 }),
      (error: any) => error instanceof BackupError && error.code === "restore_failed_rolled_back",
    )
    for (const [key, value] of before) assert.deepEqual(values.get(key), value, key)
    assert.equal(JSON.parse(readFileSync(workspaceConfigPath(good), "utf8")).name, "Old Team")
  } finally {
    rmSync(good, { recursive: true, force: true })
    rmSync(bad, { recursive: true, force: true })
  }
})

test("ticket273: rollback and status report an absent or corrupt slot without content", async () => {
  const { storage } = memoryStorage()
  assert.deepEqual(await readRollbackStatus(storage), { present: false })
  await assert.rejects(rollbackBackup(storage, header), (error: any) => error.code === "no_rollback")
  await storage.set(BACKUP_ROLLBACK_KEY, { secret: "conversation text" })
  const status = await readRollbackStatus(storage)
  assert.deepEqual(status, { present: true, valid: false, reason: "invalid_backup" })
  await assert.rejects(rollbackBackup(storage, header), (error: any) => error.code === "invalid_backup")
})

test("ticket273: the store reloads restored storage and publishes an explicit reset", async () => {
  const { storage } = memoryStorage()
  const patches: any[] = []
  const store = new V2Store({ storage } as any, undefined, {
    epoch: 7,
    onPatch: (batch) => patches.push(batch),
  })
  try {
    await store.load()
    await store.saveAgent(agent("a", "Nova"))
    const exported = await collectBackup(storage, { ...header, now: 20_000 })
    await store.saveAgent(agent("b", "Sage"))
    assert.ok(store.agent("b"))

    await applyBackup(storage, exported, { ...header, versionFloor: store.version(), now: 21_000 })
    patches.length = 0
    await store.reload()
    assert.equal(store.agent("a")?.name, "Nova")
    assert.equal(store.agent("b"), undefined)
    assert.equal(patches.length, 1)
    assert.equal(patches[0].epoch, 7)
    assert.equal(patches[0].reset, true)
    assert.equal(patches[0].entries.length, 0)
    assert.equal(patches[0].version, store.version())
    // The reload itself wrote nothing; the caller's transaction is the writer.
    assert.equal(await storage.get("v2/agent/b"), undefined)
  } finally {
    await store.settled()
  }
})
