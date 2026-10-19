# MD Nest

*Code name `mdnest`. Phase 2 prototype.*

A clean-room, Typora-style live-preview Markdown editor: Tauri 2 + Vite + TypeScript, with ProseMirror for editing.
No Typora code, base.css, built-in themes or translations are used. `src/styles/base.css` and `themes/mdnest*.css` are original work.

## Run
```bash
npm install
./scripts/prepare-assets.sh     # MathJax → public/vendor, Open Sans → themes/github, dev fixtures
npm run dev                      # browser dev mode, http://127.0.0.1:1420 (file API sandboxed to dev-data/workspace)
npm run build && npx vite preview   # http://127.0.0.1:4173
node tests/screenshots.mjs      # headless Playwright screenshots + smoke checks → screenshots/
node tests/phase2.mjs           # Phase 2 E2E suite (35 checks; needs `npx vite preview` on :4173)
node tests/mock-openai.mjs      # OpenAI-compatible mock (default :1421, or MOCK_OPENAI_PORT). Fake key test-key-123 only
node tests/ai-e2e.mjs           # AI plugin E2E (starts the mock; needs preview on :4173, or starts it) → screenshots/ai/
npx tsx tests/ai.ts             # AI plugin unit tests (no network)
node tests/ai-polish.mjs        # diff views, inline-only block edits, usage limits → screenshots/ai-polish/
npx tsx tests/library.ts        # library runtime unit tests (mock index + provider)
node tests/library-e2e.mjs      # library E2E: kb-cli bridge + mock embeddings → screenshots/library/
node tests/leftovers.mjs        # formatted word diff, math in suggestion cards, one-line source lists,
                                # meaning cut-off with real nomic embeddings (if a server answers on :11434)
                                # → screenshots/leftovers/ (SHOT_PREFIX=before|after)
node scripts/calibrate-cutoff.mjs   # meaning cut-off calibration for an embedding model (docs/library-cutoff.md)
scripts/cross-check.sh          # cargo check for Windows + macOS, library on and off (see below)
                                # (needs: cargo build --release --bin kb-cli; preview on :4173)
# real desktop smokes (Xvfb + tauri-driver + webkit2gtk-driver); key read from env at runtime only:
( set -a; . ~/.grok/relay.env; set +a; node tests/native/relay-smoke.mjs )     # AI polish through the relay
( set -a; . ~/.grok/relay.env; set +a; node tests/native/library-smoke.mjs )   # + local embeddings on :11434
npx tsx tests/markers.ts        # editable-marker unit tests
npx tsx tests/refs.ts           # footnotes + reference links (round-trip, markers)
node tests/fixes.mjs            # E2E: footnotes/ref links, WebKitGTK-style paste/drop payloads
node tests/parity.mjs           # menu bar, shortcuts, welcome (needs preview on :4173)
node tests/parity-files.mjs     # file handling and sidebar (needs preview on :4173)
node tests/parity-insert.mjs    # slash menu, input rules, editing shortcuts, toolbar (needs preview on :4173)
npx tsx tests/parity-unit.ts    # marks, task-list and table input-rule unit tests
node tests/native/parity-smoke.mjs   # GTK menu bar smoke (tauri-driver, Xvfb)
tests/native/image-paste-drop.py src-tauri/target/release/mdnest   # native app under Xvfb (xdotool, xclip, python3-gi, xfwm4)
scripts/measure-ram.sh LABEL BIN 30 3 [FILE]   # idle RAM: PSS over app + WebKit processes, fresh profile
npx tsx tests/roundtrip.ts samples/sample.md   # markdown round-trip check
CARGO_BUILD_JOBS=4 npx tauri build   # desktop binary + .deb
scripts/build-windows.sh             # Windows x64 NSIS installer, cross-built from Linux (see below)
```

## Platform APIs for plugins

Plugins never see a secret value. The host stores it and, when a request names a `secretRef`, attaches it on the way out.

**Secrets** (`host.secrets`)

| Method | Behaviour |
|---|---|
| `set(id, value)` | Store a secret. `id` matches `^[a-z0-9._-]{1,64}$`. |
| `has(id)` | Whether that id is stored. |
| `delete(id)` | Remove it. A missing id is not an error. |
| `backend()` | `"keyring"` (OS store) or `"file"` (fallback). |

