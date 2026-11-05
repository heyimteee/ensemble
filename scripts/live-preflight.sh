#!/usr/bin/env bash
set -uo pipefail

# Host-tool preflight for the live matrix. Resolves the same binaries as the
# scenarios and prints their versions before a suite runs.
#
# Local runs keep the skip contract: a missing tool prints a skip line and
# exits zero, exactly like a scenario. With ENSEMBLE_LIVE_REQUIRE=1 a missing
# tool is a failure, so CI cannot pass on a suite that never started.
#
# CI also pins the expected runtime versions:
#   ENSEMBLE_LIVE_EXPECT_NODE=26.12.1
#   ENSEMBLE_LIVE_EXPECT_OPENCODE=2.2.5
# A present-but-wrong version is always a failure, not a skip.

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
source "$SCRIPT_DIR/lib/live-harness.sh"

live_require_runtime
live_require_node
command -v fd >/dev/null 2>&1 \
  || live_skip "fd is not installed or not on PATH (required by the real scenario)"

node_version=$("$LIVE_NODE_BIN" --version 2>/dev/null) \
  || live_fail "node at $LIVE_NODE_BIN did not report a version"
opencode_version=$("$LIVE_OPENCODE_BIN" --version 2>/dev/null) \
  || live_fail "opencode at $LIVE_OPENCODE_BIN did not report a version"
tmux_version=$("$LIVE_TMUX_BIN" -V 2>/dev/null) \
  || live_fail "tmux at $LIVE_TMUX_BIN did not report a version"
fd_version=$(fd --version 2>/dev/null) \
  || live_fail "fd did not report a version"

if [[ -n "${ENSEMBLE_LIVE_EXPECT_NODE:-}" ]]; then
  expected="v${ENSEMBLE_LIVE_EXPECT_NODE#v}"
  [[ "$node_version" == "$expected" ]] \
    || live_fail "expected Node $expected, found $node_version"
fi
if [[ -n "${ENSEMBLE_LIVE_EXPECT_OPENCODE:-}" ]]; then
  expected="${ENSEMBLE_LIVE_EXPECT_OPENCODE#v}"
  [[ "$opencode_version" == *"$expected"* ]] \
    || live_fail "expected OpenCode $expected, found $opencode_version"
fi

live_log "preflight: node $node_version"
live_log "preflight: opencode $opencode_version"
live_log "preflight: $tmux_version"
live_log "preflight: $fd_version"
live_log "preflight passed"
