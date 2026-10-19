#!/usr/bin/env bash
# Idle-RAM benchmark: PSS summed over app + all descendant processes (WebKitWebProcess, WebKitNetworkProcess).
# usage: measure-ram.sh LABEL BINARY WAIT_S SAMPLES [FILE]
# --no-restore: never reopen the last file (older builds ignore the flag; the fresh profile covers them).
# Each sample uses a fresh XDG profile (no localStorage/recent/cache carry-over), same Xvfb display.
set -u
LABEL=$1 BIN=$2 WAIT=$3 N=$4 FILE=${5:-}
export DISPLAY=${DISPLAY:-:77} WEBKIT_DISABLE_DMABUF_RENDERER=1 NO_AT_BRIDGE=${NO_AT_BRIDGE-1}
# PSS splits shared pages between all processes mapping them: any other WebKitGTK/mdnest process on the
# machine (e.g. a stale instance) lowers the numbers. Refuse to measure unless we are alone.
if pgrep -f "WebKitWebProcess|WebKitNetworkProcess" >/dev/null || pgrep -x mdnest >/dev/null; then
  echo "other WebKit/mdnest processes running — results would be skewed:"; pgrep -af "WebKit|mdnest" | grep -v measure-ram; exit 2; fi
desc() { local p=$1; echo $p; for c in $(pgrep -P $p); do desc $c; done; }
for i in $(seq 1 $N); do
  prof=$(mktemp -d /tmp/mdnram.XXXX)
  # PROFILE_SRC=1 → start from a copy of the real profile (localStorage incl. mdnest.lastFile, installed themes)
  if [ -n "${PROFILE_SRC:-}" ]; then mkdir -p $prof/data $prof/config; cp -a ~/.local/share/app.mdnest.editor $prof/data/; cp -a ~/.config/app.mdnest.editor $prof/config/; fi
  # PROFILE_DIR=dir → start from a copy of a prepared profile (dir/data, dir/config; e.g. library on
  # with an already indexed workspace, see scripts/make-ram-profile.mjs)
  if [ -n "${PROFILE_DIR:-}" ]; then cp -a "$PROFILE_DIR"/. $prof/; fi
  XDG_DATA_HOME=$prof/data XDG_CONFIG_HOME=$prof/config XDG_CACHE_HOME=$prof/cache "$BIN" --no-restore $FILE >/dev/null 2>&1 &
  P=$!; sleep "$WAIT"
  line="$LABEL #$i"; tot=0
  for p in $(desc $P); do
    v=$(awk '/^Pss:/{print $2}' /proc/$p/smaps_rollup 2>/dev/null) || continue
    [ -z "$v" ] && continue
    n=$(cut -c1-12 /proc/$p/comm); line="$line $n=$((v/1024))"; tot=$((tot+v))
  done
  echo "$line TOTAL=$((tot/1024))MB"
  # WebKit helper processes can outlive the app for a while; wait for all of them (then SIGKILL),
  # otherwise the next sample would refuse to run or share pages with them.
  kids=$(desc $P)
  kill $P 2>/dev/null; wait $P 2>/dev/null
  for _ in $(seq 1 30); do alive=""; for k in $kids; do kill -0 $k 2>/dev/null && alive="$alive $k"; done; [ -z "$alive" ] && break; sleep 0.5; done
  [ -n "$alive" ] && kill -9 $alive 2>/dev/null
  sleep 2; rm -rf "$prof" 2>/dev/null
done
