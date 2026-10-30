import { resolve } from "node:path"
import { realpathSync, statSync } from "node:fs"

export function canonicalDirectory(directory: string): string {
  const absolute = resolve(directory)
  const stat = statSync(absolute)
  if (!stat.isDirectory()) throw Object.assign(new Error("That path is not a directory."), { code: "not_directory" })
  return realpathSync(absolute)
}
