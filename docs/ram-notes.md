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
