# MD Nest vs Typora — UI parity gap list

Status of each user-visible Typora feature in MD Nest. Sources: our own clean-room inventory of Typora 1.14.9
(`/workspace/typora-re/grok-features.md`, `report-zh.md`: menu labels from the locale catalogs, element ids from
`window.html`) and Typora's public shortcut documentation. Nothing here copies Typora code or CSS.

Legend: **done** · **partial** (exists but incomplete or hidden) · **missing** (never built) · **win-broken**
(exists, does not work on Windows) · **n/a** (deliberately out of scope).
"Before" = v0.1.0 (commit 27b86e8), the build the user installed. "After" = this work (v0.1.1).
Shortcuts are Windows/Linux. On macOS, Ctrl becomes Cmd.

## Diagnosis summary (why the Windows build looked bare)

Most of these gaps were never built on any platform. The Windows build had no hidden Linux-only menu; MD Nest had no
menu bar at all. Before 0.1.1, File and Open existed only as keyboard shortcuts (Ctrl+O, Ctrl+Shift+O) and as
command-palette entries (Ctrl+Shift+P), and a single line of welcome text pointed to them. A new user could not discover them.
The earlier analysis compared the editing engine (rendering, themes, Markdown round-trip) and the plugin platform against
Typora. It never audited the application shell: menus, file management, sidebar chrome, insert UI. The Linux smoke
tests drove the app with shortcuts and `window.mdnest`, so the missing visible entry points never failed a test.

What really was Windows-specific (before):
- **win-broken**: `mdfile://` image URLs. The frontend sends `C:\…` paths, and the Rust handler rejects absolute paths and
  prepends `/`. Relative images in documents therefore did not render on Windows (the Linux path `/home/…` worked).
- **win-broken**: WebView2 browser accelerator keys were still on. Ctrl+P opened the print dialog, Ctrl+R and F5 reloaded
  the page and threw away unsaved edits, and Ctrl+± zoomed the page. A right-click showed Edge's default context menu
  (Back / Refresh / Save as / Print).
- **win-broken (cosmetic)**: `body.os-linux` was hard-coded, so themes keyed on `.os-windows` did not apply.
- Not broken: the dialog plugin permissions (`dialog:default`) and Ctrl-vs-Cmd (ProseMirror `Mod` maps to Ctrl on Windows).
  The default workspace is `Documents` on every platform. On Windows that folder is often OneDrive-redirected and full of
  non-Markdown folders, so the file tree looked empty.
- Not Windows-specific: the slash menu engine existed, but only the AI plugin registered an item. With AI off, `/` showed
  nothing ("No slash commands").

## Counts

| | done | partial | missing | win-broken | n/a |
|---|---|---|---|---|---|
| Before (0.1.0) | 28 | 42 | 85 | 4 | 4 |
| After (0.1.1) | 143 | 8 | 8 | 0 | 4 |

Counted by `python3 scripts/parity-count.py` (163 rows; an empty After cell inherits Before).

## Menu bar (window chrome)

| Item | Shortcut | Before | After | Notes |
|---|---|---|---|---|
| Native menu bar File/Edit/Paragraph/Format/View/Themes/Help | | missing | done | HTML menubar in the browser host; GTK/Windows menu via set_app_menu |
| Window menu (minimize, zoom, always on top) |  | missing | partial | Always on Top is a View item; no separate Window menu (minimize/zoom are the OS window) |
| App menu on macOS (About, Preferences, Quit) | | missing | done | built in Rust; not run on this box |

## File

