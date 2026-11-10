#!/usr/bin/env bash
# Shared helpers for developer worktree scripts.
#
# Developer tooling only. Never imported by the plugin or TUI. Source this file
# from a script; do not execute it.

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "worktree: source this file; do not execute it" >&2
  exit 2
fi

WORKTREE_TOOL="${WORKTREE_TOOL:-$(basename -- "${0:-worktree}" .sh)}"
WORKTREE_LIB_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
WORKTREE_SCRIPT_DIR=$(dirname -- "$WORKTREE_LIB_DIR")
WORKTREE_REPO_ROOT=$(git -C "$WORKTREE_SCRIPT_DIR/.." rev-parse --show-toplevel)
WORKTREE_PRIMARY_ROOT=$(git -C "$WORKTREE_REPO_ROOT" worktree list --porcelain | sed -n '1s/^worktree //p')

worktree_fail() {
  printf '%s: %s\n' "$WORKTREE_TOOL" "$*" >&2
  exit 1
}

# Read a value-taking option. Sets WORKTREE_OPTION_VALUE.
worktree_option_value() {
  local option="$1" value="${2:-}"
  [ -n "$value" ] || worktree_fail "$option needs a value"
  WORKTREE_OPTION_VALUE="$value"
}

# Handle the options common to both helpers. usage() is supplied by the
# sourcing script. Returns 1 for a positional argument.
worktree_common_option() {
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --*) worktree_fail "unknown option: $1" ;;
  esac
  return 1
}

worktree_for_branch() {
  local branch_ref="refs/heads/$1"
  git -C "$WORKTREE_REPO_ROOT" worktree list --porcelain |
    awk -v ref="$branch_ref" '
      /^worktree / { path = substr($0, 10) }
      /^branch / { if (substr($0, 8) == ref) { print path; exit } }
    '
}

worktree_abs_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s\n' "$(pwd)/$1" ;;
  esac
}
