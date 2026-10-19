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
| After (0.1.1) | 94 | 19 | 46 | 0 | 4 |

(Filled in from the tables below at the end of the work.)

## Menu bar (window chrome)

| Item | Shortcut | Before | After | Notes |
|---|---|---|---|---|
| Native menu bar File/Edit/Paragraph/Format/View/Themes/Help | | missing | done | HTML menubar in the browser host; GTK/Windows menu via set_app_menu |
| Window menu (minimize, zoom, always on top) | | missing | | |
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
| Save All | | n/a | | single document per window |
| Move To… | | missing | done | folder picker + rename_path |
| Rename… / Duplicate | | missing | done | prompt / unique "name copy.ext" |
| Open File Location (reveal in Explorer/Finder) | | missing | done | explorer /select, open -R, FileManager1.ShowItems |
| Reveal in Sidebar | | missing | done | expands ancestors in the tree |
| Export → PDF | | partial | done | File → Export submenu |
| Export → HTML | | partial | done | File → Export submenu |
| Export → HTML (without styles) | | missing | done | styles omitted; welcome page not in the export |
| Export → Word / pandoc formats | | missing | | needs pandoc |
| Import | | n/a | | pandoc |
| Print… | Ctrl+Alt+P | missing | done | export HTML through the print dialog |
| Properties / word count info | | partial | | footer word count |
| Preferences… | Ctrl+, | partial | done | menu opens the sidebar settings tab |
| Close | Ctrl+W | missing | done | dirty guard; Tauri close request uses the same modal |
| Quit | Ctrl+Q | missing | done | menu item (omitted on macOS, where it is in the app menu) |
| Drag a .md file onto the window → open | | missing | done | handleNativeDrop; Windows uses tauri drag-drop |
| Drag a folder onto the window → open folder | | missing | done | same handler |
| Welcome page with Open File / Open Folder buttons | | missing | done | #mdn-welcome; also New File and recent list |
| Launch: restore last folder / file | | done | | setting "Reopen last file" |
| Autosave | | done | | setting |
| Line endings (CRLF/LF), encodings | | missing | | |

## Edit

