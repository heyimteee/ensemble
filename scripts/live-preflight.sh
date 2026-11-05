#!/usr/bin/env bash
set -uo pipefail

# Host-tool preflight for the live matrix. Resolves the same binaries as the
# scenarios and prints their versions before a suite runs.
#
#   bash scripts/live-preflight.sh        # fake + empty catalog tools
#   bash scripts/live-preflight.sh all    # also the real scenario's fd
#
# Local runs keep the skip contract: a missing tool prints a skip line and
# exits zero, exactly like a scenario. With ENSEMBLE_LIVE_REQUIRE=1 a missing
# tool is a failure, so CI cannot pass on a suite that never started.
#
# CI also pins the expected runtime versions:
#   ENSEMBLE_LIVE_EXPECT_NODE=26.12.1
#   ENSEMBLE_LIVE_EXPECT_OPENCODE=2.2.5
# A present-but-wrong version is always a failure, not a skip. Both versions
# are compared exactly after normalizing an optional tool-name prefix and `v`.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/lib/live-harness.sh"

usage() {
  echo "usage: bash scripts/live-preflight.sh [fake|all]" >&2
}

mode="${1:-fake}"
shift || true
if (( $# > 0 )); then
  usage
  exit 2
fi
case "$mode" in
  fake|all) ;;
  *)
    usage
    exit 2
    ;;
esac

live_require_runtime
live_require_node
if [[ "$mode" == "all" ]]; then
  command -v fd >/dev/null 2>&1 \
    || live_skip "fd is not installed or not on PATH (required by the real scenario)"
fi

node_version=$("$LIVE_NODE_BIN" --version 2>/dev/null) \
  || live_fail "node at $LIVE_NODE_BIN did not report a version"
opencode_version=$("$LIVE_OPENCODE_BIN" --version 2>/dev/null) \
  || live_fail "opencode at $LIVE_OPENCODE_BIN did not report a version"
tmux_version=$("$LIVE_TMUX_BIN" -V 2>/dev/null) \
  || live_fail "tmux at $LIVE_TMUX_BIN did not report a version"
fd_version=""
if [[ "$mode" == "all" ]]; then
  fd_version=$(fd --version 2>/dev/null) \
    || live_fail "fd did not report a version"
fi

normalize_version() {
  local value="$1"
  value="${value#opencode }"
  value="${value#v}"
  printf '%s\n' "$value"
}

if [[ -n "${ENSEMBLE_LIVE_EXPECT_NODE:-}" ]]; then
  expected=$(normalize_version "$ENSEMBLE_LIVE_EXPECT_NODE")
  actual=$(normalize_version "$node_version")
  [[ "$actual" == "$expected" ]] \
    || live_fail "expected Node $expected, found $node_version"
fi
if [[ -n "${ENSEMBLE_LIVE_EXPECT_OPENCODE:-}" ]]; then
  expected=$(normalize_version "$ENSEMBLE_LIVE_EXPECT_OPENCODE")
  actual=$(normalize_version "$opencode_version")
  [[ "$actual" == "$expected" ]] \
    || live_fail "expected OpenCode $expected, found $opencode_version"
fi

live_log "preflight: mode $mode"
live_log "preflight: node $node_version"
live_log "preflight: opencode $opencode_version"
live_log "preflight: $tmux_version"
if [[ "$mode" == "all" ]]; then
  live_log "preflight: $fd_version"
fi
live_log "preflight passed"
