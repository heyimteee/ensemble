#!/usr/bin/env bash
# Merge a ticket branch into the integration worktree with a no-fast-forward
# merge, then run the full verify gate.
#
# Developer tooling only. This script is never imported by the plugin or TUI.
# It never resolves conflicts, pushes, or closes issues.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/worktree.sh
source "$SCRIPT_DIR/lib/worktree.sh"

usage() {
  cat <<'EOF'
Usage: scripts/integration-merge.sh [options] <source-branch>

Merge a source branch into the integration worktree with --no-ff, check the
source range for whitespace errors and conflict residue, stop on conflicts, run
npm run verify, and print the merge commit and result.

Options:
  --integration-branch <branch>  Integration branch (default: integration/env-guardrails).
  -h, --help                     Show this help.

Environment:
  ENSEMBLE_INTEGRATION_BRANCH  Default for --integration-branch.

The integration worktree must be clean and must have the integration branch
checked out. On conflict the merge is left in progress for deliberate
resolution; use `git -C <worktree> merge --abort` to discard it. This script
never resolves conflicts, pushes, or edits issues.
EOF
}

source_branch=""
integration_branch=${ENSEMBLE_INTEGRATION_BRANCH:-integration/env-guardrails}

while [ $# -gt 0 ]; do
  case "$1" in
    --integration-branch)
      worktree_option_value "$1" "${2:-}"
      integration_branch=$WORKTREE_OPTION_VALUE
      shift 2
      ;;
    *)
      worktree_common_option "$1" || true
      [ -z "$source_branch" ] || worktree_fail "unexpected argument: $1"
      source_branch=$1
      shift
      ;;
  esac
done

[ -n "$source_branch" ] || {
  usage >&2
  exit 2
}
[ "$source_branch" != "$integration_branch" ] ||
  worktree_fail "source branch and integration branch are both '$source_branch'"

command -v npm >/dev/null 2>&1 || worktree_fail "npm was not found; run under the pinned Node environment"

git -C "$WORKTREE_REPO_ROOT" show-ref --verify --quiet "refs/heads/$source_branch" ||
  worktree_fail "source branch '$source_branch' does not exist locally"
git -C "$WORKTREE_REPO_ROOT" show-ref --verify --quiet "refs/heads/$integration_branch" ||
  worktree_fail "integration branch '$integration_branch' does not exist locally"

integration_worktree=$(worktree_for_branch "$integration_branch")
[ -n "$integration_worktree" ] ||
  worktree_fail "integration branch '$integration_branch' is not checked out in any worktree"

checked_out_branch=$(git -C "$integration_worktree" symbolic-ref --quiet --short HEAD) ||
  worktree_fail "integration worktree is detached: $integration_worktree"
[ "$checked_out_branch" = "$integration_branch" ] ||
  worktree_fail "worktree $integration_worktree has '$checked_out_branch' checked out, expected '$integration_branch'"

integration_status=$(git -C "$integration_worktree" status --porcelain)
if [ -n "$integration_status" ]; then
  printf 'integration-merge: integration worktree is not clean: %s\n' "$integration_worktree" >&2
  printf '%s\n' "$integration_status" | sed -n '1,20p' >&2
  exit 1
fi

source_commit=$(git -C "$WORKTREE_REPO_ROOT" rev-parse --verify "refs/heads/$source_branch^{commit}")
printf 'SOURCE %s %s\n' "$source_branch" "$(git -C "$WORKTREE_REPO_ROOT" rev-parse --short "$source_commit")"
printf 'INTEGRATION %s\n' "$integration_branch"
printf 'WORKTREE %s\n' "$integration_worktree"

merge_base=$(git -C "$integration_worktree" merge-base HEAD "$source_commit") ||
  worktree_fail "could not find a merge base between '$integration_branch' and '$source_branch'"
if ! (cd -- "$integration_worktree" && bash "$WORKTREE_SCRIPT_DIR/ci-diff-check.sh" "$merge_base" "$source_commit"); then
  worktree_fail "source branch '$source_branch' introduces whitespace errors or conflict residue"
fi

printf 'MERGING %s -> %s\n' "$source_branch" "$integration_branch"
if ! git -C "$integration_worktree" merge --no-ff --no-edit "$source_branch"; then
  if git -C "$integration_worktree" rev-parse -q --verify MERGE_HEAD >/dev/null; then
    printf '\nintegration-merge: merge stopped on conflicts in %s\n' "$integration_worktree" >&2
    printf 'Conflicted paths:\n' >&2
    git -C "$integration_worktree" diff --name-only --diff-filter=U >&2 || true
    printf '\nResolve them deliberately, then commit the merge. To discard the merge:\n' >&2
    printf '  git -C %q merge --abort\n' "$integration_worktree" >&2
    printf 'RESULT conflict\n'
  else
    printf '\nintegration-merge: merge failed before creating a merge commit\n' >&2
    printf 'RESULT merge-failed\n'
  fi
  exit 1
fi

merge_commit=$(git -C "$integration_worktree" rev-parse HEAD)
merge_subject=$(git -C "$integration_worktree" log -1 --pretty=%s)
merge_parents=$(git -C "$integration_worktree" log -1 --pretty=%P)

printf 'MERGE_COMMIT %s\n' "$merge_commit"
printf 'SUBJECT %s\n' "$merge_subject"

printf '\nVERIFY running npm run verify in %s\n' "$integration_worktree"
verify_result=FAIL
if (cd -- "$integration_worktree" && npm run verify); then
  verify_result=PASS
fi

printf '\nINTEGRATION MERGE RESULT\n'
printf 'SOURCE %s %s\n' "$source_branch" "$(git -C "$WORKTREE_REPO_ROOT" rev-parse --short "$source_commit")"
printf 'INTEGRATION %s\n' "$integration_branch"
printf 'WORKTREE %s\n' "$integration_worktree"
printf 'MERGE_COMMIT %s\n' "$merge_commit"
printf 'PARENTS %s\n' "$merge_parents"
printf 'VERIFY %s\n' "$verify_result"
printf 'RESULT merged\n'

if [ "$verify_result" != "PASS" ]; then
  printf 'integration-merge: verify failed after the merge; the merge commit is retained for deliberate follow-up\n' >&2
  exit 1
fi
