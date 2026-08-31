#!/usr/bin/env bash
# Self-play matrix. Foreign-engine (q2repro-driven) cells are REMOVED by
# owner order (2026-08-30) -- their function bodies remain below, disabled
# with early SKIP returns, for archaeology only. Historically: drove a REAL
# q2repro binary (client and/or
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

# `grep -c` prints "0" AND exits 1 when a readable file has no matches, so the
# usual `$(grep -c ... || echo 0)` idiom yields the two-line string "0\n0" and
# every later $(( )) on it dies with "arithmetic syntax error". Print nothing
# on failure and substitute a single 0 instead.
count_matches() { # pattern file
  local n
  n=$(grep -acE "$1" "$2" 2>/dev/null) || true
  [ -n "$n" ] || n=0
  echo "$n"
}

# Matches a move diagnostic whose applied usercmd carried real (nonzero)
# forward input -- proof the held movement keys reached ge.ClientThink, not
# just that move packets flowed.
MOVING_RE=' fwd=-?[1-9][0-9]* '

# EVERY launch of the real q2repro binary goes through this wrapper.
#
# q2repro's vid_drivers try its native Wayland and X11 backends BEFORE SDL2,
# and those backends ignore SDL_VIDEODRIVER=dummy entirely -- so a bare launch
# pops a real game window onto whoever is sitting at the machine. `xvfb-run -a`
# gives it a private virtual X server instead ("-a" picks a free display
# number, so concurrent cells cannot collide). WAYLAND_DISPLAY must be cleared
# in the same environment or the Wayland backend connects straight to the real
# compositor and never looks at the virtual X server at all.
#
# `timeout` sits INSIDE xvfb-run so the wall-clock kill lands on the game
# process while xvfb-run still gets to tear its Xvfb down; putting timeout
# outside would kill xvfb-run and orphan both Xvfb and the game.
Q2REPRO_HEADLESS=(xvfb-run -a env -u WAYLAND_DISPLAY SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy)

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
  pkill -9 -f "q2rets_selftest" >/dev/null 2>&1 || true
  sleep 1
}

