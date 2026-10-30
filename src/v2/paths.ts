import { resolve } from "node:path"
import { realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"

export function expandHome(directory: string): string {
  if (directory === "~") return homedir()
  if (directory.startsWith("~/")) return resolve(homedir(), directory.slice(2))
  return directory
}

export function canonicalDirectory(directory: string): string {
  const absolute = resolve(expandHome(directory))
  const stat = statSync(absolute)
  if (!stat.isDirectory()) throw Object.assign(new Error("That path is not a directory."), { code: "not_directory" })
  return realpathSync(absolute)
}
