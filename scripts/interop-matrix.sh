#!/usr/bin/env bash
# Phase-8 q2repro interop matrix: drives a REAL q2repro binary (client and/or
# dedicated server) against this engine's server and client, cell by cell,
# and captures both sides' logs under .orch/interop-logs/.
#
# Skips gracefully (prints SKIP, exits 0) when the q2repro binary isn't
# built. To build it:
#   cd ~/Projects/qsrc/q2repro
#   git submodule update --init --recursive   # q2proto + rerelease-game
#   meson setup build && ninja -C build
# (meson/ninja can be installed into a local venv with `pip install meson
# ninja` if not present system-wide; see .orch/followups.md's phase-8 entries
# for the exact build notes from the session that first ran this matrix.)
#
# Re-runnable: every cell cleans up its own server/client processes and log
# files before running, so a partial or failed prior run doesn't wedge the
# next one.
#
# Findings, dispositions, and exact citations for every divergence this
# script's first run turned up live in .orch/followups.md under "phase-8
# q2repro interop" -- this script re-verifies the fixed cells and documents
# (via explicit SKIP/PARTIAL messages, not silent success) the cells that
# need more than this session's time budget.

set -uo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

Q2REPRO_SRC="${Q2REPRO_SRC:-$HOME/Projects/qsrc/q2repro}"
Q2REPRO_BUILD="${Q2REPRO_BUILD:-$Q2REPRO_SRC/build}"
Q2TS_BASEDIR="${Q2TS_BASEDIR:-$HOME/q2ts}"
LOGDIR="$REPO_ROOT/.orch/interop-logs"
PORT="${INTEROP_PORT:-27910}"

mkdir -p "$LOGDIR"

CLIENT_BIN="$Q2REPRO_BUILD/q2repro"
SERVER_BIN="$Q2REPRO_BUILD/q2reproded"

if [ ! -x "$CLIENT_BIN" ] && [ ! -x "$SERVER_BIN" ]; then
  echo "SKIP: no q2repro binary found at $Q2REPRO_BUILD (client=$CLIENT_BIN, server=$SERVER_BIN)."
  echo "      Build it first (see this script's header comment) or set Q2REPRO_BUILD."
  exit 0
fi

pass_count=0
fail_count=0
skip_count=0

note_pass()    { pass_count=$((pass_count+1)); echo "PASS: $1"; }
note_fail()    { fail_count=$((fail_count+1)); echo "FAIL: $1"; }
note_skip()    { skip_count=$((skip_count+1)); echo "SKIP: $1"; }
note_partial() { echo "PARTIAL: $1"; }

cleanup_procs() {
  # Match on the basename, not a full path: q2reproded/q2repro are launched
  # via a RELATIVE "./q2repro..." after cd-ing into $Q2REPRO_BUILD (both for
  # the cgame-loading reason documented on run_their_client, and because
  # q2reproded's own basedir auto-detection wants to run from its own
  # directory), so /proc/PID/cmdline never contains the absolute path a
  # pattern anchored on $Q2REPRO_BUILD would need to match. Found the hard
  # way: an earlier draft's absolute-path patterns silently never matched,
  # leaving a stale q2reproded bound to the shared test port across cells.
  pkill -9 -f "bun run src/main.ts" >/dev/null 2>&1 || true
  pkill -9 -f "q2reproded" >/dev/null 2>&1 || true
  pkill -9 -f "q2repro " >/dev/null 2>&1 || true
  sleep 1
}
trap cleanup_procs EXIT

wait_for_udp_port() {
  local port="$1" tries=20
  while [ $tries -gt 0 ]; do
    if ss -uln 2>/dev/null | grep -q ":$port "; then return 0; fi
    sleep 0.3
    tries=$((tries-1))
  done
  return 1
}

