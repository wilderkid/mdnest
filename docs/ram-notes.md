# Idle RAM measurements (Phase 1 vs Phase 2)

Method: `scripts/measure-ram.sh`. Xvfb :77 at 1400x900, no window manager, 1200x800 window, 30 s wait.
Each sample uses a fresh XDG profile and `--no-restore`. PSS is summed over the app, WebKitWebProcess and
WebKitNetworkProcess, and no other WebKit process is running (the script enforces this). Three
interleaved samples per row, 2026-10-19.

| Build | Welcome page | samples/sample.md |
|---|---|---|
| Phase 1 (`2fee664`) | 187–190 MB (web 101–104) | 308–310 MB (web 215–217) |
| Phase 2 (`3cedba3`) | 187–189 MB | 243–244 MB (web 152) |
| Fixes (`bef5e8c`) | 189 MB | 243–244 MB |

JS heap after GC (Chromium, same dist builds): welcome page 3.6 MB for Phase 1 vs 3.3 MB for Phase 2
(one 285 KB vs two 252 KB gzip scripts); sample.md 12.5 MB vs 10.5 MB.

The reported 244 MB "welcome page" in Phase 2 was not a regression. A no-argument launch restores
`localStorage["mdnest.lastFile"]`, which the preceding PDF CLI test had set to a copy of sample.md.
Reproduction: after a session that opened sample.md, a no-argument launch uses 243 MB; with `--no-restore`
it uses 190 MB. A stale second instance also skewed some ad-hoc numbers, because shared pages lower PSS.

The Phase 2 saving on sample.md (−65 MB in the web process) comes from loading MathJax as separate
components without SRE/speech, plus the trimmed font ranges.

## Phase 3 (AI plugin, AI off)

Measured on 2026-10-19, same method. Each row interleaves two samples per build. The baseline binary was rebuilt from `0c68237` in a temporary worktree. Absolute numbers run about 7 MB higher than the earlier table because of today's box state, so compare within the table only.

| Build | Binary | .deb | Welcome page | sample.md |
|---|---|---|---|---|
| Pre-AI `0c68237` | 6,332,640 B | 4.00 MiB | 196 / 196 MB | 251 / 250 MB |
| Phase 3 `a855c93`, AI off | 8,283,160 B | 4.93 MiB | 198 / 198 MB | 251 / 252 MB |

With AI off, RAM changes by about +1–2 MB, all of it in the Rust process. The binary grows by 1.95 MB (reqwest + rustls/ring, tokio, keyring with the Secret Service/D-Bus stack). The frontend adds about 4 kB to the main chunk; the AI UI is lazy (runtime 6.6 kB, panel 3.7 kB + 1.5 kB CSS) and only loads once AI is enabled.

## Part A + library (2026-10-19)

Same method (`scripts/measure-ram.sh LABEL BIN 30 1 [FILE]`, `--no-restore`, fresh profile), one sample per build.

| Build | Binary | .deb | Welcome page | sample.md |
|---|---|---|---|---|
| Phase 3 `a855c93`, AI off | 8,283,160 B | 4.93 MiB | 198 MB | 251–252 MB |
| A5 native-tls, AI off | 7,277,896 B | 4.39 MiB | — | — |
| + library (feature on), library off | 8,633,152 B | 5.09 MiB | 193 MB | 246 MB |

The library adds 1.36 MB to the binary over the native-tls build (SQLite with FTS5 1.0 MB, sqlite-vec, notify) and 0.70 MiB to the .deb. Overall it is still 0.35 MB above Phase 3, since native-tls saved 1.0 MB. With the library off, RAM is unchanged (within noise, −5 MB): nothing is opened, and the library runtime (6.7 kB JS) loads lazily. When the library is on, the index for the 5-note smoke folder is 3.4 MB (768-dim vectors, mostly sqlite-vec's preallocated chunk). A local llama-server with nomic-embed-text Q4_K_M uses about 185 MB RSS, in its own process.
