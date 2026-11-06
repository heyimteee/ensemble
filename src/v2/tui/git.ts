import { spawnSync } from "node:child_process"

export type GitState = { branch: string; dirty: boolean; ahead: number; behind: number }

export function parseGitStatus(output: string): GitState | null {
  const lines = output.split("\n").map((line) => line.trimEnd()).filter(Boolean)
  const head = lines[0]
  if (!head?.startsWith("## ")) return null
  const status = head.slice(3)
  let branch = "detached"
  if (status.startsWith("HEAD (no branch)")) {
    branch = "detached"
  } else if (status.startsWith("No commits yet on ")) {
    branch = status.slice("No commits yet on ".length).split(" ")[0] || "detached"
  } else {
    branch = status.split("...")[0].split(" ")[0] || "detached"
  }
  const ahead = Number(status.match(/ahead (\d+)/)?.[1] ?? 0)
  const behind = Number(status.match(/behind (\d+)/)?.[1] ?? 0)
  return { branch, dirty: lines.length > 1, ahead, behind }
}

export function readGitState(directory: string): GitState | null {
  const result = spawnSync("git", ["-C", directory, "status", "--porcelain=v1", "--branch"], {
    encoding: "utf8",
    timeout: 1500,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.error || result.status !== 0 || !result.stdout) return null
  return parseGitStatus(result.stdout)
}

export type GitChangeFeedback = { message: string; tone: "info" | "warning" }

/**
 * Feedback for a real change between two git reads (ticket #119). The first
 * read is a baseline, and losing git state is not a change toast. A dirty tree
 * keeps warning emphasis even when another field changed in the same poll.
 */
export function describeGitChange(previous: GitState | null, next: GitState | null): GitChangeFeedback | undefined {
  if (!previous || !next) return undefined
  const parts: string[] = []
  if (previous.branch !== next.branch) parts.push(`On ${next.branch}`)
  if (previous.dirty !== next.dirty) parts.push(next.dirty ? "working tree dirty" : "working tree clean")
  if (previous.ahead !== next.ahead || previous.behind !== next.behind) parts.push(`ahead ${next.ahead}, behind ${next.behind}`)
  if (parts.length === 0) return undefined
  if (parts.length === 1 && previous.dirty !== next.dirty) {
    return { message: next.dirty ? "Uncommitted changes detected." : "Working tree clean.", tone: next.dirty ? "warning" : "info" }
  }
  if (parts.length === 1 && (previous.ahead !== next.ahead || previous.behind !== next.behind)) {
    return { message: `Ahead ${next.ahead}, behind ${next.behind}.`, tone: next.dirty ? "warning" : "info" }
  }
  return { message: `${parts.join("; ")}.`, tone: next.dirty ? "warning" : "info" }
}
