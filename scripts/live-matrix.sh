#!/usr/bin/env bash
set -uo pipefail

# Aggregate live-check runner. Runs scenario scripts in a fixed order, stops at
# the first unretryable failure, and prints one compact summary. Each scenario
# keeps its own pass/fail/skip semantics.
#
#   bash scripts/live-matrix.sh fake   # deterministic fake + empty catalog
#   bash scripts/live-matrix.sh all    # fake + empty catalog + real host
#
# `fake` is the local/CI guardrail. `all` is the full local matrix and needs a
# real model catalog (see scripts/README.md). Local runs report a missing
# prerequisite as SKIP and exit zero. ENSEMBLE_LIVE_REQUIRE=1 turns SKIP into a
# failure so CI cannot look green on a suite that did not run. Skip detection
# reads the harness's marker file, never log prose.
#
# Flake policy: a failed attempt is classified from the harness failure record.
# Only a `timing` classification may retry, and only once. Product, unknown,
# and infrastructure failures never retry or quarantine. Every attempt is
# recorded and the report lists suite, retry, classification, and artifact
# path. A quarantine entry needs a linked issue and an owner; the matrix
# refuses to run otherwise. See docs/verification/flake-policy.md.

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

flake_cli="$SCRIPT_DIR/flake-report.mjs"
node_bin=$(command -v node 2>/dev/null || true)
quarantine_file="${ENSEMBLE_LIVE_QUARANTINE:-$SCRIPT_DIR/flake-quarantine.json}"
records_file="$matrix_tmp/flake-records.jsonl"
artifacts_root="${ENSEMBLE_LIVE_ARTIFACTS:-$tmp_parent/ensemble-live-artifacts-$(date +%Y%m%d-%H%M%S)-$$}"
quarantine_suites=""

if [[ -n "$node_bin" && -f "$quarantine_file" ]]; then
  if ! quarantine_suites=$("$node_bin" --experimental-strip-types "$flake_cli" quarantine --file "$quarantine_file" --list); then
    printf 'live-matrix: quarantine file is invalid: %s\n' "$quarantine_file" >&2
    exit 1
  fi
fi

if [[ "$require_mode" == "1" ]]; then
  printf 'live-matrix: require mode (skips are failures)\n'
fi

quarantine_for() {
  awk -F'\t' -v suite="$1" '$1 == suite { print $2 "\t" $3; exit }' <<<"$quarantine_suites"
}

record_attempt() {
  local suite="$1" attempt="$2" status="$3" classification="$4" message="$5" artifact="$6" duration="$7"
  [[ -n "$node_bin" ]] || return 0
  "$node_bin" -e '
    const [suite, attempt, status, classification, message, artifactPath, durationSeconds] = process.argv.slice(1);
    const record = { suite, attempt: Number(attempt), status, artifactPath, durationSeconds: Number(durationSeconds) };
    if (classification && classification !== "none") record.classification = classification;
    if (message) record.message = message;
    process.stdout.write(JSON.stringify(record) + "\n");
  ' "$suite" "$attempt" "$status" "$classification" "$message" "$artifact" "$duration" >>"$records_file"
}

print_flake_report() {
  local report_out="$matrix_tmp/flake-report.json"
  if [[ -z "$node_bin" || ! -s "$records_file" ]]; then
    return 0
  fi
  "$node_bin" --experimental-strip-types "$flake_cli" report --records "$records_file" --out "$report_out" || true
  if [[ -d "$artifacts_root" ]]; then
    cp "$report_out" "$artifacts_root/flake-report.json" 2>/dev/null || true
    printf 'live-matrix: artifacts: %s\n' "$artifacts_root"
  fi
}