| Item | Shortcut | Before | After | Notes |
|---|---|---|---|---|
| New | Ctrl+N | missing | done | untitled doc; dirty guard Save / Don't Save / Cancel |
| New Window | Ctrl+Shift+N | missing | done | WebviewWindow label w-<n>; capability windows main + w-* |
| Open… | Ctrl+O | partial | done | menu + shortcut; dirty guard |
| Open Folder… | Ctrl+Shift+O | partial | done | menu + shortcut |
| Open Quickly (quick open by file name) | Ctrl+P | missing | done | #typora-quick-open; recent first, then fuzzy names |
| Open Recent submenu (+ Clear Items) | | partial | done | submenu + Clear Items; sidebar Recent tab kept |
| Reopen Closed File | Ctrl+Shift+T | missing | done | closed-file stack |
| Reload from Disk | | partial | done | menu item |
| Save | Ctrl+S | done | done | menu + shortcut |
| Save As… | Ctrl+Shift+S | partial | done | menu + shortcut |
| Save All |  | n/a | n/a | single document per window |
| Move To… | | missing | done | folder picker + rename_path |
| Rename… / Duplicate | | missing | done | prompt / unique "name copy.ext" |
| Open File Location (reveal in Explorer/Finder) | | missing | done | explorer /select, open -R, FileManager1.ShowItems |
| Reveal in Sidebar | | missing | done | expands ancestors in the tree |
| Export → PDF | | partial | done | File → Export submenu |
| Export → HTML | | partial | done | File → Export submenu |
| Export → HTML (without styles) | | missing | done | styles omitted; welcome page not in the export |
| Export → Word / pandoc formats |  | missing | missing | needs pandoc; not built |
| Import |  | n/a | n/a | pandoc |
| Print… | Ctrl+Alt+P | missing | done | export HTML through the print dialog |
| Properties / word count info |  | partial | done | footer word count + View ▸ Word Count popover |
| Preferences… | Ctrl+, | partial | done | menu opens the sidebar settings tab |
| Close | Ctrl+W | missing | done | dirty guard; Tauri close request uses the same modal |
| Quit | Ctrl+Q | missing | done | menu item (omitted on macOS, where it is in the app menu) |
| Drag a .md file onto the window → open | | missing | done | handleNativeDrop; Windows uses tauri drag-drop |
| Drag a folder onto the window → open folder | | missing | done | same handler |
| Welcome page with Open File / Open Folder buttons | | missing | done | #mdn-welcome; also New File and recent list |
| Launch: restore last folder / file |  | done | done | setting Reopen last file |
| Autosave |  | done | done | setting |
| Line endings (CRLF/LF), encodings |  | missing | missing | files are read and written as UTF-8; no encoding or newline picker |

## Edit

