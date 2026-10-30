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
