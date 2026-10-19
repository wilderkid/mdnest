#!/usr/bin/env bash
# Compile-check the Windows and macOS code paths (native PDF export) from Linux. Does not link or run.
# Needs: rustup targets x86_64-pc-windows-msvc + aarch64-apple-darwin, llvm-rc (tauri-winres) and clang
# (objc2-exception-helper). Uses a separate target dir.
set -euo pipefail
cd "$(dirname "$0")/../src-tauri"
T=${XCHECK_DIR:-/workspace/.xcheck}
cargo check --target x86_64-pc-windows-msvc --target-dir "$T"
CC_aarch64_apple_darwin=clang cargo check --target aarch64-apple-darwin --target-dir "$T"
echo "cross-check OK (windows-msvc, apple-darwin)"
