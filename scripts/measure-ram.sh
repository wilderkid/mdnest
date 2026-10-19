#!/usr/bin/env bash
# Idle-RAM benchmark: PSS summed over app + all descendant processes (WebKitWebProcess, WebKitNetworkProcess).
# usage: measure-ram.sh LABEL BINARY WAIT_S SAMPLES [FILE]
# Each sample uses a fresh XDG profile (no localStorage/recent/cache carry-over), same Xvfb display.
set -u
LABEL=$1 BIN=$2 WAIT=$3 N=$4 FILE=${5:-}
export DISPLAY=${DISPLAY:-:77} WEBKIT_DISABLE_DMABUF_RENDERER=1 NO_AT_BRIDGE=${NO_AT_BRIDGE-1}
desc() { local p=$1; echo $p; for c in $(pgrep -P $p); do desc $c; done; }
for i in $(seq 1 $N); do
  prof=$(mktemp -d /tmp/mdnram.XXXX)
  # PROFILE_SRC=1 → start from a copy of the real profile (localStorage incl. mdnest.lastFile, installed themes)
  if [ -n "${PROFILE_SRC:-}" ]; then mkdir -p $prof/data $prof/config; cp -a ~/.local/share/app.mdnest.editor $prof/data/; cp -a ~/.config/app.mdnest.editor $prof/config/; fi
  XDG_DATA_HOME=$prof/data XDG_CONFIG_HOME=$prof/config XDG_CACHE_HOME=$prof/cache "$BIN" $FILE >/dev/null 2>&1 &
  P=$!; sleep "$WAIT"
  line="$LABEL #$i"; tot=0
  for p in $(desc $P); do
    v=$(awk '/^Pss:/{print $2}' /proc/$p/smaps_rollup 2>/dev/null) || continue
    [ -z "$v" ] && continue
    n=$(cut -c1-12 /proc/$p/comm); line="$line $n=$((v/1024))"; tot=$((tot+v))
  done
  echo "$line TOTAL=$((tot/1024))MB"
  kill $P 2>/dev/null; wait $P 2>/dev/null; sleep 2; rm -rf "$prof" 2>/dev/null
done
