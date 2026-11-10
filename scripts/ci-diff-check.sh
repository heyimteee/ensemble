#!/usr/bin/env bash
# Check the pushed or pull-request range for whitespace errors and committed
# conflict residue.
#
# Base resolution:
#   1. explicit first argument
#   2. PR_BASE_SHA (pull request)
#   3. PUSH_BEFORE_SHA (push)
#   4. no base, or an all-zero base (initial push): check the full HEAD tree
#
# Usage: scripts/ci-diff-check.sh [<base-commit> [<head-commit>]]
set -euo pipefail

base="${1:-${PR_BASE_SHA:-${PUSH_BEFORE_SHA:-}}}"
head="${2:-HEAD}"
zero=0000000000000000000000000000000000000000
empty_tree=$(git hash-object -t tree /dev/null)

if [ -z "$base" ] || [ "$base" = "$zero" ]; then
  printf 'diff-check: initial push; checking the full %s tree\n' "$head"
  git diff --check "$empty_tree" "$head"
elif git cat-file -e "$base^{commit}" 2>/dev/null; then
  printf 'diff-check: checking %s..%s\n' "$base" "$head"
  git diff --check "$base" "$head"
else
  printf 'diff-check: base %s is unavailable; checking the full %s tree\n' "$base" "$head" >&2
  git diff --check "$empty_tree" "$head"
fi