The desktop host uses the OS keyring (macOS Keychain, Windows Credential Manager, Linux Secret Service). With no Secret Service it writes `<app_config_dir>/secrets.json` mode `0600` and reports `"file"`. There is no command that returns a secret. The browser dev host keeps an in-memory map mirrored to gitignored `dev-data/secrets.json` and always reports `"file"`.

**Streaming HTTP** (`host.net.stream(req, onEvent) → { cancel() }`)

`req` is `{ url, method: "POST"|"GET", headers?, body?, secretRef?, auth?, timeoutMs? }`. Only `http` and `https` URLs are allowed. When `secretRef` is set, the host reads the secret and sets `Authorization: Bearer <secret>`, or the header named by `auth: "header:<name>"`. `onEvent` receives:

- `{ type: "open", status }`
- `{ type: "data", event?, data }` — one SSE event, or the whole body when the response is not `text/event-stream`
- `{ type: "error", status?, message }` — `message` is at most 2 KB, with the secret scrubbed out
- `{ type: "done" }`

`data: [DONE]` ends an SSE stream. `cancel()` aborts the in-flight request. A 429 or 5xx (and a connection failure) is retried at most twice, with exponential backoff, and only before the first payload byte is forwarded.

Plugins call these through `ctx.net.stream` and `ctx.secrets` (`has` / `backend` only). `ctx.net` allows origins listed in `manifest.permissions.net` plus that plugin's `url` settings, and prefixes `secretRef` to `${pluginId}.${key}` (lowercased). Suggestions, slash items, and editor read/write live on `ctx.editor`; pending suggestion text is decoration-only and never enters the document until accepted.

Tauri commands: `secret_set`, `secret_has`, `secret_delete`, `secret_backend`, `net_stream`, `net_cancel`. The browser equivalents are `POST /api/secret/set|delete`, `GET /api/secret/has|backend`, `POST /api/net/stream` (newline-delimited JSON events) and `POST /api/net/cancel`.

## Layout
| Path | What |
|---|---|
| `src/editor/schema.ts` | PM schema whose DOM output follows the Typora theme contract (`#write`, `[md-inline]`, `.md-fences`, `.md-toc`, `.md-task-list-item`, `mdtype=`…) |
| `src/editor/markdown.ts` | md-bridge: markdown-it (CommonMark + GFM tables/strike + mark + math/front-matter/TOC/task rules) ⇄ prosemirror-markdown |
| `src/editor/markers.ts` | Typora-style editable markers. A formatted span the caret touches is expanded to raw Markdown text (`md_src` mark, highlighted); the block is reparsed when the caret leaves. Also has `collapseAll` (run before save/export) and click→selection sync |
| `src/editor/reveal.ts` | block `.md-focus` / `.md-focus-container`, heading `#` and image-src widgets |
| `src/editor/tabletools.ts` | floating table toolbar: rows/cols, alignment, delete; `insertTable` |
| `src/editor/search.ts`, `src/shell/findbar.ts` | find/replace (case, regex) for WYSIWYG (PM decorations mirrored into CodeMirror blocks) and source mode |
| `src/shell/images.ts` | image paste/drop → assets folder (`./assets` or `${filename}.assets`, Settings → Images), relative src |
| `src/shell/export.ts` | standalone HTML export (theme CSS inlined, fonts/images as data URIs, static code highlighting, SVG math/mermaid) and print |
| `src-tauri/src/pdf.rs` | Linux PDF export via WebKitGTK `PrintOperation` (print-to-file) |
| `src/editor/codeview.ts` | CodeMirror 5.65 node view (`cm-s-inner`) for fences, `$$` math and YAML front matter. Mermaid/math previews are shown when the block is not focused |
| `src/editor/views.ts` | inline math, TOC, and HTML-block views |
| `src/editor/rules.ts` | input rules (`#`, `>`, `-`, `1.`, `[ ]`, ```` ``` ````, `$$`, `---`, `**`, `*`, `` ` ``, `~~`, `==`, `$`) and keymaps |
| `src/shell/*` | sidebar (file tree and outline in `#typora-sidebar`), source mode (`#typora-source`), theme manager, command palette |
| `src/plugins/api.ts` | plugin API: manifest (`depends`, `provides`/`consumes`, permissions), commands (hotkey + `when`), sidebar, settings, editor read/write/suggest, slash items, `ctx.net` / `ctx.secrets` |
| `src/plugins/builtin/*` | `word-stats` example, the `reading-goal` plugin that depends on it, and the `ai` assistant |
| `src/host/*` | HostAPI: Tauri implementation plus a browser dev implementation. `host.secrets` and `host.net` are the plugin platform (see above) |
| `src-tauri/` | Rust backend: commands, `mdtheme://` and `mdfile://` protocols, theme seeding, secrets (`secrets.rs`), streaming HTTP + SSE (`net.rs`, `sse.rs`) |
| `themes/` | built-in themes (`mdnest`, `mdnest-night`) and `github/` fonts (Open Sans, OFL) |

