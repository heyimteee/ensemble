#!/usr/bin/env bash
# Create a ticket worktree from a named base branch.
#
# Developer tooling only. This script is never imported by the plugin or TUI.
# It prepares a worktree; it does not run tests or merge.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/worktree.sh
source "$SCRIPT_DIR/lib/worktree.sh"

usage() {
  cat <<'EOF'
Usage: scripts/worktree-create.sh [options] <ticket>

Create a ticket worktree from a named base branch, verify the base, link the
existing dependency directory, and print the worktree path and branch.

Options:
  --base <branch>    Base branch to create from (required).
  --branch <branch>  New branch name (default: ticket/<ticket>).
  --path <path>      Worktree path (default: <repo-parent>/<repo>-<ticket>).
  --deps <path>      Existing dependency directory to link as node_modules.
  -h, --help         Show this help.

Environment:
  ENSEMBLE_BASE_BRANCH     Default for --base.
  ENSEMBLE_WORKTREE_ROOT   Parent directory for the default path.
  ENSEMBLE_DEPS_DIR        Default for --deps.

The base branch must exist locally. If it is checked out in a worktree, that
worktree must be clean. The script refuses an existing path or branch and does
not remove, prune, or modify any other worktree.
EOF
}

ticket=""
base=${ENSEMBLE_BASE_BRANCH:-}
branch=""
worktree_path=""
deps=${ENSEMBLE_DEPS_DIR:-}

while [ $# -gt 0 ]; do
  case "$1" in
    --base)
      worktree_option_value "$1" "${2:-}"
      base=$WORKTREE_OPTION_VALUE
      shift 2
      ;;
    --branch)
      worktree_option_value "$1" "${2:-}"
      branch=$WORKTREE_OPTION_VALUE
      shift 2
      ;;
    --path)
      worktree_option_value "$1" "${2:-}"
      worktree_path=$WORKTREE_OPTION_VALUE
      shift 2
      ;;
    --deps)
      worktree_option_value "$1" "${2:-}"
      deps=$WORKTREE_OPTION_VALUE
      shift 2
      ;;
    *)
      worktree_common_option "$1" || true
      [ -z "$ticket" ] || worktree_fail "unexpected argument: $1"
      ticket=$1
      shift
      ;;
  esac
done

[ -n "$ticket" ] || {
  usage >&2
  exit 2
}
[[ "$ticket" =~ ^[0-9]+$ ]] || worktree_fail "ticket must be a number, got: $ticket"
[ -n "$base" ] || worktree_fail "--base <branch> is required (or set ENSEMBLE_BASE_BRANCH)"

[ -n "$branch" ] || branch="ticket/$ticket"

git -C "$WORKTREE_REPO_ROOT" show-ref --verify --quiet "refs/heads/$base" ||
  worktree_fail "base branch '$base' does not exist locally; create or fetch it first"

if git -C "$WORKTREE_REPO_ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
  worktree_fail "branch '$branch' already exists"
fi

if [ -z "$worktree_path" ]; then
  [ -n "$WORKTREE_PRIMARY_ROOT" ] || worktree_fail "could not resolve the primary worktree"
  root=${ENSEMBLE_WORKTREE_ROOT:-$(dirname -- "$WORKTREE_PRIMARY_ROOT")}
  worktree_path="$root/$(basename -- "$WORKTREE_PRIMARY_ROOT")-$ticket"
fi
worktree_path=$(worktree_abs_path "$worktree_path")

if [ -e "$worktree_path" ] || [ -L "$worktree_path" ]; then
  worktree_fail "worktree path already exists: $worktree_path"
fi

base_commit=$(git -C "$WORKTREE_REPO_ROOT" rev-parse --verify "refs/heads/$base^{commit}")
base_worktree=$(worktree_for_branch "$base")
if [ -n "$base_worktree" ]; then
  if [ -n "$(git -C "$base_worktree" status --porcelain)" ]; then
    worktree_fail "base branch '$base' is checked out in a dirty worktree: $base_worktree"
  fi
fi

if [ -z "$deps" ]; then
  for candidate in "$WORKTREE_PRIMARY_ROOT/node_modules" "$WORKTREE_REPO_ROOT/node_modules"; do
    if [ -d "$candidate" ]; then
      deps=$candidate
      break
    fi
  done
fi
[ -n "$deps" ] || worktree_fail "no dependency directory found; run npm ci or pass --deps <path>"
[ -d "$deps" ] || worktree_fail "dependency directory does not exist: $deps"
deps=$(cd -- "$deps" && pwd -P)

printf 'BASE %s %s\n' "$base" "$(git -C "$WORKTREE_REPO_ROOT" rev-parse --short "$base_commit")"

if ! git -C "$WORKTREE_REPO_ROOT" worktree add -b "$branch" "$worktree_path" "$base"; then
  worktree_fail "git worktree add failed"
fi

rollback_new_worktree() {
  git -C "$WORKTREE_REPO_ROOT" worktree remove --force "$worktree_path" || true
  git -C "$WORKTREE_REPO_ROOT" branch -D "$branch" >/dev/null 2>&1 || true
}

if ! ln -s "$deps" "$worktree_path/node_modules"; then
  rollback_new_worktree
  worktree_fail "could not link node_modules from $deps; removed the new worktree and branch"
fi

printf 'WORKTREE %s\n' "$worktree_path"
printf 'BRANCH %s\n' "$branch"
printf 'DEPS %s\n' "$deps"
