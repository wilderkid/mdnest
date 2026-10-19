#!/usr/bin/env bash
# Cross-build the Windows x64 NSIS installer from Linux (MSI needs WiX on Windows; not built).
# Follows https://v2.tauri.app/distribute/windows-installer/#build-windows-apps-on-linux-and-macos
#
# One-time setup:
#   sudo apt install nsis lld clang llvm                # makensis, lld-link, clang-cl, llvm-lib, llvm-rc
#   rustup target add x86_64-pc-windows-msvc
#   cargo install --locked cargo-xwin                   # downloads the MSVC CRT + Windows SDK on first use
#                                                       # (Microsoft license; cached in ~/.cache/cargo-xwin)
#   npm install && ./scripts/prepare-assets.sh
# Output: $OUT/MDNest_<ver>_x64-setup.exe (OUT defaults to /workspace/dist)
#
# Same features as the Linux release (default features → "library": bundled SQLite + FTS5,
# sqlite-vec, notify), native TLS = schannel (reqwest native-tls; no OpenSSL DLLs).
# Windows-only settings (product name "MD Nest", NSIS, WebView2 download bootstrapper) are in
# src-tauri/tauri.windows.conf.json, which Tauri merges for Windows targets. Unsigned.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${OUT:-/workspace/dist}
TARGET=x86_64-pc-windows-msvc
VER=$(node -p 'require("./src-tauri/tauri.conf.json").version')
# clang-cl / llvm-lib / lld-link (Debian ships them unversioned only under the llvm-19 prefix)
[ -d /usr/lib/llvm-19/bin ] && export PATH="/usr/lib/llvm-19/bin:$PATH"
for t in makensis lld-link clang-cl llvm-lib llvm-rc cargo-xwin; do command -v $t >/dev/null || { echo "missing: $t"; exit 1; }; done
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-4}
npx tauri build --runner cargo-xwin --target $TARGET --bundles nsis
REL=src-tauri/target/$TARGET/release
SETUP=$(ls $REL/bundle/nsis/*_${VER}_x64-setup.exe | head -1)
mkdir -p "$OUT"
cp "$SETUP" "$OUT/MDNest_${VER}_x64-setup.exe"
ls -l "$OUT/MDNest_${VER}_x64-setup.exe"
