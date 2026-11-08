import { relative, resolve, sep } from "node:path"
import { realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { fileReferenceTokens } from "./file-reference.ts"

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

export function workspaceFileReferences(text: string, directory: string): string[] {
  let root: string
  try {
    root = canonicalDirectory(directory)
  } catch {
    return []
  }
  const references = new Set<string>()
  for (const token of fileReferenceTokens(text)) {
    if (!token.path) continue
    try {
      const absolute = realpathSync(resolve(root, token.path))
      if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) continue
      if (!statSync(absolute).isFile()) continue
      references.add(relative(root, absolute))
    } catch {}
  }
  return [...references]
}