run_start=$SECONDS
passed=0
failed=0
skipped=0
quarantined=0
not_run=0
retries=0
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

  attempt=1
  scenario_status=1
  while true; do
    log="$matrix_tmp/$name.attempt-$attempt.log"
    skip_marker="$matrix_tmp/$name.attempt-$attempt.skip"
    artifact_dir="$artifacts_root/$name/attempt-$attempt"
    printf 'live-matrix: %s: start (attempt %s)\n' "$name" "$attempt"
    started=$SECONDS
    # The harness writes this marker when it takes the local skip path. Reading
    # a structure beats scraping log prose: a scenario that only mentions a
    # skip cannot be misclassified. The artifact directory and suite identity
    # let the harness write a classified failure record.
    if ENSEMBLE_LIVE_SKIP_MARKER="$skip_marker" \
       ENSEMBLE_LIVE_ARTIFACTS="$artifact_dir" \
       ENSEMBLE_LIVE_SUITE="$name" \
       ENSEMBLE_LIVE_ATTEMPT="$attempt" \
       bash "$script" 2>&1 | tee "$log"; then
      scenario_status=0
    else
      scenario_status=$?
    fi
    elapsed=$((SECONDS - started))

    if (( scenario_status == 0 )); then
      if [[ -f "$skip_marker" ]]; then
        if [[ "$require_mode" == "1" ]]; then
          printf 'live-matrix: %s: FAIL (%ss; SKIP is not allowed in require mode)\n' "$name" "$elapsed" >&2
          summary+=("FAIL  $name (${elapsed}s): prerequisites missing in require mode")
          failed=$((failed + 1))
          failed_status=1
          record_attempt "$name" "$attempt" "failed" "infrastructure" "prerequisites missing in require mode" "$artifact_dir" "$elapsed"
          for ((j = i + 1; j < ${#scenarios[@]}; j++)); do
            summary+=("NOT RUN ${scenarios[j]}")
            not_run=$((not_run + 1))
          done
          break 2
        fi
        printf 'live-matrix: %s: SKIP (%ss; prerequisites missing, not a pass)\n' "$name" "$elapsed"
        summary+=("SKIP  $name (${elapsed}s; prerequisites missing)")
        skipped=$((skipped + 1))
        record_attempt "$name" "$attempt" "skipped" "none" "prerequisites missing" "$artifact_dir" "$elapsed"
        break
      fi
      printf 'live-matrix: %s: PASS (%ss)\n' "$name" "$elapsed"
      if (( attempt > 1 )); then
        summary+=("PASS  $name (${elapsed}s; flaky, retried once)")
      else
        summary+=("PASS  $name (${elapsed}s)")
      fi
      passed=$((passed + 1))
      record_attempt "$name" "$attempt" "passed" "none" "" "$artifact_dir" "$elapsed"
      break
    fi

    cause=$(grep '^live: ' "$log" 2>/dev/null | grep -v '^live: failure context$' | grep -v '^live: artifacts:' | tail -n 1 || true)
    classification="unknown"
    failure_file="$artifact_dir/failure.json"
    if [[ -n "$node_bin" && -f "$failure_file" ]]; then
      classification=$("$node_bin" --experimental-strip-types "$flake_cli" classify --file "$failure_file" 2>/dev/null || printf 'unknown')
    fi

    quarantine_info=$(quarantine_for "$name")
    quarantined_flag=0
    [[ -n "$quarantine_info" ]] && quarantined_flag=1
    # Classification comes first: the pure decision refuses to retry or
    # quarantine a product, unknown, or infrastructure failure. A missing
    # decision fails closed rather than looking green.
    decision=""
    if [[ -n "$node_bin" ]]; then
      decision=$("$node_bin" --experimental-strip-types "$flake_cli" decide \
        --classification "$classification" --attempt "$attempt" --quarantined "$quarantined_flag" 2>/dev/null || true)
    fi
    decision_outcome="${decision%% *}"
    decision_reason="${decision#* }"

    case "$decision_outcome" in
      retry)
        record_attempt "$name" "$attempt" "failed" "$classification" "${cause:-unknown failure}" "$artifact_dir" "$elapsed"
        printf 'live-matrix: %s: RETRY (attempt %s; %s)\n' "$name" "$attempt" "$decision_reason" >&2
        retries=$((retries + 1))
        attempt=$((attempt + 1))
        continue
        ;;
      quarantine)
        issue=$(cut -f1 <<<"$quarantine_info")
        owner=$(cut -f2 <<<"$quarantine_info")
        printf 'live-matrix: %s: QUARANTINE (%ss; issue=%s owner=%s)\n' "$name" "$elapsed" "$issue" "$owner" >&2
        summary+=("QUARANTINE $name (${elapsed}s; issue=$issue owner=$owner)")
        quarantined=$((quarantined + 1))
        record_attempt "$name" "$attempt" "quarantined" "$classification" "${cause:-unknown failure}" "$artifact_dir" "$elapsed"
        break
        ;;
      fail) ;;
      *)
        printf 'live-matrix: %s: no decision (%s); failing closed\n' "$name" "${decision_reason:-decision unavailable}" >&2
        ;;
    esac

    record_attempt "$name" "$attempt" "failed" "$classification" "${cause:-unknown failure}" "$artifact_dir" "$elapsed"
    printf 'live-matrix: %s: FAIL (%ss)\n' "$name" "$elapsed" >&2
    if [[ -n "$cause" ]]; then
      summary+=("FAIL  $name (${elapsed}s): $cause")
    else
      summary+=("FAIL  $name (${elapsed}s)")
    fi
    failed=$((failed + 1))
    failed_status=$scenario_status
    for ((j = i + 1; j < ${#scenarios[@]}; j++)); do
      summary+=("NOT RUN ${scenarios[j]}")
      not_run=$((not_run + 1))
    done
    break 2
  done
done

total=$((SECONDS - run_start))
printf 'live-matrix: summary\n'
for line in "${summary[@]}"; do
  printf 'live-matrix:   %s\n' "$line"
done
printf 'live-matrix: %d passed, %d failed, %d skipped, %d quarantined, %d not run, %d retries in %ss\n' \
  "$passed" "$failed" "$skipped" "$quarantined" "$not_run" "$retries" "$total"

print_flake_report

if (( failed > 0 )); then
  exit "${failed_status:-1}"
fi
exit 0