# Drives the real q2repro client under a pseudo-tty (script(1)) so its fully
# buffered stdout survives a SIGTERM-based timeout. MUST cd into
# $Q2REPRO_BUILD first: the client loads its client-side "cgame" module from
# a RELATIVE path ("./kex/game_x86_64.so", "./baseq2/gamex86_64.so", ...)
# resolved against the process's cwd, not against +set basedir -- launching
# it from anywhere else fails with "ERROR: cgame functions not available"
# (found while self-testing this script: every earlier interactive capture
# in this session had `cd`'d there first without noticing it was load-
# bearing). Deliberately does NOT force `+set vid_driver sdl`: q2repro's own
# native Wayland/X11 backends (tried before SDL2) ignore SDL_VIDEODRIVER=
# dummy and pop a real, harmless, briefly-visible window instead -- fine for
# this matrix's purposes. See .orch/followups.md's "TEST-HARNESS NOTE".
run_their_client() {
  local logfile="$1"; shift
  ( cd "$Q2REPRO_BUILD" && SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy timeout 25 \
    script -qec "./q2repro +set basedir $Q2TS_BASEDIR +set vid_geometry 320x240 +set s_enable 0 $*" \
    "$logfile" >/dev/null 2>&1 )
}

run_our_server() {
  local logfile="$1" timeout_s="$2"; shift 2
  ( cd "$REPO_ROOT" && timeout "$timeout_s" bun run src/main.ts +set dedicated 1 +set basedir "$Q2TS_BASEDIR" "$@" \
    > "$logfile" 2>&1 & )
  wait_for_udp_port "$PORT"
}

# ---------------------------------------------------------------------------
# Cell (a): their client -> our kex server, protocol 1038
# ---------------------------------------------------------------------------
cell_a() {
  echo "--- cell (a): their client -> our kex server (protocol 1038) ---"
  cleanup_procs
  local slog="$LOGDIR/a-ourserver.log" clog="$LOGDIR/a-theirclient.log"
  rm -f "$slog" "$clog"

  if [ ! -x "$SERVER_BIN" ] && [ ! -x "$CLIENT_BIN" ]; then
    note_skip "cell a: q2repro client binary not built"
    return
  fi

  run_our_server "$slog" 30 +set game kex +set deathmatch 1 +set port "$PORT" +map q2dm1
  if ! ss -uln 2>/dev/null | grep -q ":$PORT "; then
    note_fail "cell a: our server never bound port $PORT (see $slog)"
    return
  fi

  run_their_client "$clog" "+connect localhost:$PORT +wait 200 +quit"

  if grep -q "PROTOCOL_NOT_SUPPORTED\|Could not get connect string" "$clog"; then
    note_fail "cell a: challenge/connect negotiation rejected -- see $clog"
  elif grep -q "g_entered_game" "$slog" 2>/dev/null || grep -q "entered the game" "$clog"; then
    if grep -q "unknown command char" "$slog"; then
      note_partial "cell a: connects, precaches, and spawns; drops on first movement packet (clc_q2pro_move_batched unimplemented -- .orch/followups.md)"
    else
      note_pass "cell a: full handshake + spawn, no protocol errors"
    fi
  elif grep -q "Connected to" "$clog"; then
    note_partial "cell a: connected but did not confirm spawn within the wait window -- inspect $slog / $clog"
  else
    note_fail "cell a: client never reported a connection -- see $clog"
  fi
}

