#!/usr/bin/env bash
# Compile-check the Windows and macOS code paths from Linux (native PDF export, platform TLS,
# keyring backends, and the "library" feature: rusqlite + sqlite-vec + notify's
# ReadDirectoryChangesW / FSEvents watchers). Does not link or run. Uses a separate target dir.
# Needs: rustup targets x86_64-pc-windows-msvc + aarch64-apple-darwin, clang, llvm-ar, llvm-rc
# (tauri-winres); optional mingw-w64 headers (apt install mingw-w64-x86-64-dev).
#
# C sources (bundled SQLite with FTS5, sqlite-vec):
#  - Windows: compiled for real with clang against the mingw-w64 headers (Windows API/CRT headers;
#    the objects are built for the x86_64-w64-mingw32 ABI since no MSVC SDK is available). Without
#    those headers it falls back to the stub below.
#  - macOS: there is no macOS SDK on this box, so scripts/xcheck-stub-cc.sh stands in for the C
#    compiler (empty objects). All Rust code is still type-checked; the C is only built on a Mac.
# Platform TLS: reqwest native-tls → schannel (Windows), Security.framework (macOS); the tree
# check at the end fails if rustls/ring or OpenSSL sneak into those targets.
set -euo pipefail
cd "$(dirname "$0")/../src-tauri"
T=${XCHECK_DIR:-/workspace/.xcheck}
STUB=$PWD/../scripts/xcheck-stub-cc.sh
MINGW=${MINGW_INCLUDE:-/usr/x86_64-w64-mingw32/include}
export AR_x86_64_pc_windows_msvc=llvm-ar AR_aarch64_apple_darwin=llvm-ar
if [ -d "$MINGW" ]; then
  export CC_x86_64_pc_windows_msvc=clang CFLAGS_x86_64_pc_windows_msvc="--target=x86_64-w64-mingw32 -isystem $MINGW -Wno-everything"
  WIN_C="C compiled (mingw-w64 headers)"
else
  export CC_x86_64_pc_windows_msvc=$STUB; WIN_C="C stubbed (no mingw-w64 headers)"
fi
export CC_aarch64_apple_darwin=$STUB
for t in x86_64-pc-windows-msvc aarch64-apple-darwin; do
  cargo check --target $t --target-dir "$T" --all-targets              # default features: library on
  cargo check --target $t --target-dir "$T" --no-default-features       # library off (command stubs)
  if cargo tree --target $t -e normal | grep -qE "^.*(rustls v|ring v0|openssl-sys v|openssl v)"; then
    echo "unexpected TLS stack for $t:"; cargo tree --target $t -e normal | grep -E "rustls v|ring v0|openssl"; exit 1; fi
  echo "$t: native-tls via $(cargo tree --target $t -e normal | grep -oE '(schannel|security-framework) v[0-9.]+' | sort -u | tr '\n' ' ')"
done
echo "cross-check OK (windows-msvc: library on/off, $WIN_C; apple-darwin: library on/off, C stubbed)"
