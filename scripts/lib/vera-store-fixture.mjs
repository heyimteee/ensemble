#!/usr/bin/env node
/**
 * Ticket #241 upgrade-store fixture.
 *
 * The Vera regression must start from the store shape that existed before
 * ticket #240: durable agents, workspaces, bindings, and settings, but no
 * persisted `nativeFirst` key. The isolated host stores plugin key/value pairs
 * in its own SQLite database, so this helper removes exactly that one key from
 * the `v2/meta` row and reports the structural result. It never copies store
 * content, message text, credentials, or paths to stdout.
 *
 * Test infrastructure only; the product plugin never imports this file.
 */
import { DatabaseSync } from "node:sqlite"
import { writeFileSync } from "node:fs"

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const dbPath = arg("--db")
const mode = arg("--mode", "remove")
const out = arg("--out")
if (!dbPath) {
  process.stderr.write("vera-store-fixture: --db is required\n")
  process.exit(2)
}
if (!["remove", "check"].includes(mode)) {
  process.stderr.write("vera-store-fixture: --mode must be remove or check\n")
  process.exit(2)
}

function readMetaRows(db) {
  const rows = db.prepare("SELECT key, value FROM kv WHERE key LIKE ?").all("%:v2/meta")
  return rows.flatMap((row) => {
    try {
      const value = JSON.parse(row.value)
      if (!value || typeof value !== "object") return []
      if (!value.settings || typeof value.settings !== "object" || Array.isArray(value.settings)) return []
      return [{ key: row.key, value }]
    } catch {
      return []
    }
  })
}

let db
try {
  db = new DatabaseSync(dbPath)
  const before = readMetaRows(db)
  if (mode === "remove") {
    let removed = 0
    let hadNativeFirst = false
    for (const row of before) {
      if (!Object.prototype.hasOwnProperty.call(row.value.settings, "nativeFirst")) continue
      hadNativeFirst = true
      delete row.value.settings.nativeFirst
      db.prepare("UPDATE kv SET value = ?, time_updated = ? WHERE key = ?").run(
        JSON.stringify(row.value),
        Date.now(),
        row.key,
      )
      removed += 1
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    const after = readMetaRows(db)
    const absent = after.every((row) => !Object.prototype.hasOwnProperty.call(row.value.settings, "nativeFirst"))
    const result = {
      schema: "ensemble.vera-store-fixture",
      version: 1,
      mode,
      metaRows: before.length,
      hadNativeFirst,
      removed,
      absent,
    }
    if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (!absent || (before.length > 0 && removed === 0)) process.exit(1)
  } else {
    const modes = before.map((row) => {
      const value = row.value.settings.nativeFirst
      return typeof value === "string" ? value : null
    })
    const result = {
      schema: "ensemble.vera-store-fixture",
      version: 1,
      mode,
      metaRows: before.length,
      nativeFirst: modes.length > 0 && modes.every((value) => value !== null) ? modes[0] : null,
      modes,
    }
    if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (!(result.metaRows > 0 && result.nativeFirst === "on")) process.exit(1)
  }
} catch (error) {
  process.stderr.write(`vera-store-fixture: ${error?.message ?? error}\n`)
  process.exit(1)
} finally {
  db?.close()
}