## Themes
The theme folder holds `<name>.css` and an optional `<name>/` asset folder. Load order is `<name>.css` → `base.user.css` → `<name>.user.css`, using link ids `#theme_css`, `#base_user_css` and `#theme_user_css`. Dark themes are detected from the computed body background. The Mermaid theme comes from `--mermaid-theme`.
Gallery themes used for testing are copied unmodified into `dev-data/themes` (gitignored, not shipped).

## Typora parity features

Item-by-item status is in [docs/typora-parity-gap.md](docs/typora-parity-gap.md), including the shortcut table (Windows/Linux; Cmd on macOS).

- **Menus.** File, Edit, Paragraph, Format, View, Themes, and Help. The desktop build uses a native menu. The browser host (and Playwright) uses `#mdn-menubar`. Every item runs a command from the registry.
- **Sidebar.** File tree and article list, search, sort, and a footer with new file, new folder, open folder, sort, search, and refresh. Right-click uses the shared `.context-menu`.
- **Quick open.** Ctrl+P opens `#typora-quick-open` (recent files, then a fuzzy name match).
- **Slash menu.** `/` at the start of an empty paragraph inserts headings, lists, quote, table, code, math, mermaid, a rule, TOC, footnote, front matter, and a callout. The AI item still appears when AI is on.
- **Editing.** Underline, superscript, subscript, and comments round-trip. Auto-pair is on for brackets and quotes, off for Markdown syntax. Focus mode (F8), typewriter mode (F9), a formatting toolbar, and an editor context menu.
- **Windows drag-drop.** HTML5 drops stay on Linux. On Windows, WebView2 drops carry no paths, so a dropped folder or Markdown file is handled by Tauri's drag-drop event. In-editor text drag-move is lost on Windows.

## Phase 2 features
- **Editable markers**: click into **bold**, *italic*, `code`, ~~strike~~, ==mark==, [links](…) or `$math$` and the delimiters become real text. Typing or deleting them changes the formatting. Inline math has a live preview popover.
- **Tables**: a toolbar on the focused table (add/remove row/col, align left/center/right, delete table), `Ctrl+T` to insert, `Ctrl+Enter` for a new row. Alignment round-trips to `|:--:|`.
- **Images**: paste or drop → written to the configured folder next to the document (unique names, `image-YYYYMMDD-HHMMSS.png` for clipboard images). A relative, URL-encoded path is inserted. Unsaved documents use the workspace root.
- **Find/replace**: `Ctrl+F` / `Ctrl+H`, case-sensitive and regex toggles, `$1` back-references, highlighting in text, code blocks and source mode.
- **Export**: *File → Export HTML* (self-contained) and *Export PDF*.
- Autosave (Settings → Editor, 1.5 s after the last edit), recent files (sidebar → Recent), external-change detection (2 s mtime poll: silent reload if clean, toast if dirty), syntax-colour fallback for themes without CodeMirror colours (e.g. Vue, Purple).
- **Footnotes**: `[^label]` renders as `sup.md-footnote` (hover shows the note; click to edit `[^label]`, Ctrl+click jumps to the definition). `[^label]: text` definitions stay where they are written (`.md-def-footnote > .md-def-name + .md-def-content`).
- **Reference links/images**: `[text][id]`, `[text][]`, `[text]`, `![alt][id]` keep their form on save. `[id]: url "title"` definitions are kept verbatim as a `.md-def-link` block (hidden in export). Editing an id re-resolves against the document's definitions. Soft line breaks inside paragraphs are preserved.
- CLI: `mdnest FILE [--theme NAME] [--export-html OUT] [--export-pdf OUT] [--quit] [--no-restore] [--debug-log PATH]` (exit code 1 when an export fails). Settings → Editor → "Reopen last file on startup" (default on).
- Packaging: `mdnest_<ver>_amd64.deb` (package `mdnest`, `/usr/lib/mdnest`). The display name "MD Nest" comes from the window title and `src-tauri/deb/mdnest.desktop`.