| Item | Shortcut | Before | After | Notes |
|---|---|---|---|---|
| Undo / Redo | Ctrl+Z / Ctrl+Y, Ctrl+Shift+Z | done | done | menu + focus-aware dispatcher |
| Cut / Copy / Paste / Select All | Ctrl+X/C/V/A | done | done | predefined menu items + select all |
| Copy as Markdown | Ctrl+Shift+C | missing | done | Ctrl+Shift+C |
| Copy as HTML code |  | missing | done | menu item; no shortcut |
| Copy as Plain Text |  | missing | done | menu item; no shortcut |
| Paste as Plain Text | Ctrl+Shift+V | missing | done | Ctrl+Shift+V |
| Delete |  | done | done | Edit menu + key |
| Select line / sentence | Ctrl+L | missing | done | Ctrl+L selects the current line |
| Select styled scope | Ctrl+E | missing | done | Ctrl+E |
| Select word | Ctrl+D | missing | done | Ctrl+D |
| Jump to top / bottom | Ctrl+Home / Ctrl+End | done | done | Ctrl+Home / Ctrl+End commands |
| Find… | Ctrl+F | done | done | menu + shortcut |
| Find Next / Previous | F3 / Shift+F3 | partial | partial | menu items; find-bar behaviour unchanged |
| Replace | Ctrl+H | done | done | menu + shortcut |
| Find in files (sidebar search) | Ctrl+Shift+F | partial | done | #file-library-search-input; content hits open at the line |
| Smart punctuation / substitutions |  | missing | missing | not built |
| Spell check |  | missing | missing | editor spellcheck is off; no dictionary |
| Emoji & symbols / :emoji: autocomplete |  | missing | missing | not built |
| Auto-pair brackets and quotes |  | missing | done | on by default; Edit ▸ Auto Pair and Settings |
| Auto-pair Markdown syntax (`*`, `` ` ``, `~~`) |  | missing | done | off by default; Edit ▸ Auto Pair and Settings |
| Code tools: copy code content |  | missing | missing | no code-block toolbar action |
| Math tools: refresh math |  | n/a | n/a | always live |

## Paragraph

| Item | Shortcut | Before | After | Notes |
|---|---|---|---|---|
| Heading 1–6 | Ctrl+1…6 | partial | done | menu + shortcut |
| Paragraph | Ctrl+0 | partial | done | menu + shortcut |
| Increase / Decrease heading level | Ctrl+= / Ctrl+- | missing | done | Ctrl+= / Ctrl+-; h1 decrease returns to a paragraph |
| Insert paragraph before / after |  | missing | done | Paragraph menu |
| Table insert (rows × cols dialog) | Ctrl+T | partial | done | #table-insert-dialog |
| Table submenu (add/delete row/col, align, move, delete table) |  | partial | partial | add/delete row and column, delete table; no align or move |
| Code fences | Ctrl+Shift+K | partial | done | menu + shortcut |
| Math block | Ctrl+Shift+M | missing | done | Ctrl+Shift+M and $$ + Enter |
| Quote | Ctrl+Shift+Q | partial | done | menu + shortcut |
| Ordered list | Ctrl+Shift+[ | partial | done | menu + shortcut |
| Unordered list | Ctrl+Shift+] | partial | done | menu + shortcut |
| Task list | Ctrl+Shift+X | missing | done | Ctrl+Shift+X and [ ] + space at paragraph start |
| Toggle task status |  | partial | partial | click the checkbox; no menu command |
| Indent / Outdent list item | Ctrl+] / Ctrl+[, Tab / Shift+Tab | done | done | menu + Ctrl+] / Ctrl+[ |
| Link reference |  | missing | done | Paragraph menu inserts a reference definition |
| Footnote |  | missing | done | inserts [^n] and a definition |
| Horizontal line |  | partial | done | Paragraph menu and --- + Enter |
| Table of contents |  | partial | done | Paragraph menu and [TOC] + Enter |
| YAML front matter |  | partial | done | Paragraph menu; --- + Enter on the first line |
| HTML block |  | partial | partial | parsed and round-tripped; no insert command |
| Alert / callout blocks (NOTE/TIP/…) |  | missing | done | Paragraph ▸ Alert; GitHub > [!NOTE] |
| Mermaid / diagram insert |  | partial | done | Paragraph menu inserts a mermaid fence |
| Delete block |  | missing | done | Paragraph menu |

## Format

| Item | Shortcut | Before | After | Notes |
|---|---|---|---|---|
| Strong | Ctrl+B | partial | done | menu + shortcut |
| Emphasis | Ctrl+I | partial | done | menu + shortcut |
| Underline | Ctrl+U | missing | done | Ctrl+U; <u> parses and serializes |
| Code | Ctrl+Shift+` | partial | done | menu + shortcut |
| Strike | Alt+Shift+5 | partial | done | menu + shortcut |
| Highlight |  | partial | done | Format menu; ==x== input rule kept |
| Inline math |  | partial | done | Format menu; $x$ input rule kept |
| Superscript / Subscript |  | missing | done | ^x^ and ~x~; ~~strike~~ unchanged |
| Comment `<!-- -->` |  | missing | done | inline comment mark; a comment-only line stays an HTML block |
| Hyperlink | Ctrl+K | missing | done | Ctrl+K prompts for a URL; dropped while AI Rewrite owns Mod-k |
| Image (insert from file) | Ctrl+Shift+I | missing | done | Ctrl+Shift+I file dialog, then image settings |
| Image zoom / align |  | missing | partial | zoom 50/100/200% as an img style; no align |
| Clear format | Ctrl+\ | missing | done | Ctrl+\ |
| Open link / copy link address | Ctrl+click | partial | partial | Ctrl+click opens; context menu copies the address |

## View

| Item | Shortcut | Before | After | Notes |
|---|---|---|---|---|
| Source code mode | Ctrl+/ | done | done | menu + footer + shortcut |
| Focus mode | F8 | missing | done | F8; body.on-focus-mode |
| Typewriter mode | F9 | missing | done | F9; body.ty-on-typewriter-mode |
| Toggle sidebar | Ctrl+Shift+L | partial | done | menu + shortcut + footer |
| Outline | Ctrl+Shift+1 | partial | done | menu shows the outline tab |
| Articles (file list view) | Ctrl+Shift+2 | missing | done | #file-library-list excerpt, time, parent |
| File tree | Ctrl+Shift+3 | partial | done | tree + footer toolbar |
| Status bar toggle |  | missing | done | View ▸ Status Bar; persisted |
| Word count (footer, popover) |  | partial | done | footer count + popover (words, characters, lines, reading minutes) |
| Full screen | F11 | missing | done | F11; Tauri setFullscreen, browser fullscreen API |
| Always on top |  | missing | done | View item; Tauri setAlwaysOnTop |
| Zoom in / out / actual size | Ctrl+Shift+= / Ctrl+Shift+- / Ctrl+Shift+0 | missing | done | Ctrl+Shift+= / - / 0; persisted CSS zoom |
| Formatting toolbar |  | missing | done | #mdn-format-toolbar; View toggle, off by default, active states |
| Readonly mode |  | missing | missing | not built |
| Toggle DevTools |  | n/a | n/a | release builds |
| Command palette | Ctrl+Shift+P | done | done | View menu + shortcut |

## Themes and Help

| Item | Shortcut | Before | After | Notes |
|---|---|---|---|---|
| Themes menu listing theme CSS files | | partial | done | radio items + footer select |
| Open theme folder | | missing | done | reveal_path on the config themes dir (browser: toast) |
| base.user.css / name.user.css |  | done | done |  |
| Help: Markdown reference / quick start | | missing | done | modal with a short reference |
| Help: About (version) | | missing | done | toast "MD Nest 0.1.1" |
| Help: Keyboard shortcuts | | missing | done | modal listing registered accelerators |

## Sidebar

| Item | Shortcut | Before | After | Notes |
|---|---|---|---|---|
| File tree (`#file-library-tree`) | | done | done | Markdown + txt; same extension set as the walk |
| Article list with excerpt and mtime (`#file-library-list`) | | missing | done | excerpt, time, parent loc |
| Tree / list switch | | missing | done | selection persisted in localStorage |
| Bottom bar: new file | | missing | done | #sidebar-footer |
| Bottom bar: new folder | | missing | done | |
| Bottom bar: open folder | | missing | done | |
| Bottom bar: sort (name / modified / created / natural) | | missing | done | asc/desc persisted |
| Bottom bar: search in folder | | partial | done | focuses #file-library-search-input |
| Refresh folder | | missing | done | also on window focus |
| Context menu: new file / new folder | | missing | done | .context-menu on nodes and blank area |
| Context menu: rename | | missing | done | inline edit, Enter/Esc |
| Context menu: delete (to recycle bin / trash) | | missing | done | confirm modal, then trash |
| Context menu: duplicate | | missing | done | |
| Context menu: reveal in Explorer / Finder | | missing | done | label follows OS |
| Context menu: copy file path | | missing | done | |
| Context menu: open in new window | | missing | done | |
| Outline: highlight current heading | | missing | done | .outline-item-active |
| Outline: collapse / expand |  | missing | missing | outline lists headings; no collapse control |
| File tree keyboard navigation | | missing | done | arrows, Enter, F2, Delete |
| Live refresh when files change on disk | | missing | partial | refresh on focus and after our own operations |

## Quick insert (Typora has no slash menu; these are its Markdown input rules and shortcuts)

| Item | Shortcut | Before | After | Notes |
|---|---|---|---|---|
| `#`–`######` + space → heading | | done | done | |
| `>` + space → quote |  | done | done |  |
| `-`/`*`/`+` + space → bullet list |  | done | done |  |
| `1.` + space → ordered list |  | done | done |  |
| `[ ]` / `[x]` + space → task list (top level) |  | partial | done | paragraph start, not only inside a list |
| ```` ```lang ```` + space/Enter → code fence |  | partial | done | Enter creates the fence; space rule kept |
| `$$` + Enter/space → math block |  | partial | done | Enter creates the block; space rule kept |
| `---` / `***` → horizontal rule |  | done | done | first line of the doc becomes front matter instead |
| `**x**`, `*x*`, `` `x` ``, `~~x~~`, `==x==`, `$x$` |  | done | done |  |
| `<u>x</u>` underline, `^x^` sup, `~x~` sub |  | missing | done | parse, serialize, round-trip |
| `[TOC]` + Enter → TOC |  | partial | done | Enter creates a TOC node |
| `---` on the first line → YAML front matter |  | missing | done | elsewhere --- stays a horizontal rule |
| `|a|b|` + Enter → table | | missing | | |
| `[^1]:` footnote, `[x]: url` ref |  | done | done | defs plugin |
| Core slash menu `/` (headings, lists, quote, table, code, math, mermaid, hr, TOC, footnote, front matter, image) |  | missing | done | slash-core.ts; AI item still appears when AI is on |
| Editor context menu (format / insert / paragraph / table) |  | missing | done | right-click in #write; same .context-menu as the sidebar |
| Image settings (copy to ./assets etc.) |  | done | done | Settings → Images |
| Insert image from file dialog |  | missing | done | Ctrl+Shift+I |

## Status bar

| Item | Shortcut | Before | After | Notes |
|---|---|---|---|---|
| Word count |  | done | done |  |
| Source-mode toggle button |  | done | done |  |
| Sidebar toggle button |  | done | done |  |
| Theme switcher |  | done | done | MD Nest extra |
| Character / line count popover |  | missing | done | View ▸ Word Count |

## Windows-specific

| Item | Shortcut | Before | After | Notes |
|---|---|---|---|---|
| Relative / local images (`mdfile` URLs for `C:\…` paths) | | win-broken | done | frontend forward slashes; decoder accepts drive letters |
| Browser accelerators off (Ctrl+P print, Ctrl+R/F5 reload, page zoom) | | win-broken | done | WebView2 settings + frontend swallow |
| No Edge default context menu (Back/Refresh/Print) | | win-broken | done | WebView2 settings + frontend preventDefault |
| `body.os-windows` class for themes | | win-broken | done | os-windows / os-linux / is-mac, including export |
| Native file dialogs (open/save/folder) |  | done | done | dialog:default capability |
| Ctrl shortcuts (Mod = Ctrl) |  | done | done |  |

## Remaining gaps

Still missing or only partial after 0.1.1. Each note says why.

- **Window menu** (partial). Always on Top lives under View. There is no Window menu for minimize or zoom; those stay with the OS window.
- **Export to Word / pandoc** (missing). No pandoc integration. Export is PDF, HTML, and HTML without styles.
- **Line endings and encodings** (missing). Files are read and written as UTF-8. There is no CRLF/LF or encoding picker.
- **Smart punctuation, spell check, emoji autocomplete** (missing). Not built. The editor keeps `spellcheck` off.
- **Copy code content** (missing). Code fences have no copy-content action.
- **Table align and move** (partial). The table menu adds and deletes rows and columns and deletes the table. Alignment stays on the floating table toolbar. There is no move-row or move-column command.
- **Toggle task status** (partial). Clicking the checkbox toggles it. There is no menu command.
- **HTML block insert** (partial). HTML blocks parse and round-trip. There is no insert command.
- **Image align** (partial). Zoom 50/100/200% sets an `<img>` width style. There is no align control.
- **Open link** (partial). Ctrl+click opens a link. The editor context menu copies the address. There is no separate "open link" command beyond that click.
- **Readonly mode** (missing). Not built.
- **Outline collapse** (missing). The outline lists headings and highlights the one at the caret. It does not collapse sections.
- **Live file refresh** (partial). The tree refreshes on window focus and after our own create/rename/trash. It does not watch the disk.
- **Find next / previous** (partial). Menu items and F3 / Shift+F3 step the existing find bar. The find-bar behaviour itself is unchanged.
- **Heading level 6 decrease** (partial). Decrease from h1 returns to a paragraph. Decrease from h6 asks for a level the schema does not have, so that one step does nothing useful.
- **Comment-only lines** (partial). An inline `<!-- note -->` is a mark and round-trips. A line that is only a comment parses as an HTML block, which is how markdown-it treats it.
- **In-editor text drag on Windows** (partial). WebView2 HTML5 drops carry no paths, so folder and file drops use Tauri's drag-drop event. That turns off in-editor text drag-move on Windows.
- **Hyperlink vs AI Rewrite** (partial). Both want Ctrl+K. While AI Rewrite is enabled, the core hyperlink command drops its accelerator and the plugin keeps the key. Hyperlink stays in the menu.