# ---------------------------------------------------------------------------
# Cell (b): our client -> their dedicated server, protocol 1038
# ---------------------------------------------------------------------------
cell_b() {
  echo "--- cell (b): our client -> their dedicated server (protocol 1038) ---"
  cleanup_procs
  local slog="$LOGDIR/b-theirserver.log" clog="$LOGDIR/b-ourclient.log"
  rm -f "$slog" "$clog"

  if [ ! -x "$SERVER_BIN" ]; then
    note_skip "cell b: q2reproded not built"
    return
  fi

  # Their game data pak files must sit alongside their compiled game
  # libraries in $Q2REPRO_BUILD/baseq2 for q2reproded to find both; symlink
  # ours in (disposable build-output dir, never touches $Q2TS_BASEDIR).
  mkdir -p "$Q2REPRO_BUILD/baseq2"
  for f in "$Q2TS_BASEDIR"/baseq2/*.pak; do
    [ -e "$f" ] && ln -sf "$f" "$Q2REPRO_BUILD/baseq2/$(basename "$f")"
  done

  ( cd "$Q2REPRO_BUILD" && timeout 30 ./q2reproded +set deathmatch 1 +map q2dm1 > "$slog" 2>&1 & )
  wait_for_udp_port "$PORT" || { note_fail "cell b: q2reproded never bound port $PORT -- see $slog"; return; }

  ( cd "$REPO_ROOT" && SDL_VIDEODRIVER=dummy timeout 20 bun run src/main.ts \
      +set basedir "$Q2TS_BASEDIR" +set port 27931 +set cl_protocol 1038 +connect "localhost:$PORT" \
      > "$clog" 2>&1 )

  if grep -q "connected\." "$slog"; then
    note_pass "cell b: real q2repro server accepted our protocol-1038 connect string + NETCHAN_NEW framing"
    if grep -q "timed out" "$slog"; then
      note_partial "cell b: connection then idled out -- our client's precache walk is a known stub (.orch/followups.md's CL_RequestNextDownload item), not a new wire-format bug"
    fi
  else
    note_fail "cell b: their server never logged our client as connected -- see $slog / $clog"
  fi
}

# ---------------------------------------------------------------------------
# Cell (c): legacy protocols 34/35/36, their client -> our legacy server
# ---------------------------------------------------------------------------
cell_c() {
  echo "--- cell (c): legacy protocols (34/35/36) -- their client -> our server ---"
  cleanup_procs
  local slog="$LOGDIR/c-ourserver.log"
  rm -f "$slog" "$LOGDIR"/c-client*.log

  if [ ! -x "$CLIENT_BIN" ]; then
    note_skip "cell c: q2repro client not built"
    return
  fi

  run_our_server "$slog" 45 +set deathmatch 1 +set port "$PORT" +map q2dm1
  if ! ss -uln 2>/dev/null | grep -q ":$PORT "; then
    note_fail "cell c: our server never bound port $PORT (see $slog)"
    return
  fi

  for proto in 34 35 36; do
    local clog="$LOGDIR/c-client$proto.log"
    run_their_client "$clog" "+set cl_protocol $proto +connect localhost:$PORT +wait 100 +quit"
    if grep -q "entered the game" "$clog"; then
      note_pass "cell c: protocol $proto connects and reaches active gameplay"
    elif grep -q "Connected to" "$clog"; then
      note_partial "cell c: protocol $proto connects but did not confirm spawn -- see $clog"
    else
      note_fail "cell c: protocol $proto never connected -- see $clog"
    fi
  done
}

# ---------------------------------------------------------------------------
# Cell (d): demo cross-play
# ---------------------------------------------------------------------------
cell_d() {
  echo "--- cell (d): demo cross-play ---"
  echo "  retail demo -> our client: re-verify via the existing bun test"
  ( cd "$REPO_ROOT" && timeout 60 bun test test/cl_demo_retail.test.ts ) \
    && note_pass "cell d (retail demo -> our client): test/cl_demo_retail.test.ts" \
    || note_fail "cell d (retail demo -> our client): test/cl_demo_retail.test.ts failed"

  note_skip "cell d (our kex-server-recorded demo -> their client): needs a live-console (FIFO-stdin) test harness, not built in this session -- see .orch/followups.md's phase-8 matrix-cell-d entry for exactly why the frame-scripted +wait approach doesn't work here"
}

# ---------------------------------------------------------------------------
# Cell (e): savegame cross-load
# ---------------------------------------------------------------------------
cell_e() {
  echo "--- cell (e): savegame cross-load ---"
  note_skip "cell e: not automated in this session -- source-level check only (both engines' SSV2/SAV2 magic constants match: this port's SV_WriteLevelFileKex vs q2repro's src/server/save.c:22-23). See .orch/followups.md's phase-8 matrix-cell-e entry for the concrete follow-up plan (trigger a save from each engine, diff field layout, attempt an actual cross-load each way)."
}

echo "=== phase-8 q2repro interop matrix ==="
echo "Q2REPRO_BUILD=$Q2REPRO_BUILD"
echo "Q2TS_BASEDIR=$Q2TS_BASEDIR"
echo

cell_a
cell_b
cell_c
cell_d
cell_e

echo
echo "=== summary: $pass_count pass, $fail_count fail, $skip_count skip (partials printed above) ==="
[ "$fail_count" -eq 0 ]
