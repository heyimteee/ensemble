#!/usr/bin/env bash
set -uo pipefail

# Aggregate live-check runner. Runs scenario scripts in a fixed order, stops at
# the first failure, and prints one compact summary. Each scenario keeps its own
# pass/fail/skip semantics; this wrapper never retries and never hides output.
#
#   bash scripts/live-matrix.sh fake   # deterministic fake + empty catalog
#   bash scripts/live-matrix.sh all    # fake + empty catalog + real host
#
# `fake` is the local/CI guardrail. `all` is the full local matrix and needs a
# real model catalog (see scripts/README.md). Local runs report a missing
# prerequisite as SKIP and exit zero. ENSEMBLE_LIVE_REQUIRE=1 turns SKIP into a
# failure so CI cannot look green on a suite that did not run. Skip detection
# reads the harness's marker file, never log prose.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

scenario_script() {
  case "$1" in
    fake) printf '%s\n' "$SCRIPT_DIR/live-check-fake.sh" ;;
    fake-empty) printf '%s\n' "$SCRIPT_DIR/live-check-fake-empty.sh" ;;
    real) printf '%s\n' "$SCRIPT_DIR/live-check.sh" ;;
    *) return 1 ;;
  esac
}

usage() {
  echo "usage: bash scripts/live-matrix.sh fake|all" >&2
}

mode="${1:-}"
shift || true
if (( $# > 0 )); then
  usage
  exit 2
fi

case "$mode" in
  fake) scenarios=(fake fake-empty) ;;
  all) scenarios=(fake fake-empty real) ;;
  *)
    usage
    exit 2
    ;;
esac

require_mode="${ENSEMBLE_LIVE_REQUIRE:-0}"
export ENSEMBLE_LIVE_REQUIRE="$require_mode"

tmp_parent="${TMPDIR:-/tmp}/opencode"
mkdir -p "$tmp_parent" || exit 1
matrix_tmp=$(mktemp -d "$tmp_parent/ensemble-matrix-XXXXXX") || exit 1
trap 'rm -rf "$matrix_tmp"' EXIT
trap 'exit 130' INT TERM

if [[ "$require_mode" == "1" ]]; then
  printf 'live-matrix: require mode (skips are failures)\n'
fi

run_start=$SECONDS
passed=0
failed=0
skipped=0
not_run=0
summary=()
failed_status=0

for ((i = 0; i < ${#scenarios[@]}; i++)); do
  name="${scenarios[i]}"
  script=$(scenario_script "$name")
  if [[ ! -f "$script" ]]; then
    printf 'live-matrix: %s: FAIL (script missing: %s)\n' "$name" "$script" >&2
    summary+=("FAIL  $name (script missing)")
    failed=$((failed + 1))
    failed_status=1
    for ((j = i + 1; j < ${#scenarios[@]}; j++)); do
      summary+=("NOT RUN ${scenarios[j]}")
      not_run=$((not_run + 1))
    done
    break
  fi

  log="$matrix_tmp/$name.log"
  skip_marker="$matrix_tmp/$name.skip"
  printf 'live-matrix: %s: start\n' "$name"
  started=$SECONDS
  # The harness writes this marker when it takes the local skip path. Reading a
  # structure beats scraping log prose: a scenario that only mentions a skip
  # cannot be misclassified.
  if ENSEMBLE_LIVE_SKIP_MARKER="$skip_marker" bash "$script" 2>&1 | tee "$log"; then
    status=0
  else
    status=$?
  fi
  elapsed=$((SECONDS - started))

  if (( status != 0 )); then
    cause=$(grep '^live: ' "$log" 2>/dev/null | grep -v '^live: failure context$' | tail -n 1 || true)
    printf 'live-matrix: %s: FAIL (%ss)\n' "$name" "$elapsed" >&2
    if [[ -n "$cause" ]]; then
      summary+=("FAIL  $name (${elapsed}s): $cause")
    else
      summary+=("FAIL  $name (${elapsed}s)")
    fi
    failed=$((failed + 1))
    failed_status=$status
    for ((j = i + 1; j < ${#scenarios[@]}; j++)); do
      summary+=("NOT RUN ${scenarios[j]}")
      not_run=$((not_run + 1))
    done
    break
  fi

  if [[ -f "$skip_marker" ]]; then
    if [[ "$require_mode" == "1" ]]; then
      printf 'live-matrix: %s: FAIL (%ss; SKIP is not allowed in require mode)\n' "$name" "$elapsed" >&2
      summary+=("FAIL  $name (${elapsed}s): prerequisites missing in require mode")
      failed=$((failed + 1))
      failed_status=1
      for ((j = i + 1; j < ${#scenarios[@]}; j++)); do
        summary+=("NOT RUN ${scenarios[j]}")
        not_run=$((not_run + 1))
      done
      break
    fi
    printf 'live-matrix: %s: SKIP (%ss; prerequisites missing, not a pass)\n' "$name" "$elapsed"
    summary+=("SKIP  $name (${elapsed}s; prerequisites missing)")
    skipped=$((skipped + 1))
  else
    printf 'live-matrix: %s: PASS (%ss)\n' "$name" "$elapsed"
    summary+=("PASS  $name (${elapsed}s)")
    passed=$((passed + 1))
  fi
done

total=$((SECONDS - run_start))
printf 'live-matrix: summary\n'
for line in "${summary[@]}"; do
  printf 'live-matrix:   %s\n' "$line"
done
printf 'live-matrix: %d passed, %d failed, %d skipped, %d not run in %ss\n' \
  "$passed" "$failed" "$skipped" "$not_run" "$total"

if (( failed > 0 )); then
  exit "${failed_status:-1}"
fi
exit 0