| Item | Shortcut | Before | After | Notes |
|---|---|---|---|---|
| Undo / Redo | Ctrl+Z / Ctrl+Y, Ctrl+Shift+Z | done | done | menu + focus-aware dispatcher |
| Cut / Copy / Paste / Select All | Ctrl+X/C/V/A | done | done | predefined menu items + select all |
| Copy as Markdown | Ctrl+Shift+C | missing | | |
| Copy as HTML code | | missing | | |
| Copy as Plain Text | | missing | | |
| Paste as Plain Text | Ctrl+Shift+V | missing | | |
| Delete | | done | | key only |
| Select line / sentence | Ctrl+L | missing | | |
| Select styled scope | Ctrl+E | missing | | |
| Select word | Ctrl+D | missing | | |
| Jump to top / bottom | Ctrl+Home / Ctrl+End | done | | native caret keys |
| Find… | Ctrl+F | done | done | menu + shortcut |
| Find Next / Previous | F3 / Shift+F3 | partial | partial | menu items; find-bar behaviour unchanged |
| Replace | Ctrl+H | done | done | menu + shortcut |
| Find in files (sidebar search) | Ctrl+Shift+F | partial | done | #file-library-search-input; content hits open at the line |
| Smart punctuation / substitutions | | missing | | |
| Spell check | | missing | | |
| Emoji & symbols / :emoji: autocomplete | | missing | | |
| Auto-pair brackets and quotes | | missing | | |
| Auto-pair Markdown syntax (`*`, `` ` ``, `~~`) | | missing | | |
| Code tools: copy code content | | missing | | |
| Math tools: refresh math | | n/a | | always live |

## Paragraph

| Item | Shortcut | Before | After | Notes |
|---|---|---|---|---|
| Heading 1–6 | Ctrl+1…6 | partial | done | menu + shortcut |
| Paragraph | Ctrl+0 | partial | done | menu + shortcut |
| Increase / Decrease heading level | Ctrl+= / Ctrl+- | missing | | |
| Insert paragraph before / after | | missing | | |
| Table insert (rows × cols dialog) | Ctrl+T | partial | partial | menu inserts 3×3; dialog in part 3 |
| Table submenu (add/delete row/col, align, move, delete table) | | partial | | floating table toolbar |
| Code fences | Ctrl+Shift+K | partial | done | menu + shortcut |
| Math block | Ctrl+Shift+M | missing | | input rule `$$` only |
| Quote | Ctrl+Shift+Q | partial | done | menu + shortcut |
| Ordered list | Ctrl+Shift+[ | partial | done | menu + shortcut |
| Unordered list | Ctrl+Shift+] | partial | done | menu + shortcut |
| Task list | Ctrl+Shift+X | missing | | input rule `[ ]` inside a list only |
| Toggle task status | | partial | | click on the checkbox |
| Indent / Outdent list item | Ctrl+] / Ctrl+[, Tab / Shift+Tab | done | | keys only |
| Link reference | | missing | | parsed and round-tripped, no insert UI |
| Footnote | | missing | | parsed and round-tripped, no insert UI |
| Horizontal line | | partial | | input rule `---` only |
| Table of contents | | partial | | `[TOC]` renders, no insert UI |
| YAML front matter | | partial | | parsed, no insert UI |
| HTML block | | partial | | parsed |
| Alert / callout blocks (NOTE/TIP/…) | | missing | | |
| Mermaid / diagram insert | | partial | | ```mermaid renders, no insert UI |
| Delete block | | missing | | |

## Format

| Item | Shortcut | Before | After | Notes |
|---|---|---|---|---|
| Strong | Ctrl+B | partial | done | menu + shortcut |
| Emphasis | Ctrl+I | partial | done | menu + shortcut |
| Underline | Ctrl+U | missing | | no `<u>` mark |
| Code | Ctrl+Shift+` | partial | done | menu + shortcut |
| Strike | Alt+Shift+5 | partial | done | menu + shortcut |
| Highlight | | partial | | `==x==` input rule only |
| Inline math | | partial | | `$x$` input rule only |
| Superscript / Subscript | | missing | | |
| Comment `<!-- -->` | | missing | | |
| Hyperlink | Ctrl+K | missing | | Ctrl+K is AI Rewrite when AI is on |
| Image (insert from file) | Ctrl+Shift+I | missing | | paste/drop only |
| Image zoom / align | | missing | | |
| Clear format | Ctrl+\ | missing | | |
| Open link / copy link address | Ctrl+click | partial | | Ctrl+click opens |

## View

| Item | Shortcut | Before | After | Notes |
|---|---|---|---|---|
| Source code mode | Ctrl+/ | done | done | menu + footer + shortcut |
| Focus mode | F8 | missing | | |
| Typewriter mode | F9 | missing | | |
| Toggle sidebar | Ctrl+Shift+L | partial | done | menu + shortcut + footer |
| Outline | Ctrl+Shift+1 | partial | done | menu shows the outline tab |
| Articles (file list view) | Ctrl+Shift+2 | missing | done | #file-library-list excerpt, time, parent |
| File tree | Ctrl+Shift+3 | partial | done | tree + footer toolbar |
| Status bar toggle | | missing | | footer always shown |
| Word count (footer, popover) | | partial | | words only |
| Full screen | F11 | missing | | |
| Always on top | | missing | | |
| Zoom in / out / actual size | Ctrl+Shift+= / Ctrl+Shift+- / Ctrl+Shift+0 | missing | | WebView2 page zoom only (win-broken) |
| Formatting toolbar | | missing | | |
| Readonly mode | | missing | | |
| Toggle DevTools | | n/a | | release builds |
| Command palette | Ctrl+Shift+P | done | done | View menu + shortcut |

## Themes and Help

| Item | Shortcut | Before | After | Notes |
|---|---|---|---|---|
| Themes menu listing theme CSS files | | partial | done | radio items + footer select |
| Open theme folder | | missing | done | reveal_path on the config themes dir (browser: toast) |
| base.user.css / name.user.css | | done | | |
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
| Outline: collapse / expand | | missing | | |
| File tree keyboard navigation | | missing | done | arrows, Enter, F2, Delete |
| Live refresh when files change on disk | | missing | partial | refresh on focus and after our own operations |

## Quick insert (Typora has no slash menu; these are its Markdown input rules and shortcuts)

| Item | Shortcut | Before | After | Notes |
|---|---|---|---|---|
| `#`–`######` + space → heading | | done | | |
| `>` + space → quote | | done | | |
| `-`/`*`/`+` + space → bullet list | | done | | |
| `1.` + space → ordered list | | done | | |
| `[ ]` / `[x]` + space → task list (top level) | | partial | | only inside an existing list item |
| ```` ```lang ```` + space/Enter → code fence | | partial | | space only |
| `$$` + Enter/space → math block | | partial | | space only |
| `---` / `***` → horizontal rule | | done | | |
| `**x**`, `*x*`, `` `x` ``, `~~x~~`, `==x==`, `$x$` | | done | | |
| `<u>x</u>` underline, `^x^` sup, `~x~` sub | | missing | | |
| `[TOC]` + Enter → TOC | | partial | | only on reload |
| `---` on the first line → YAML front matter | | missing | | becomes a horizontal rule |
| `|a|b|` + Enter → table | | missing | | |
| `[^1]:` footnote, `[x]: url` ref | | done | | defs plugin |
| Core slash menu `/` (headings, lists, quote, table, code, math, mermaid, hr, TOC, footnote, front matter, image) | | missing | | engine present, only AI registered an item |
| Editor context menu (format / insert / paragraph / table) | | missing | | WebView2/WebKit default menu |
| Image settings (copy to ./assets etc.) | | done | | Settings → Images |
| Insert image from file dialog | | missing | | |

## Status bar

| Item | Shortcut | Before | After | Notes |
|---|---|---|---|---|
| Word count | | done | | |
| Source-mode toggle button | | done | | |
| Sidebar toggle button | | done | | |
| Theme switcher | | done | | MD Nest extra |
| Character / line count popover | | missing | | |

## Windows-specific

| Item | Shortcut | Before | After | Notes |
|---|---|---|---|---|
| Relative / local images (`mdfile` URLs for `C:\…` paths) | | win-broken | done | frontend forward slashes; decoder accepts drive letters |
| Browser accelerators off (Ctrl+P print, Ctrl+R/F5 reload, page zoom) | | win-broken | done | WebView2 settings + frontend swallow |
| No Edge default context menu (Back/Refresh/Print) | | win-broken | done | WebView2 settings + frontend preventDefault |
| `body.os-windows` class for themes | | win-broken | done | os-windows / os-linux / is-mac, including export |
| Native file dialogs (open/save/folder) | | done | | dialog:default capability |
| Ctrl shortcuts (Mod = Ctrl) | | done | | |
