#!/usr/bin/env bash
# cross-check only: stand-in C compiler for targets whose SDK headers are not on this box (macOS;
# Windows when the mingw-w64 headers are missing). It ignores the C source and emits an empty object
# for the requested target, so the build scripts of C-backed crates (bundled SQLite, sqlite-vec)
# succeed and `cargo check` type-checks all Rust code. Nothing is linked; the C itself is not
# compiled for that target (see scripts/cross-check.sh). STUB_LOG=file records the invocations.
[ -n "${STUB_LOG:-}" ] && echo "$*" >> "$STUB_LOG"
# compiler-family detection and other preprocess-only runs (no system headers involved) go to clang
for a in "$@"; do [ "$a" = "-E" ] && exec clang "$@"; done
out=""; tgt=""; prev=""
for a in "$@"; do
  case "$prev" in -o) out=$a;; esac
  case "$a" in --target=*) tgt=${a#--target=};; -Fo*) out=${a#-Fo};; -o?*) out=${a#-o};; esac
  prev=$a
done
[ -z "$out" ] && exit 0   # flag probes such as "-?"
exec clang ${tgt:+--target=$tgt} -c -x c /dev/null -o "$out"