## AI plugin and library

- **Suggestions** are decorations until accepted. The view depends on the edit: short edits show an in-place word diff over formatted text (bold, italic, code, links keep their marks; a formatting-only change shows as a change); longer ones show a rendered card (headings, emphasis, lists) with the changed sentences highlighted; when most sentences change (>70%, ≥3 sentences) it is labelled "full rewrite". Inline and display math in diffs and cards is rendered with MathJax, as in the editor. A whole-block selection sends only the inline text; `#`, list markers and quote prefixes stay in the document and are kept on accept.
- **Usage**: requests and tokens per day (from the provider's `usage` fields, `stream_options.include_usage`; estimated as chars/4 and marked ≈ when missing), shown in the AI panel. Optional daily request/token limits (Settings → AI; 0 = none) are checked before any network call.
- **Library** (Settings → Library, off by default): a per-folder index in Rust (SQLite FTS5 + sqlite-vec, `app_data/library/<hash>.sqlite`). Markdown is chunked by heading (path, lines, hash); re-indexing is incremental (only changed chunks are re-embedded, a file watcher picks up edits) and skips the AI exclude list plus the library's own excludes. The Library panel does hybrid search (BM25 + vector kNN fused with RRF; badges show *keyword* / *meaning*) and lists notes related to the open file. `@library` in AI chat retrieves numbered sources; the answer's `[n]` citations and the source list open the file at the cited line. If embeddings fail, the library falls back to keyword search. Meaning-only matches are cut off per embedding model, by absolute cosine distance and relative to the best hit (nomic-embed-text: 0.40 / 0.05, calibrated; others 0.8 / 0.15). Settings → Library takes `model = max [rel]` lines; see `docs/library-cutoff.md`.
- **Embeddings endpoint**: any OpenAI-compatible `POST /v1/embeddings` (Settings → AI → Embeddings URL / model / optional key). The default is a local Ollama, `http://localhost:11434/v1` with `nomic-embed-text` (`ollama pull nomic-embed-text`). llama.cpp works too: `llama-server -m nomic-embed-text-v1.5.Q4_K_M.gguf --embedding --pooling mean -c 2048 -ub 2048 --port 11434 --alias nomic-embed-text`. For nomic models the `search_document:` / `search_query:` task prefixes are added automatically. The xAI relay does **not** offer embeddings: `/v1/models` lists only chat, image and video models, and `/v1/embeddings` answers "Embeddings API is not supported for this platform".
- **Plugin APIs**: `index` permission → `ctx.index.call(op, args)` (scan, pending, putVectors, search, related, stats, clear; the root is injected) and `ctx.index.watch(cb)`; `workspace` permission → `ctx.workspace.root()` and `openAt(path, line)`. `ai.provider@1` gained `embed(texts)`, `embedInfo()` and `registerMention()`. Cargo feature `library` (default on) gates the Rust index; `kb-cli` exposes the same JSON dispatch to the browser dev host.
- **TLS**: reqwest uses native-tls (OpenSSL on Linux; the .deb depends on `libssl3 | libssl3t64`; schannel on Windows; Security.framework on macOS) instead of rustls/ring.
- **Cross-check** (`scripts/cross-check.sh`): `cargo check --all-targets` for `x86_64-pc-windows-msvc` and `aarch64-apple-darwin`, with the library feature on and off. On Windows the bundled SQLite and sqlite-vec C is compiled with clang against the mingw-w64 headers (`apt install mingw-w64-x86-64-dev`). There is no macOS SDK on the build box, so `scripts/xcheck-stub-cc.sh` replaces the C compiler there: the Rust code is type-checked, and the C is only built on a Mac. The script fails if rustls, ring or OpenSSL show up on those targets.

### Windows build (cross-compiled from Linux)
`scripts/build-windows.sh` runs `npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis` and copies the installer to `/workspace/dist/MDNest_<ver>_x64-setup.exe`. One-time setup: `apt install nsis lld clang llvm`, `rustup target add x86_64-pc-windows-msvc`, `cargo install --locked cargo-xwin`. On first use cargo-xwin downloads the MSVC CRT and Windows SDK (Microsoft license) into `~/.cache/cargo-xwin`.
- The features are the same as the Linux release: the default `library` feature, with SQLite, FTS5 and sqlite-vec statically linked. TLS is native (schannel). The CRT is static, so the exe imports only system DLLs and the UCRT `api-ms-win-crt-*`; there are no OpenSSL, VC runtime or WebView2Loader DLLs. The frontend is embedded in the exe. The themes folder is installed next to it.
- `src-tauri/tauri.windows.conf.json` is merged only for Windows targets. It sets the product name "MD Nest", NSIS per-user install, and the WebView2 download bootstrapper (silent). That bootstrapper only runs if WebView2 is missing.
- There is no MSI, since WiX does not run on Linux. The installer is unsigned, so Windows SmartScreen warns on first run ("More info → Run anyway").
- Under wine 10 the exe loads, all imports resolve, and the "MD Nest" window is created. It then stops at "Could not find the WebView2 Runtime", which is expected because wine has no WebView2. It has not been run on real Windows.
- Library on Windows: meaning search needs an OpenAI-compatible embeddings server, e.g. Ollama for Windows (`ollama pull nomic-embed-text`, default URL `http://localhost:11434/v1`) or llama.cpp's `llama-server.exe`. Keyword search works without one.

### WebKitGTK paste/drop notes
- A clipboard image never reaches the `paste` event; ProseMirror captures the native paste and gets `<img src="blob:…">`, and MD Nest fetches those bytes.
- A file dragged from a file manager arrives as `<a>file:///…</a>` HTML, with `text/uri-list` unreadable and no `files`. MD Nest copies the file with the `copy_file` command.

### Memory
Measured numbers and method: `docs/ram-notes.md`.
Startup restores `mdnest.lastFile`, so a no-argument launch is only a "welcome screen" with a fresh profile. Compare builds with `scripts/measure-ram.sh`. It refuses to run while other WebKit processes are alive, because those share library pages and lower PSS.

### Spell check
Edit ▸ Spell Check (and Settings ▸ Spell check) is off by default. It sets `spellcheck` on `#write` and on the CodeMirror source view.

| Platform | Checker |
|---|---|
| Linux (WebKitGTK) | `WebContext` spell checking, languages from `$LANG` (falling back to `en_US`). Uses enchant/hunspell. If no dictionary is installed, the toggle still works and no words are marked. |
| Windows (WebView2) | the OS spellchecker, through the `spellcheck` attribute |
| macOS (WKWebView) | the system spellchecker, through the `spellcheck` attribute |

### PDF platform notes
| Platform | Path |
|---|---|
| Linux (WebKitGTK) | native: hidden webview → `webkit2gtk::PrintOperation` with GTK print settings "Print to File", A4, PDF output. No dialog. Verified headless (Xvfb) with the CLI. |
| Windows (WebView2) | native: hidden webview → `ICoreWebView2_7::PrintToPdf` (A4, 15/14 mm margins, backgrounds on). **Compile-checked only** (`scripts/cross-check.sh`), never run. |
| macOS (WKWebView) | native: `printOperationWithPrintInfo:` with an `NSPrintSaveJob` to the target URL, run modally on the hidden window, done when the file size is stable. **Compile-checked only**, never run. |
| any failure | the frontend falls back to the system print dialog (interactive export); the CLI exits with code 1 |
| Browser dev mode | print dialog fallback |

### MathJax packaging
Only the modular components are shipped: `startup.js`, `core.js`, `input/tex.js` (+ autoloaded `input/tex/extensions/`), `output/svg.js`, and the NewCM SVG font with its math-relevant dynamic ranges (see `FONT_RANGES` in `scripts/prepare-assets.sh`). The combined `tex-svg.js` bundle is not shipped because it hard-wires the a11y/SRE speech stack. The menu, speech, braille and enrichment are turned off. Glyphs from dropped ranges (Greek/Cyrillic text, Braille, …) need their file added to `FONT_RANGES`.
