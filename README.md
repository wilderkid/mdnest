# mdnest — Phase 1 prototype

A clean-room, Typora-style live-preview Markdown editor: Tauri 2 + Vite + TypeScript, with ProseMirror for editing.
No Typora code, base.css, built-in themes or translations are used. `src/styles/base.css` and `themes/mdnest*.css` are original work.

## Run
```bash
npm install
./scripts/prepare-assets.sh     # MathJax → public/vendor, Open Sans → themes/github, dev fixtures
npm run dev                      # browser dev mode, http://127.0.0.1:1420 (file API sandboxed to dev-data/workspace)
npm run build && npx vite preview   # http://127.0.0.1:4173
node tests/screenshots.mjs      # headless Playwright screenshots + smoke checks → screenshots/
npx tsx tests/roundtrip.ts samples/sample.md   # markdown round-trip check
CARGO_BUILD_JOBS=4 npx tauri build   # desktop binary + .deb
```

## Layout
| Path | What |
|---|---|
| `src/editor/schema.ts` | PM schema whose DOM output follows the Typora theme contract (`#write`, `[md-inline]`, `.md-fences`, `.md-toc`, `.md-task-list-item`, `mdtype=`…) |
| `src/editor/markdown.ts` | md-bridge: markdown-it (CommonMark + GFM tables/strike + mark + math/front-matter/TOC/task rules) ⇄ prosemirror-markdown |
| `src/editor/reveal.ts` | source reveal: `.md-expand` + `.md-meta` delimiter widgets, block `.md-focus` / `.md-focus-container` |
| `src/editor/codeview.ts` | CodeMirror 5.65 node view (`cm-s-inner`) for fences, `$$` math and YAML front matter. Mermaid/math previews are shown when the block is not focused |
| `src/editor/views.ts` | inline math, TOC, and HTML-block views |
| `src/editor/rules.ts` | input rules (`#`, `>`, `-`, `1.`, `[ ]`, ```` ``` ````, `$$`, `---`, `**`, `*`, `` ` ``, `~~`, `==`, `$`) and keymaps |
| `src/shell/*` | sidebar (file tree and outline in `#typora-sidebar`), source mode (`#typora-source`), theme manager, command palette |
| `src/plugins/api.ts` | plugin API: manifest `{id, version, depends}`, commands, sidebar panels, settings, decoration hook, events |
| `src/plugins/builtin/*` | `word-stats` example and the `reading-goal` plugin that depends on it |
| `src/host/*` | HostAPI: Tauri implementation plus a browser dev implementation |
| `src-tauri/` | Rust backend: commands, `mdtheme://` and `mdfile://` protocols, theme seeding |
| `themes/` | built-in themes (`mdnest`, `mdnest-night`) and `github/` fonts (Open Sans, OFL) |

## Themes
The theme folder holds `<name>.css` and an optional `<name>/` asset folder. Load order is `<name>.css` → `base.user.css` → `<name>.user.css`, using link ids `#theme_css`, `#base_user_css` and `#theme_user_css`. Dark themes are detected from the computed body background. The Mermaid theme comes from `--mermaid-theme`.
Gallery themes used for testing are copied unmodified into `dev-data/themes` (gitignored, not shipped).
