#!/usr/bin/env bash
# Create a ticket worktree from a named base branch.
#
# Developer tooling only. This script is never imported by the plugin or TUI.
# It prepares a worktree; it does not run tests or merge.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel)
PRIMARY_ROOT=$(git -C "$REPO_ROOT" worktree list --porcelain | sed -n '1s/^worktree //p')

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

fail() {
  printf 'worktree-create: %s\n' "$*" >&2
  exit 1
}

worktree_for_branch() {
  local branch_ref="refs/heads/$1"
  git -C "$REPO_ROOT" worktree list --porcelain |
    awk -v ref="$branch_ref" '
      /^worktree / { path = substr($0, 10) }
      /^branch / { if (substr($0, 8) == ref) { print path; exit } }
    '
}

ticket=""
base=${ENSEMBLE_BASE_BRANCH:-}
branch=""
worktree_path=""
deps=${ENSEMBLE_DEPS_DIR:-}

while [ $# -gt 0 ]; do
  case "$1" in
    --base)
      [ $# -ge 2 ] || fail "--base needs a value"
      base=$2
      shift 2
      ;;
    --branch)
      [ $# -ge 2 ] || fail "--branch needs a value"
      branch=$2
      shift 2
      ;;
    --path)
      [ $# -ge 2 ] || fail "--path needs a value"
      worktree_path=$2
      shift 2
      ;;
    --deps)
      [ $# -ge 2 ] || fail "--deps needs a value"
      deps=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --*)
      fail "unknown option: $1"
      ;;
    *)
      [ -z "$ticket" ] || fail "unexpected argument: $1"
      ticket=$1
      shift
      ;;
  esac
done

[ -n "$ticket" ] || {
  usage >&2
  exit 2
}
[[ "$ticket" =~ ^[0-9]+$ ]] || fail "ticket must be a number, got: $ticket"
[ -n "$base" ] || fail "--base <branch> is required (or set ENSEMBLE_BASE_BRANCH)"

[ -n "$branch" ] || branch="ticket/$ticket"

git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$base" ||
  fail "base branch '$base' does not exist locally; create or fetch it first"

if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
  fail "branch '$branch' already exists"
fi

if [ -z "$worktree_path" ]; then
  [ -n "$PRIMARY_ROOT" ] || fail "could not resolve the primary worktree"
  root=${ENSEMBLE_WORKTREE_ROOT:-$(dirname -- "$PRIMARY_ROOT")}
  worktree_path="$root/$(basename -- "$PRIMARY_ROOT")-$ticket"
fi

case "$worktree_path" in
  /*) ;;
  *) worktree_path="$(pwd)/$worktree_path" ;;
esac

if [ -e "$worktree_path" ] || [ -L "$worktree_path" ]; then
  fail "worktree path already exists: $worktree_path"
fi

base_commit=$(git -C "$REPO_ROOT" rev-parse --verify "refs/heads/$base^{commit}")
base_worktree=$(worktree_for_branch "$base")
if [ -n "$base_worktree" ]; then
  if [ -n "$(git -C "$base_worktree" status --porcelain)" ]; then
    fail "base branch '$base' is checked out in a dirty worktree: $base_worktree"
  fi
  base_worktree_head=$(git -C "$base_worktree" rev-parse HEAD)
  [ "$base_worktree_head" = "$base_commit" ] ||
    fail "base branch '$base' does not match the HEAD of $base_worktree"
fi

if [ -z "$deps" ]; then
  for candidate in "$PRIMARY_ROOT/node_modules" "$REPO_ROOT/node_modules"; do
    if [ -d "$candidate" ]; then
      deps=$candidate
      break
    fi
  done
fi
[ -n "$deps" ] || fail "no dependency directory found; run npm ci or pass --deps <path>"
[ -d "$deps" ] || fail "dependency directory does not exist: $deps"
deps=$(cd -- "$deps" && pwd -P)

printf 'BASE %s %s\n' "$base" "$(git -C "$REPO_ROOT" rev-parse --short "$base_commit")"

if ! git -C "$REPO_ROOT" worktree add -b "$branch" "$worktree_path" "$base"; then
  fail "git worktree add failed"
fi

actual_branch=$(git -C "$worktree_path" symbolic-ref --short HEAD)
if [ "$actual_branch" != "$branch" ]; then
  git -C "$REPO_ROOT" worktree remove --force "$worktree_path" || true
  git -C "$REPO_ROOT" branch -D "$branch" >/dev/null 2>&1 || true
  fail "new worktree is on '$actual_branch', expected '$branch'"
fi

if ! ln -s "$deps" "$worktree_path/node_modules"; then
  git -C "$REPO_ROOT" worktree remove --force "$worktree_path" || true
  git -C "$REPO_ROOT" branch -D "$branch" >/dev/null 2>&1 || true
  fail "could not link node_modules from $deps; removed the new worktree and branch"
fi

head_commit=$(git -C "$worktree_path" rev-parse HEAD)
if [ "$head_commit" != "$base_commit" ]; then
  git -C "$REPO_ROOT" worktree remove --force "$worktree_path" || true
  git -C "$REPO_ROOT" branch -D "$branch" >/dev/null 2>&1 || true
  fail "new worktree HEAD does not match the base commit"
fi

printf 'WORKTREE %s\n' "$worktree_path"
printf 'BRANCH %s\n' "$branch"
printf 'BASE %s %s\n' "$base" "$(git -C "$worktree_path" rev-parse --short HEAD)"
printf 'DEPS %s\n' "$deps"
