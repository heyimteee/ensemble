/**
 * Local identity markers for media and documentation privacy checks.
 *
 * The repository must not hard-code a contributor's username. Detection uses
 * the machine that runs the check: the OS account, the home-directory basename,
 * the USER/LOGNAME environment fallback, and the hostname. Tests can pass an
 * explicit identity to prove the matcher without touching the real machine.
 */
import { homedir, hostname as osHostname, userInfo } from "node:os"
import { basename } from "node:path"

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length >= 3))]
}

function osUsername() {
  try {
    return userInfo().username
  } catch {
    return ""
  }
}

/**
 * Return the current user, host, and private home-path markers. `overrides`
 * exists for deterministic tests; production callers use the real machine.
 */
export function privateIdentity(overrides = {}) {
  const home = overrides.home ?? homedir()
  const users = unique([
    overrides.username,
    osUsername(),
    process.env.USER,
    process.env.LOGNAME,
    basename(home),
  ])
  const hosts = unique([overrides.hostname, osHostname()])
  const paths = unique([
    home,
    ...users.flatMap((user) => [`/home/${user}`, `/Users/${user}`]),
  ])
  return { users, hosts, paths, markers: unique([...users, ...hosts, ...paths]) }
}

export function privacyMarkers(overrides = {}) {
  return privateIdentity(overrides).markers
}

export function privacyViolations(text, overrides = {}) {
  return privacyMarkers(overrides).filter((marker) => text.includes(marker))
}
