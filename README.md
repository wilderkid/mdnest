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
npx tsx tests/markers.ts        # editable-marker unit tests
npx tsx tests/refs.ts           # footnotes + reference links (round-trip, markers)
node tests/fixes.mjs            # E2E: footnotes/ref links, WebKitGTK-style paste/drop payloads
tests/native/image-paste-drop.py src-tauri/target/release/mdnest   # native app under Xvfb (xdotool, xclip, python3-gi, xfwm4)
scripts/measure-ram.sh LABEL BIN 30 3 [FILE]   # idle RAM: PSS over app + WebKit processes, fresh profile
npx tsx tests/roundtrip.ts samples/sample.md   # markdown round-trip check
CARGO_BUILD_JOBS=4 npx tauri build   # desktop binary + .deb
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

### WebKitGTK paste/drop notes
- A clipboard image never reaches the `paste` event; ProseMirror captures the native paste and gets `<img src="blob:…">`, and MD Nest fetches those bytes.
- A file dragged from a file manager arrives as `<a>file:///…</a>` HTML, with `text/uri-list` unreadable and no `files`. MD Nest copies the file with the `copy_file` command.

### Memory
Measured numbers and method: `docs/ram-notes.md`.
Startup restores `mdnest.lastFile`, so a no-argument launch is only a "welcome screen" with a fresh profile. Compare builds with `scripts/measure-ram.sh`. It refuses to run while other WebKit processes are alive, because those share library pages and lower PSS.

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