# Temp basedir mirrors made by make_play_basedir (symlinks only, plus one
# generated cfg and whatever config.cfg the engine wrote there).
cleanup_playbases() {
  local d
  for d in ${PLAY_BASEDIRS+"${PLAY_BASEDIRS[@]}"}; do
    case "$d" in /tmp/*) rm -rf "$d" ;; esac
  done
}

cleanup_all() { cleanup_procs; cleanup_playbases; }
trap cleanup_all EXIT

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
# bearing). Runs under Q2REPRO_HEADLESS -- q2repro's own native Wayland/X11
# backends are tried before SDL2 and ignore SDL_VIDEODRIVER=dummy, so without
# the xvfb-run wrapper it opens a real window on the desktop. See
# .orch/followups.md's "TEST-HARNESS NOTE".
run_their_client() {
  local logfile="$1"; shift
  ( cd "$Q2REPRO_BUILD" && "${Q2REPRO_HEADLESS[@]}" timeout 25 \
    script -qec "./q2repro +set basedir $Q2TS_BASEDIR +set vid_geometry 320x240 +set s_enable 0 $*" \
    "$logfile" >/dev/null 2>&1 )
}

run_our_server() {
  local logfile="$1" timeout_s="$2"; shift 2
  ( cd "$REPO_ROOT" && timeout "$timeout_s" bun run src/main.ts +set dedicated 1 +set basedir "$Q2TS_BASEDIR" "$@" \
    > "$logfile" 2>&1 & )
  wait_for_udp_port "$PORT"
}

# Sustained-play variant of run_their_client: takes an explicit wall-clock
# duration (via bash's own `timeout`, which -- unlike the client's own
# `+wait N` console command -- is real elapsed time regardless of the
# client's actual frame rate; see .orch/followups.md's TEST-HARNESS NOTE on
# why a frame-scripted `+wait` cannot be trusted to mean "N real seconds").
# Callers pass movement commands (`+forward`, `+moveleft`, ...) with NO
# trailing `+quit` -- the process runs for the FULL duration until this
# `timeout` SIGTERMs it, continuously connected and moving the whole time.
#
# Runs against a MIRRORED basedir carrying selfplay.cfg (see make_play_basedir)
# and passes `+exec selfplay.cfg`, because `+forward` on the command line does
# NOT hold a key in either engine -- id's Com_AddLateCommands strips the '+'
# and both print `Unknown command "forward"`.
THEIR_PLAY_BASE=""
their_play_base() {
  [ -n "$THEIR_PLAY_BASE" ] || THEIR_PLAY_BASE="$(make_play_basedir "$Q2TS_BASEDIR" baseq2 "$FOREIGN_DRIVE_CFG")"
  echo "$THEIR_PLAY_BASE"
}

run_their_client_sustained() {
  local logfile="$1" duration="$2"; shift 2
  local base
  base="$(their_play_base)"
  ( cd "$Q2REPRO_BUILD" && "${Q2REPRO_HEADLESS[@]}" timeout "$duration" \
    script -qec "./q2repro +set basedir $base +set vid_geometry 320x240 +set s_enable 0 +exec $FOREIGN_DRIVE_CFG $*" \
    "$logfile" >/dev/null 2>&1 )
}

# ---------------------------------------------------------------------------
# Movement without a console: both engines inherit id's Com_AddLateCommands,
# which STRIPS the leading '+' from a command-line argument -- so `+forward` on
# the command line becomes the command `forward`, which does not exist. Both
# engines print `Unknown command "forward"` and hold no key. (Confirmed in
# .orch/interop-logs/a-theirclient.log from the run before this helper existed:
# the real q2repro client rejected it exactly the same way ours did, so every
# earlier "sustained play with +forward +moveleft" cell was in fact sustained
# play with IDLE input. The packet counts were real; the movement was not.)
#
# A cfg file is the fix: `exec` runs each line as a real command, so `+forward`
# inside a cfg reaches Cmd_AddCommand("+forward", IN_ForwardDown). The cfg has
# to live inside a game directory on the search path, and neither engine may
# be pointed at the user's real game data for something we write into -- so
# mirror the basedir into a temp tree of symlinks and drop the cfg in there.
#
# config.cfg is deliberately NOT symlinked through: the engine rewrites it on
# shutdown, and writing through a symlink would edit the user's real file.
#
# Note for anyone extending this: late-command ARGUMENTS must not contain '-'
# (the same id parser stops a command at the next '+' or '-'), which is why the
# cfg is named `selfplay.cfg` and is exec'd by bare name rather than by path.
# `+set` is unaffected -- Cbuf_AddEarlyCommands walks argv directly.
PLAY_BASEDIRS=()
make_play_basedir() {
  local real="$1" gamedir="$2" cfgname="$3" dest e
  dest="$(mktemp -d)"
  PLAY_BASEDIRS+=("$dest")
  for e in "$real"/*; do
    [ -e "$e" ] || continue
    ln -sfn "$e" "$dest/$(basename "$e")"
  done
  rm -f "$dest/$gamedir"
  mkdir -p "$dest/$gamedir"
  for e in "$real/$gamedir"/*; do
    [ -e "$e" ] || continue
    [ "$(basename "$e")" = "config.cfg" ] && continue
    ln -sfn "$e" "$dest/$gamedir/$(basename "$e")"
  done
  printf '+forward\n+moveleft\n' > "$dest/$gamedir/$cfgname"
  echo "$dest"
}

# Our own engine, compiled the way it actually ships, rather than run through
# `bun run src/main.ts`. Built once per matrix run and reused by every
# self-play cell.
OUR_BIN=""
build_our_binary() {
  [ -n "$OUR_BIN" ] && return 0
  local out="$LOGDIR/q2rets_selftest"
  if ! ( cd "$REPO_ROOT" && timeout 300 bun build --compile --target=bun-linux-x64 src/main.ts \
           --outfile "$out" > "$LOGDIR/build.log" 2>&1 ); then
    return 1
  fi
  OUR_BIN="$out"
  return 0
}

cleanup_selfplay() {
  pkill -9 -f "q2rets_selftest" >/dev/null 2>&1 || true
  sleep 1
}

# Shared body for the two self-play cells: OUR compiled binary on both ends.
# $1 label, $2 real basedir, $3 gamedir, $4 extra server/client args
# ("+set game kex" or ""), $5 protocol, $6 map, $7 play seconds.
run_selfplay_cell() {
  local label="$1" real_base="$2" gamedir="$3" gameargs="$4" proto="$5" mapname="$6" secs="$7"
  local slog="$LOGDIR/$label-server.log" clog="$LOGDIR/$label-client.log"
  rm -f "$slog" "$clog"
  cleanup_selfplay

  if [ ! -d "$real_base/$gamedir" ]; then
    note_skip "cell $label: game data not present at $real_base/$gamedir"
    return
  fi
  if ! build_our_binary; then
    note_fail "cell $label: could not compile our engine (see $LOGDIR/build.log)"
    return
  fi

  local base
  base="$(make_play_basedir "$real_base" "$gamedir" "$SELFPLAY_CFG")"

  ( timeout $((secs + 30)) "$OUR_BIN" +set dedicated 1 +set basedir "$base" $gameargs \
      +set deathmatch 1 +set developer 1 +set port "$PORT" +map "$mapname" > "$slog" 2>&1 & )
  wait_for_udp_port "$PORT"
  if ! ss -uln 2>/dev/null | grep -q ":$PORT "; then
    note_fail "cell $label: our server never bound port $PORT (see $slog)"
    return
  fi

  local t0 t1 elapsed
  t0=$(date +%s)
  SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy timeout "$secs" \
    script -qec "$OUR_BIN +set basedir $base $gameargs +set s_initsound 0 +set cl_protocol $proto +exec $SELFPLAY_CFG +connect 127.0.0.1:$PORT" \
    "$clog" >/dev/null 2>&1
  t1=$(date +%s)
  elapsed=$((t1 - t0))

  # Both move paths count: our client writes the non-batched clc_move at every
  # protocol (only the DECODE side of clc_q2pro_move_batched is implemented in
  # this port), so a self-play session exercises SV_OldClientExecuteMove even
  # at 1038.
  local moves moving
  moves=$(count_matches "SV_(Old|New)ClientExecuteMove" "$slog")
  # Real movement, not just packet flow: the diagnostic carries the applied
  # usercmd's forwardmove/sidemove, so a nonzero one proves selfplay.cfg's
  # held keys actually reached ge.ClientThink.
  moving=$(count_matches "SV_(Old|New)ClientExecuteMove.*$MOVING_RE" "$slog")

  if grep -aq "unknown command char\|badread\|Failed command checksum" "$slog"; then
    note_fail "cell $label: server rejected or desynchronized our own client's stream -- see $slog"
  elif grep -aq "entered the game" "$slog" && [ "$elapsed" -ge 10 ] && [ "$moves" -gt 100 ] && [ "$moving" -gt 50 ]; then
    note_pass "cell $label: our compiled binary self-play -- full handshake + spawn + ${elapsed}s sustained play, $moves move packets applied ($moving carrying real nonzero movement), zero drops -- see $slog"
  elif grep -aq "entered the game" "$slog"; then
    note_partial "cell $label: spawned, but sustained-play evidence is weak (elapsed=${elapsed}s, moves=$moves, moving=$moving) -- see $slog / $clog"
  elif grep -aq "connected" "$slog"; then
    note_partial "cell $label: our client connected but never spawned -- see $slog / $clog"
  else
    note_fail "cell $label: our client never connected to our own server -- see $slog / $clog"
  fi
}

# ---------------------------------------------------------------------------
# Cell (f): SELF-PLAY, kex family (protocol 1038) -- our binary on both ends
# ---------------------------------------------------------------------------
# Everything else in this matrix pairs our engine with q2repro's. Nothing had
# ever driven OUR client through a live session, and the gates ran
# `bun run src/main.ts` rather than the artifact that actually ships.
cell_f() {
  echo "--- cell (f): self-play, kex family (protocol 1038) -- our compiled binary both ends ---"
  run_selfplay_cell f "${Q2RETS_BASEDIR:-$HOME/q2rets/rerelease}" baseq2 "+set game kex" 1038 base1 15
}

# ---------------------------------------------------------------------------
# Cell (g): SELF-PLAY, legacy family (protocol 34)
# ---------------------------------------------------------------------------
cell_g() {
  echo "--- cell (g): self-play, legacy family (protocol 34) -- our compiled binary both ends ---"
  run_selfplay_cell g "$Q2TS_BASEDIR" baseq2 "" 34 q2dm1 15
}

# ---------------------------------------------------------------------------
# Cell (a): their client -> our kex server, protocol 1038
# ---------------------------------------------------------------------------
cell_a() {
  # Foreign-engine cell removed by owner order (2026-08-30): the q2repro
  # binary is not launched for any purpose. Wire correctness is covered by
  # byte-vector tests against reference sources plus self-play cells f/g.
  echo "cell a: SKIP (foreign-engine cells removed by owner order)"
  skip_count=$((skip_count+1))
  return 0
  echo "--- cell (a): their client -> our kex server (protocol 1038) -- sustained play ---"
  cleanup_procs
  local slog="$LOGDIR/a-ourserver.log" clog="$LOGDIR/a-theirclient.log"
  rm -f "$slog" "$clog"

  if [ ! -x "$SERVER_BIN" ] && [ ! -x "$CLIENT_BIN" ]; then
    note_skip "cell a: q2repro client binary not built"
    return
  fi

  local play_seconds=15
  # +set developer 1: turns on Com_DPrintf, including sv_user.ts's
  # SV_NewClientExecuteMove diagnostic line (phase-8 unit) -- our only
  # evidence, short of packet-capture, that batched-move packets are being
  # decoded and applied CONTINUOUSLY over the session, not just once.
  run_our_server "$slog" $((play_seconds + 20)) +set game kex +set deathmatch 1 +set developer 1 +set port "$PORT" +map q2dm1
  if ! ss -uln 2>/dev/null | grep -q ":$PORT "; then
    note_fail "cell a: our server never bound port $PORT (see $slog)"
    return
  fi

  # Movement comes from selfplay.cfg (exec'd by run_their_client_sustained),
  # which holds +forward/+moveleft down for the whole session so the client
  # generates continuous NONZERO-forwardmove/-sidemove batched-move traffic
  # instead of idle zero-input keepalive packets -- exercises the CM_FORWARD/
  # CM_SIDE decode paths under real, sustained play, not just a connect.
  local t0 t1 elapsed
  t0=$(date +%s)
  run_their_client_sustained "$clog" "$play_seconds" "+connect localhost:$PORT"
  t1=$(date +%s)
  elapsed=$((t1 - t0))

  local move_lines moving_lines
  move_lines=$(count_matches "SV_NewClientExecuteMove" "$slog")
  moving_lines=$(count_matches "SV_NewClientExecuteMove.*$MOVING_RE" "$slog")

  if grep -q "PROTOCOL_NOT_SUPPORTED\|Could not get connect string" "$clog"; then
    note_fail "cell a: challenge/connect negotiation rejected -- see $clog"
  elif grep -q "unknown command char" "$slog"; then
    note_fail "cell a: server still rejects a batched-move opcode -- see $slog"
  elif { grep -q "g_entered_game" "$slog" 2>/dev/null || grep -q "entered the game" "$clog"; } && [ "$elapsed" -ge 10 ] && [ "$move_lines" -gt 5 ] && [ "$moving_lines" -gt 5 ]; then
    note_pass "cell a: full handshake + spawn + ${elapsed}s sustained connected play, $move_lines batched-move packets decoded and applied (SV_NewClientExecuteMove), $moving_lines of them carrying real nonzero movement, zero drops -- see $slog"
  elif grep -q "g_entered_game" "$slog" 2>/dev/null || grep -q "entered the game" "$clog"; then
    note_partial "cell a: spawned, but sustained-play evidence is weak (elapsed=${elapsed}s, move_lines=$move_lines, moving=$moving_lines) -- see $slog / $clog"
  elif grep -q "Connected to" "$clog"; then
    note_partial "cell a: connected but did not confirm spawn within the play window -- inspect $slog / $clog"
  else
    note_fail "cell a: client never reported a connection -- see $clog"
  fi
}

# ---------------------------------------------------------------------------
# Cell (b): our client -> their dedicated server, protocol 1038
# ---------------------------------------------------------------------------
cell_b() {
  # Foreign-engine cell removed by owner order (2026-08-30): the q2repro
  # binary is not launched for any purpose. Wire correctness is covered by
  # byte-vector tests against reference sources plus self-play cells f/g.
  echo "cell b: SKIP (foreign-engine cells removed by owner order)"
  skip_count=$((skip_count+1))
  return 0
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

  ( cd "$Q2REPRO_BUILD" && "${Q2REPRO_HEADLESS[@]}" timeout 30 ./q2reproded +set deathmatch 1 +map q2dm1 > "$slog" 2>&1 & )
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
  # Foreign-engine cell removed by owner order (2026-08-30): the q2repro
  # binary is not launched for any purpose. Wire correctness is covered by
  # byte-vector tests against reference sources plus self-play cells f/g.
  echo "cell c: SKIP (foreign-engine cells removed by owner order)"
  skip_count=$((skip_count+1))
  return 0
  echo "--- cell (c): legacy protocols (34/35/36) -- their client -> our server ---"
  cleanup_procs
  local slog="$LOGDIR/c-ourserver.log"
  rm -f "$slog" "$LOGDIR"/c-client*.log

  if [ ! -x "$CLIENT_BIN" ]; then
    note_skip "cell c: q2repro client not built"
    return
  fi

  # Three sustained sessions now run against this one server (34, 35, 36), so
  # it has to outlive all of them plus startup and the gaps between clients.
  local play_seconds=15
  run_our_server "$slog" $((play_seconds * 3 + 40)) +set deathmatch 1 +set developer 1 +set port "$PORT" +map q2dm1
  if ! ss -uln 2>/dev/null | grep -q ":$PORT "; then
    note_fail "cell c: our server never bound port $PORT (see $slog)"
    return
  fi

  # Protocols 34 and 35 both drive the non-batched clc_move path (R1Q2 has no
  # batched-move opcode at all -- q2proto_proto_r1q2.c:1415-1450's
  # r1q2_server_read dispatches only nop/move/userinfo/stringcmd/setting), so
  # both are gated the SAME sustained-play way cell (a) and protocol 36 are:
  # real wall-clock seconds of continuous movement, counted server-side via
  # sv_user.ts's SV_OldClientExecuteMove diagnostic. Protocol 35 used to
  # connect and never spawn; see .orch/followups.md's protocol-35 entry and
  # net_chan.ts's NETCHAN_NEW doc comment for the qport-width root cause.
  for proto in 34 35; do
    local clog="$LOGDIR/c-client$proto.log"
    # All three sessions share one server log, so count only THIS protocol's
    # own moves by differencing against the running total before it started.
    local t0p t1p elapsedp movesp moves_before moves_after moving_before moving_after movingp
    moves_before=$(count_matches "SV_OldClientExecuteMove" "$slog")
    moving_before=$(count_matches "SV_OldClientExecuteMove.*$MOVING_RE" "$slog")
    t0p=$(date +%s)
    run_their_client_sustained "$clog" "$play_seconds" "+set cl_protocol $proto +connect localhost:$PORT"
    t1p=$(date +%s)
    elapsedp=$((t1p - t0p))
    moves_after=$(count_matches "SV_OldClientExecuteMove" "$slog")
    moving_after=$(count_matches "SV_OldClientExecuteMove.*$MOVING_RE" "$slog")
    movesp=$((moves_after - moves_before))
    movingp=$((moving_after - moving_before))

    if grep -q "unknown command char" "$slog"; then
      note_fail "cell c: protocol $proto -- server rejected a client command opcode -- see $slog"
    elif grep -q "badread\|Failed command checksum" "$slog"; then
      note_fail "cell c: protocol $proto -- client message desynchronized (badread/checksum) -- see $slog"
    elif grep -q "entered the game" "$clog" && [ "$elapsedp" -ge 10 ] && [ "$movesp" -gt 5 ] && [ "$movingp" -gt 5 ]; then
      note_pass "cell c: protocol $proto -- full handshake + spawn + ${elapsedp}s sustained connected play, $movesp clc_move packets decoded and applied (SV_OldClientExecuteMove), $movingp of them carrying real nonzero movement, zero drops -- see $slog"
    elif grep -q "entered the game" "$clog"; then
      note_partial "cell c: protocol $proto -- spawned, but sustained-play evidence is weak (elapsed=${elapsedp}s, moves=$movesp, moving=$movingp) -- see $slog / $clog"
    elif grep -q "Connected to" "$clog"; then
      note_partial "cell c: protocol $proto connects but did not confirm spawn -- see $clog"
    else
      note_fail "cell c: protocol $proto never connected -- see $clog"
    fi
  done

  # Protocol 36 (Q2PRO) re-verified the SAME way as cell (a): sustained real
  # wall-clock play with continuous movement, not just a connect-and-quit --
  # this is the protocol that hit the identical clc_q2pro_move_batched gap
  # cell (a) hit under 1038 (.orch/followups.md's phase-8 ledger).
  local clog36="$LOGDIR/c-client36.log"
  local t0 t1 elapsed move_lines moving36
  t0=$(date +%s)
  run_their_client_sustained "$clog36" "$play_seconds" "+set cl_protocol 36 +connect localhost:$PORT"
  t1=$(date +%s)
  elapsed=$((t1 - t0))
  move_lines=$(count_matches "SV_NewClientExecuteMove" "$slog")
  moving36=$(count_matches "SV_NewClientExecuteMove.*$MOVING_RE" "$slog")

  if grep -q "unknown command char" "$slog"; then
    note_fail "cell c: protocol 36 -- server still rejects a batched-move opcode -- see $slog"
  elif grep -q "entered the game" "$clog36" && [ "$elapsed" -ge 10 ] && [ "$move_lines" -gt 5 ] && [ "$moving36" -gt 5 ]; then
    note_pass "cell c: protocol 36 -- full handshake + spawn + ${elapsed}s sustained connected play, $move_lines batched-move packets decoded and applied, $moving36 of them carrying real nonzero movement, zero drops -- see $slog"
  elif grep -q "entered the game" "$clog36"; then
    note_partial "cell c: protocol 36 -- spawned, but sustained-play evidence is weak (elapsed=${elapsed}s, move_lines=$move_lines, moving=$moving36) -- see $slog / $clog36"
  elif grep -q "Connected to" "$clog36"; then
    note_partial "cell c: protocol 36 connects but did not confirm spawn -- see $clog36"
  else
    note_fail "cell c: protocol 36 never connected -- see $clog36"
  fi
}

# ---------------------------------------------------------------------------
# Cell (d): demo cross-play
# ---------------------------------------------------------------------------
cell_d() {
  # Foreign-engine cell removed by owner order (2026-08-30): the q2repro
  # binary is not launched for any purpose. Wire correctness is covered by
  # byte-vector tests against reference sources plus self-play cells f/g.
  echo "cell d: SKIP (foreign-engine cells removed by owner order)"
  skip_count=$((skip_count+1))
  return 0
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
  # Foreign-engine cell removed by owner order (2026-08-30): the q2repro
  # binary is not launched for any purpose. Wire correctness is covered by
  # byte-vector tests against reference sources plus self-play cells f/g.
  echo "cell e: SKIP (foreign-engine cells removed by owner order)"
  skip_count=$((skip_count+1))
  return 0
  echo "--- cell (e): savegame cross-load ---"
  note_skip "cell e: not automated in this session -- source-level check only (both engines' SSV2/SAV2 magic constants match: this port's SV_WriteLevelFileKex vs q2repro's src/server/save.c:22-23). See .orch/followups.md's phase-8 matrix-cell-e entry for the concrete follow-up plan (trigger a save from each engine, diff field layout, attempt an actual cross-load each way)."
}

# ---------------------------------------------------------------------------
# Cell (h): UDP download responder -- their client downloads from our server
# ---------------------------------------------------------------------------
# Every earlier capture of the download path was inconclusive because the real
# q2repro client only ever asked for files that are ABSENT from this
# rerelease-era data set (classic players/male/*.wav, tris.md2, tags/*), so
# every request legitimately came back FAIL and the responder was never
# actually exercised. This cell removes that confound by giving the SERVER
# loose files the CLIENT provably does not have (split basedirs, paks
# symlinked into both, custom skin files only on the server side) and then
# byte-comparing what landed on the client. Deliberately >1024 bytes so
# SV_NextDownload_f's chunk loop runs many times rather than once.
cell_h() {
  # Foreign-engine cell removed by owner order (2026-08-30): the q2repro
  # binary is not launched for any purpose. Wire correctness is covered by
  # byte-vector tests against reference sources plus self-play cells f/g.
  echo "cell h: SKIP (foreign-engine cells removed by owner order)"
  skip_count=$((skip_count+1))
  return 0
  echo "--- cell (h): UDP download responder -- their client <- our server ---"
  cleanup_procs

  if [ ! -x "$CLIENT_BIN" ]; then
    note_skip "cell h: q2repro client not built"
    return
  fi

  local work="$LOGDIR/h-work"
  local srv="$work/srv" cli="$work/cli"
  local slog="$LOGDIR/h-ourserver.log" clog="$LOGDIR/h-theirclient.log"
  rm -rf "$work"; rm -f "$slog" "$clog"
  mkdir -p "$srv/baseq2" "$cli/baseq2/players/male"
  local f
  for f in "$Q2TS_BASEDIR"/baseq2/*.pak; do
    [ -e "$f" ] || continue
    ln -sf "$f" "$srv/baseq2/$(basename "$f")"
    ln -sf "$f" "$cli/baseq2/$(basename "$f")"
  done
  rmdir "$cli/baseq2/players/male" "$cli/baseq2/players" 2>/dev/null

  mkdir -p "$srv/baseq2/players/male"
  head -c 40000 /dev/urandom > "$srv/baseq2/players/male/custom.pcx"
  head -c 9000  /dev/urandom > "$srv/baseq2/players/male/custom_i.pcx"

  ( cd "$REPO_ROOT" && timeout 45 bun run src/main.ts +set dedicated 1 +set basedir "$srv" \
      +set deathmatch 1 +set developer 1 +set port "$PORT" +map q2dm1 > "$slog" 2>&1 & )
  wait_for_udp_port "$PORT"
  if ! ss -uln 2>/dev/null | grep -q ":$PORT "; then
    note_fail "cell h: our server never bound port $PORT (see $slog)"
    return
  fi

  # `+set skin male/custom` makes the server publish a CS_PLAYERSKINS
  # configstring naming files only the server has, so the client's precache
  # walk must fetch them over UDP.
  ( cd "$Q2REPRO_BUILD" && "${Q2REPRO_HEADLESS[@]}" timeout 20 \
      script -qec "./q2repro +set basedir $cli +set vid_geometry 320x240 +set s_enable 0 +set skin male/custom +connect localhost:$PORT" \
      "$clog" >/dev/null 2>&1 )

  local ok=0 bad=""
  for f in players/male/custom.pcx players/male/custom_i.pcx; do
    if [ -f "$cli/baseq2/$f" ] && \
       [ "$(sha256sum "$srv/baseq2/$f" | cut -d' ' -f1)" = "$(sha256sum "$cli/baseq2/$f" | cut -d' ' -f1)" ]; then
      ok=$((ok + 1))
    else
      bad="$bad $f"
    fi
  done

  if [ "$ok" -eq 2 ]; then
    note_pass "cell h: both server-only files served over UDP and byte-identical on the client (sha256 match, 40000+9000 bytes across many svc_download chunks) -- see $slog"
  else
    note_fail "cell h: UDP download did not deliver intact files ($ok/2 ok, bad:$bad) -- see $slog / $clog"
  fi
}

echo "=== phase-8 q2repro interop matrix ==="
echo "Q2REPRO_BUILD=$Q2REPRO_BUILD"
echo "Q2TS_BASEDIR=$Q2TS_BASEDIR"
echo

# Optional cell selection (e.g. `interop-matrix.sh a c`) -- lets a re-
# verification pass re-run just the cell(s) that changed without paying for
# the full matrix's runtime (cell b/d each launch their own real client/
# server processes and cell d also runs a bun test suite). No arguments runs
# the full matrix, unchanged from this script's original behavior.
if [ $# -gt 0 ]; then
  for cell in "$@"; do
    "cell_$cell"
  done
else
  cell_a
  cell_b
  cell_c
  cell_d
  cell_e
  cell_f
  cell_g
  cell_h
fi

echo
echo "=== summary: $pass_count pass, $fail_count fail, $skip_count skip (partials printed above) ==="
[ "$fail_count" -eq 0 ]
