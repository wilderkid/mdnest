import { blockPosForLine } from "./editor/lines";
import { TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import "codemirror/lib/codemirror.css";
import "prosemirror-view/style/prosemirror.css";
import "prosemirror-tables/style/tables.css";
import "./styles/base.css";
import { host } from "./host";
import { createEditor, Editor } from "./editor/editor";
import { setImageBase } from "./editor/schema";
import { SourceMode } from "./shell/source";
import { Sidebar } from "./shell/sidebar";
import { ThemeManager, displayName } from "./shell/themes";
import { openPalette } from "./shell/palette";
import { PluginManager, Command, SettingSpec, DecorationProvider, cancelPendingSuggestions } from "./plugins/api";
import { escapeHtml } from "./editor/render";
import { openPrompt } from "./editor/prompt";
import { countWords } from "./plugins/builtin/word-stats";
import wordStats from "./plugins/builtin/word-stats";
import readingGoal from "./plugins/builtin/reading-goal";
import ai from "./plugins/builtin/ai";
import library from "./plugins/builtin/library";
import { FindBar, SourceSearch } from "./shell/findbar";
import { EditorSearch } from "./editor/search";
import { insertImageFiles, IMAGE_FOLDER_KEY, imageFolderPattern } from "./shell/images";
import { buildExportHtml, printHtml } from "./shell/export";
import { insertTable } from "./editor/tabletools";
import { setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { wrapInList } from "prosemirror-schema-list";
import { undo, redo } from "prosemirror-history";
import { schema } from "./editor/schema";
import {
  installKeyboardDispatcher, installPageKeyGuard, installContextMenuGuard, runFocusAware, commandEnabled,
} from "./shell/commands";
import { buildMenuSpec, renderMenuBar, menuBarVisible, type MenuState } from "./shell/menu";
import { applyOsClass, osClass } from "./shell/os";
import { handleNativeDrop, pathsFromUriList, type NativeDrop } from "./shell/drop";

const WELCOME = `# Welcome to MD Nest\n\nOpen a file (Ctrl+O) or a folder (Ctrl+Shift+O). Toggle source mode with Ctrl+/ and the command palette with Ctrl+Shift+P.\n`;

const state = { path: null as string | null, dirty: false, lastSaved: "", mtime: null as number | null, conflict: false };
const commands: Command[] = [];
const decorationProviders: DecorationProvider[] = [];
// citation / search-hit jump highlight: a node decoration survives the block re-rendering
// (syntax reveal) that a plain DOM class would not
let citeFlash: { doc: unknown; from: number; to: number } | null = null;
decorationProviders.push((st) => citeFlash && citeFlash.doc === st.doc ? DecorationSet.create(st.doc, [Decoration.node(citeFlash.from, citeFlash.to, { class: "md-cite-flash" })]) : null);
const settingSpecs: { owner: string; specs: SettingSpec[] }[] = [];

document.body.classList.add(osClass(), "pin-outline");
applyOsClass();
const sidebar = new Sidebar(host, (p) => openFile(p));
document.body.appendChild(sidebar.el);
const content = document.createElement("content"); document.body.appendChild(content);
const writeEl = document.createElement("div"); content.appendChild(writeEl);
const source = new SourceMode(document.body, () => { setDirty(true); scheduleAutosave(); });
const footer = document.createElement("footer"); footer.className = "ty-footer";
footer.innerHTML = `<button id="sidebar-toggle" title="Toggle sidebar">☰</button><span id="file-title">Untitled</span><span class="footer-spacer"></span>
  <span id="footer-word-count"></span><select id="theme-select" title="Theme"></select><button id="source-toggle" title="Source mode (Ctrl+/)">&lt;/&gt;</button>`;
document.body.appendChild(footer);
const toast = document.createElement("div"); toast.id = "mdn-toast"; document.body.appendChild(toast);
let toastTimer: any;
const notify = (m: string) => { toast.textContent = m; toast.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("show"), 2600); };

let changeTimer: any;
// Set by the keyboard dispatcher just before it runs a command, so the editor keymap
// (installed below) does not run the same shortcut a second time.
let claimedUntil = 0;
let claimedId = "";
const editor: Editor = createEditor(writeEl, WELCOME, {
  decorationProviders,
  onChange: () => {
    // dirty = serialized Markdown differs from what is on disk (marker expand/collapse alone is not an edit)
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      const d = editor.getMarkdown() !== state.lastSaved; setDirty(d); if (d) scheduleAutosave();
      sidebar.updateOutline(editor.view); updateCount(); plugins.emit("doc-changed");
    }, 150);
  },
  onImageFiles: (files, pos) => { insertImageFiles(editor.view, host, state.path, files, pos, notify); return true; },
  keys: {
    toggleSource: () => { if (Date.now() < claimedUntil && claimedId === "view.source") return; toggleSource(); },
    save: () => { if (Date.now() < claimedUntil && claimedId === "file.save") return; save(false); },
    saveAs: () => { if (Date.now() < claimedUntil && claimedId === "file.saveAs") return; save(true); },
    open: () => { if (Date.now() < claimedUntil && claimedId === "file.open") return; pickAndOpen(); },
    openFolder: () => { if (Date.now() < claimedUntil && claimedId === "file.openFolder") return; pickFolder(); },
    palette: () => { if (Date.now() < claimedUntil && claimedId === "view.palette") return; openPalette(commands); },
    claimed: (id: string) => Date.now() < claimedUntil && claimedId === id,
  },
  commands: () => commands,
});
editor.view.dom.id = "write";

function setDirty(d: boolean) { state.dirty = d; document.getElementById("file-title")!.classList.toggle("dirty", d); }
function updateCount() { const t = editor.view.state.doc.textContent; const { words } = countWords(t); document.getElementById("footer-word-count")!.textContent = `${words} words`; }
function setTitle() {
  const name = state.path ? state.path.split(/[\\/]/).pop()! : "Untitled";
  document.getElementById("file-title")!.textContent = name; document.title = name + " — MD Nest";
}

function currentMarkdown() { return source.active ? source.value() : editor.getMarkdown(); }
function toggleSource() {
  // Suggestions are decorations. Drop them before the document is replaced or hidden.
  cancelPendingSuggestions(editor.view);
  if (source.active) { const md = source.hide(); editor.setMarkdown(md); afterLoad(); editor.view.focus(); }
  else source.show(editor.getMarkdown());
  findBar.refresh();
}
function afterLoad() { sidebar.updateOutline(editor.view); updateCount(); }

async function openFile(path: string) {
  try {
    const text = await host.readFile(path);
    cancelPendingSuggestions(editor.view);
    state.path = path; const dir = path.replace(/[\\/][^\\/]*$/, "");
    setImageBase(host.fileUrl(dir + "/"));
    if (source.active) source.show(text); editor.setMarkdown(text);
    state.lastSaved = editor.getMarkdown(); setDirty(false); setTitle(); afterLoad(); sidebar.markActive(path);
    state.mtime = await host.mtime(path).catch(() => null); state.conflict = false; addRecent(path);
    localStorage.setItem("mdnest.lastFile", path); plugins.emit("file-opened", path);
  } catch (e: any) { notify("Open failed: " + (e.message ?? e)); }
}
/** Open a file and reveal the top-level block at a 1-based source line, briefly highlighted. */
async function openAt(path: string, line?: number) {
  if (state.path !== path) {
    if (state.dirty) await save(false);
    await openFile(path);
    if (state.path !== path) return;
  }
  if (!line || source.active) return;
  const v = editor.view;
  const hit = blockPosForLine(v.state.doc, state.lastSaved ?? editor.getMarkdown(), line);
  if (!hit) return;
  const node = v.state.doc.nodeAt(hit.pos);
  const inside = Math.min(hit.pos + 1, v.state.doc.content.size);
  v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(inside))).scrollIntoView());
  v.focus();
  if (!node) return;
  citeFlash = { doc: v.state.doc, from: hit.pos, to: hit.pos + node.nodeSize };
  v.dispatch(v.state.tr.setMeta("addToHistory", false));
  const mine = citeFlash;
  setTimeout(() => { if (citeFlash === mine) { citeFlash = null; editor.view.dispatch(editor.view.state.tr.setMeta("addToHistory", false)); } }, 1800);
}
async function pickAndOpen() { const p = await host.pickFile(); if (p) openFile(p); }
async function pickFolderPath(p: string) { await sidebar.openFolder(p); localStorage.setItem("mdnest.lastFolder", p); plugins.emit("workspace-changed", p); }
async function pickFolder() { const p = await host.pickFolder(); if (p) await pickFolderPath(p); }
let quietSave = false;
async function save(as: boolean) {
  let p = state.path;
  if (as || !p) p = await host.pickSavePath(p ? p.split(/[\\/]/).pop() : "untitled.md");
  if (!p) return;
  const md = currentMarkdown();
  try {
    await host.writeFile(p, md); const first = state.path !== p; state.path = p; state.lastSaved = md; setDirty(false); setTitle();
    state.mtime = await host.mtime(p).catch(() => null); state.conflict = false;
    if (first) { setImageBase(host.fileUrl(p.replace(/[\\/][^\\/]*$/, "") + "/")); addRecent(p); }
    if (!quietSave) notify("Saved " + p); plugins.emit("file-saved", p);
  }
  catch (e: any) { notify("Save failed: " + (e.message ?? e)); }
}

// ---------- autosave, recent files, file watching ----------
const AUTOSAVE_KEY = "mdnest.autosave";
const REOPEN_KEY = "mdnest.reopenLast"; // "0" = start with the welcome page (default: reopen last file)
let autosaveTimer: any;
function scheduleAutosave() {
  if (localStorage.getItem(AUTOSAVE_KEY) !== "1" || !state.path) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => { if (state.dirty && state.path && !state.conflict) { quietSave = true; await save(false); quietSave = false; } }, 1500);
}
const RECENT_KEY = "mdnest.recent";
const recent = (): string[] => JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
function addRecent(p: string) {
  const list = [p, ...recent().filter((x) => x !== p)].slice(0, 12);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list)); renderRecent();
}
let recentEl: HTMLElement | null = null;
function renderRecent() {
  if (!recentEl) return;
  recentEl.innerHTML = recent().map((p) => `<div class="file-library-node file-tree-node recent-file" data-path="${p.replace(/"/g, "&quot;")}"><div class="file-node-content"><span class="file-node-icon">◦</span><span class="file-node-title">${p.split(/[\\/]/).pop()}</span></div><div class="recent-dir">${p.replace(/[\\/][^\\/]*$/, "")}</div></div>`).join("") || `<div class="outline-item" style="opacity:.6">No recent files</div>`;
  recentEl.querySelectorAll<HTMLElement>(".recent-file").forEach((n) => (n.onclick = () => openFile(n.dataset.path!)));
}
async function reloadFromDisk(force = false) {
  if (!state.path) return;
  if (state.dirty && !force) { state.conflict = true; notify("File changed on disk — you have unsaved edits. Run “File: Reload from Disk” to discard them, or save to overwrite."); return; }
  const scroll = content.scrollTop; const p = state.path;
  await openFile(p); content.scrollTop = scroll; notify("Reloaded — file changed on disk");
}
setInterval(async () => {
  if (!state.path || document.hidden) return;
  const m = await host.mtime(state.path).catch(() => null);
  if (m != null && state.mtime != null && m > state.mtime + 1) { state.mtime = m; reloadFromDisk(); }
}, 2000);

// ---------- find / replace ----------
const editorSearch = new EditorSearch(editor.view);
const sourceSearch = new SourceSearch(() => source.cm);
const findBar = new FindBar(() => (source.active ? sourceSearch : editorSearch), notify);
function openFind(replace: boolean) {
  const seed = source.active ? source.cm?.getSelection() : editor.view.state.doc.textBetween(editor.view.state.selection.from, editor.view.state.selection.to);
  findBar.open(replace, seed || undefined);
}

// ---------- export ----------
const docStem = () => (state.path ? state.path.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "") : "untitled");
const docDir = () => (state.path ? state.path.replace(/[\\/][^\\/]*$/, "") : null);
async function exportHtmlString(forPrint: boolean) {
  if (source.active) editor.setMarkdown(source.value());
  const dir = docDir();
  return buildExportHtml(editor.getDoc(), host, {
    theme: themes.current, themeFiles: themes.files, title: docStem(), keepRelativeImages: !forPrint,
    baseHref: forPrint && dir ? new URL(host.fileUrl(dir + "/"), location.href).href : undefined,
  });
}
async function exportHtml(out?: string) {
  const p = out ?? (await host.pickSavePath(docStem() + ".html", "html")); if (!p) return;
  notify("Exporting HTML…");
  const html = await exportHtmlString(false);
  await host.writeFile(p, html); notify("Exported " + p); return p;
}
async function exportPdf(out?: string) {
  const html = await exportHtmlString(true);
  try {
    const p = out ?? (await host.pickSavePath(docStem() + ".pdf", "pdf")); if (!p) return;
    notify("Exporting PDF…");
    await host.exportPdf(html, p); notify("Exported " + p); return p;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes("unsupported")) { printHtml(html); return; } // system print dialog → "Save as PDF"
    notify("PDF export failed: " + msg + (out ? "" : " — opening the print dialog instead"));
    if (!out) printHtml(html); // interactive: native path failed (e.g. untested macOS/Windows engines) → dialog
    else throw e;
  }
}

// ---------- themes ----------
const themes = new ThemeManager(host, (n) => plugins?.emit("theme-changed", n));
const sel = document.getElementById("theme-select") as HTMLSelectElement;
sel.onchange = () => themes.apply(sel.value);
async function initThemes() {
  const list = await themes.refresh();
  sel.innerHTML = list.map((t) => `<option value="${t}">${displayName(t)}</option>`).join("");
  const want = new URLSearchParams(location.search).get("theme") ?? localStorage.getItem("mdnest.theme") ?? "mdnest";
  await themes.apply(want); sel.value = themes.current;
}

// ---------- commands & plugins ----------
const addCmd = (c: Command) => { const i = commands.findIndex((x) => x.id === c.id); if (i >= 0) commands.splice(i, 1); commands.push(c); };
const plugins = new PluginManager({
  addCommand: (c) => addCmd(c), runCommand: (id) => commands.find((c) => c.id === id)?.run(),
  addSidebarPanel: (p) => sidebar.addTab("p-" + p.id, p.title, undefined, p),
  notify,
  revealPanel: (id) => sidebar.reveal(id),
  prompt: (opts) => openPrompt(editor.view, opts),
  addDecorations: (p) => decorationProviders.push(p),
  getMarkdown: () => currentMarkdown(),
  getState: () => editor.view.state,
  getView: () => editor.view,
  getFilePath: () => state.path,
  getWorkspaceRoot: () => sidebar.root,
  openAt: (path, line) => openAt(path, line),
  refreshDecorations: () => editor.refreshDecorations(),
  addSettings: (owner, specs) => settingSpecs.push({ owner, specs }),
  getSetting: (owner, key) => {
    const raw = localStorage.getItem(plugins.settingKey(owner, key));
    return raw == null ? undefined : JSON.parse(raw);
  },
  settingsFor: (owner) => settingSpecs.find((s) => s.owner === owner)?.specs ?? [],
  commitSetting: (owner, key, value) => plugins.commitSetting(owner, key, value),
  host,
});
[
  { id: "file.open", title: "File: Open…", key: "Ctrl+O", run: pickAndOpen },
  { id: "file.openFolder", title: "File: Open Folder…", key: "Ctrl+Shift+O", run: pickFolder },
  { id: "file.save", title: "File: Save", key: "Ctrl+S", run: () => save(false) },
  { id: "file.saveAs", title: "File: Save As…", key: "Ctrl+Shift+S", run: () => save(true) },
  { id: "view.source", title: "View: Toggle Source Mode", key: "Ctrl+/", run: toggleSource },
  { id: "view.sidebar", title: "View: Toggle Sidebar", run: () => document.body.classList.toggle("pin-outline") },
  { id: "view.outline", title: "View: Show Outline", run: () => { document.body.classList.add("pin-outline"); sidebar.select("outline"); } },
  { id: "edit.find", title: "Edit: Find…", key: "Ctrl+F", run: () => openFind(false) },
  { id: "edit.replace", title: "Edit: Replace…", key: "Ctrl+H", run: () => openFind(true) },
  { id: "insert.table", title: "Insert: Table (3×3)", key: "Ctrl+T", run: () => { insertTable(3, 3)(editor.view.state, editor.view.dispatch); editor.view.focus(); } },
  { id: "file.exportHtml", title: "File: Export HTML…", run: () => exportHtml() },
  { id: "file.exportPdf", title: "File: Export PDF…", run: () => exportPdf() },
  { id: "file.reload", title: "File: Reload from Disk", run: () => reloadFromDisk(true) },
  { id: "file.autosave", title: "File: Toggle Autosave", run: () => { const on = localStorage.getItem(AUTOSAVE_KEY) !== "1"; localStorage.setItem(AUTOSAVE_KEY, on ? "1" : "0"); notify("Autosave " + (on ? "on" : "off")); } },
  { id: "view.recent", title: "View: Recent Files", run: () => { document.body.classList.add("pin-outline"); sidebar.select("recent"); } },
  { id: "view.settings", title: "Preferences: Settings", run: () => { document.body.classList.add("pin-outline"); sidebar.select("settings"); } },
].forEach(addCmd);

const MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform + navigator.userAgent);
const later = (part: 2 | 3) => () => notify("Coming in part " + part);
function stub(id: string, title: string, key: string | undefined, part: 2 | 3) {
  if (commands.some((c) => c.id === id)) return;
  addCmd({ id, title, ...(key ? { key } : {}), run: later(part) });
}
// Items whose features land in later parts. The id stays; only `run` is replaced.
const PART2: [string, string, string?][] = [
  ["file.new", "File: New", "CmdOrCtrl+N"],
  ["file.newWindow", "File: New Window", "CmdOrCtrl+Shift+N"],
  ["file.quickOpen", "File: Open Quickly…", "CmdOrCtrl+P"],
  ["file.reopenClosed", "File: Reopen Closed File", "CmdOrCtrl+Shift+T"],
  ["file.moveTo", "File: Move To…"],
  ["file.rename", "File: Rename…"],
  ["file.duplicate", "File: Duplicate"],
  ["file.openLocation", "File: Open File Location"],
  ["file.revealSidebar", "File: Reveal in Sidebar"],
  ["file.print", "File: Print…", "CmdOrCtrl+Alt+P"],
  ["file.close", "File: Close", "CmdOrCtrl+W"],
  ["file.quit", "File: Quit", "CmdOrCtrl+Q"],
  ["file.clearRecent", "File: Clear Recent Items"],
  ["file.exportHtmlPlain", "File: Export HTML (without styles)"],
  ["view.articles", "View: Articles", "CmdOrCtrl+Shift+2"],
  ["view.fileTree", "View: File Tree", "CmdOrCtrl+Shift+3"],
  ["view.searchFolder", "View: Search in Folder", "CmdOrCtrl+Shift+F"],
  ["themes.openFolder", "Themes: Open Theme Folder"],
  ["help.markdown", "Help: Markdown Reference"],
  ["help.shortcuts", "Help: Keyboard Shortcuts"],
  ["help.dataFolder", "Help: Open Data Folder"],
];
const PART3: [string, string, string?][] = [
  ["edit.copyMarkdown", "Edit: Copy as Markdown", "CmdOrCtrl+Shift+C"],
  ["edit.copyHtml", "Edit: Copy as HTML Code"],
  ["edit.copyPlain", "Edit: Copy as Plain Text"],
  ["edit.pastePlain", "Edit: Paste as Plain Text", "CmdOrCtrl+Shift+V"],
  ["edit.delete", "Edit: Delete"],
  ["edit.selectLine", "Edit: Select Line/Sentence", "CmdOrCtrl+L"],
  ["edit.selectScope", "Edit: Select Styled Scope", "CmdOrCtrl+E"],
  ["edit.selectWord", "Edit: Select Word", "CmdOrCtrl+D"],
  ["edit.jumpTop", "Edit: Jump to Top", "CmdOrCtrl+Home"],
  ["edit.jumpBottom", "Edit: Jump to Bottom", "CmdOrCtrl+End"],
  ["edit.findNext", "Edit: Find Next", "F3"],
  ["edit.findPrevious", "Edit: Find Previous", "Shift+F3"],
  ["edit.autoPair.brackets", "Edit: Auto Pair Brackets and Quotes"],
  ["edit.autoPair.markdown", "Edit: Auto Pair Markdown Syntax"],
  ["paragraph.increaseHeading", "Paragraph: Increase Heading Level", "CmdOrCtrl+="],
  ["paragraph.decreaseHeading", "Paragraph: Decrease Heading Level", "CmdOrCtrl+-"],

  ["paragraph.table.addRowAbove", "Table: Add Row Above"],
  ["paragraph.table.addRowBelow", "Table: Add Row Below"],
  ["paragraph.table.addColBefore", "Table: Add Column Before"],
  ["paragraph.table.addColAfter", "Table: Add Column After"],
  ["paragraph.table.deleteRow", "Table: Delete Row"],
  ["paragraph.table.deleteColumn", "Table: Delete Column"],
  ["paragraph.table.deleteTable", "Table: Delete Table"],
  ["paragraph.mathBlock", "Paragraph: Math Block", "CmdOrCtrl+Shift+M"],
  ["paragraph.taskList", "Paragraph: Task List", "CmdOrCtrl+Shift+X"],
  ["paragraph.indent", "Paragraph: Indent", "CmdOrCtrl+]"],
  ["paragraph.outdent", "Paragraph: Outdent", "CmdOrCtrl+["],
  ["paragraph.insertBefore", "Paragraph: Insert Paragraph Before"],
  ["paragraph.insertAfter", "Paragraph: Insert Paragraph After"],
  ["paragraph.linkRef", "Paragraph: Link Reference"],
  ["paragraph.footnote", "Paragraph: Footnote"],
  ["paragraph.hr", "Paragraph: Horizontal Line"],
  ["paragraph.toc", "Paragraph: Table of Contents"],
  ["paragraph.frontMatter", "Paragraph: YAML Front Matter"],
  ["paragraph.alert.note", "Alert: Note"],
  ["paragraph.alert.tip", "Alert: Tip"],
  ["paragraph.alert.important", "Alert: Important"],
  ["paragraph.alert.warning", "Alert: Warning"],
  ["paragraph.alert.caution", "Alert: Caution"],
  ["paragraph.mermaid", "Paragraph: Mermaid Diagram"],
  ["paragraph.deleteBlock", "Paragraph: Delete Block"],
  ["format.underline", "Format: Underline", "CmdOrCtrl+U"],
  ["format.highlight", "Format: Highlight"],
  ["format.inlineMath", "Format: Inline Math"],
  ["format.superscript", "Format: Superscript"],
  ["format.subscript", "Format: Subscript"],
  ["format.comment", "Format: Comment"],
  ["format.link", "Format: Hyperlink", "CmdOrCtrl+K"],
  ["format.image", "Format: Insert Local Image…", "CmdOrCtrl+Shift+I"],
  ["format.image.zoom50", "Image: Zoom 50%"],
  ["format.image.zoom100", "Image: Zoom 100%"],
  ["format.image.zoom200", "Image: Zoom 200%"],
  ["format.clear", "Format: Clear Format", "CmdOrCtrl+\\"],
  ["view.focus", "View: Focus Mode", "F8"],
  ["view.typewriter", "View: Typewriter Mode", "F9"],
  ["view.toolbar", "View: Formatting Toolbar"],
  ["view.statusBar", "View: Status Bar"],
  ["view.wordCount", "View: Word Count"],
  ["view.fullScreen", "View: Full Screen", "F11"],
  ["view.alwaysOnTop", "View: Always on Top"],
  ["view.actualSize", "View: Actual Size", "CmdOrCtrl+Shift+0"],
  ["view.zoomIn", "View: Zoom In", "CmdOrCtrl+Shift+="],
  ["view.zoomOut", "View: Zoom Out", "CmdOrCtrl+Shift+-"],
];
for (const [id, title, key] of PART2) stub(id, title, key, 2);
for (const [id, title, key] of PART3) stub(id, title, key, 3);

function pmRun(fn: (state: any, dispatch?: any, view?: any) => boolean) {
  const v = editor.view;
  fn(v.state, v.dispatch, v);
  v.focus();
}
const headingCmd = (level: number) => () => pmRun(setBlockType(schema.nodes.heading, { level }));
const markCmd = (name: string) => () => pmRun(toggleMark(schema.marks[name]));
[
  { id: "edit.undo", title: "Edit: Undo", key: "CmdOrCtrl+Z", run: () => pmRun(undo) },
  { id: "edit.redo", title: "Edit: Redo", key: MAC ? "Cmd+Shift+Z" : "CmdOrCtrl+Y", run: () => pmRun(redo) },
  { id: "edit.selectAll", title: "Edit: Select All", key: "CmdOrCtrl+A", run: () => {
    const v = editor.view;
    const sel = TextSelection.create(v.state.doc, 0, v.state.doc.content.size);
    v.dispatch(v.state.tr.setSelection(sel));
    v.focus();
  } },
  { id: "paragraph.heading.1", title: "Paragraph: Heading 1", key: "CmdOrCtrl+1", run: headingCmd(1) },
  { id: "paragraph.heading.2", title: "Paragraph: Heading 2", key: "CmdOrCtrl+2", run: headingCmd(2) },
  { id: "paragraph.heading.3", title: "Paragraph: Heading 3", key: "CmdOrCtrl+3", run: headingCmd(3) },
  { id: "paragraph.heading.4", title: "Paragraph: Heading 4", key: "CmdOrCtrl+4", run: headingCmd(4) },
  { id: "paragraph.heading.5", title: "Paragraph: Heading 5", key: "CmdOrCtrl+5", run: headingCmd(5) },
  { id: "paragraph.heading.6", title: "Paragraph: Heading 6", key: "CmdOrCtrl+6", run: headingCmd(6) },
  { id: "paragraph.paragraph", title: "Paragraph: Paragraph", key: "CmdOrCtrl+0", run: () => pmRun(setBlockType(schema.nodes.paragraph)) },
  { id: "paragraph.quote", title: "Paragraph: Quote", key: "CmdOrCtrl+Shift+Q", run: () => pmRun(wrapIn(schema.nodes.blockquote)) },
  { id: "paragraph.orderedList", title: "Paragraph: Ordered List", key: "CmdOrCtrl+Shift+[", run: () => pmRun(wrapInList(schema.nodes.ordered_list)) },
  { id: "paragraph.unorderedList", title: "Paragraph: Unordered List", key: "CmdOrCtrl+Shift+]", run: () => pmRun(wrapInList(schema.nodes.bullet_list)) },
  { id: "paragraph.codeFence", title: "Paragraph: Code Fences", key: "CmdOrCtrl+Shift+K", run: () => pmRun(setBlockType(schema.nodes.code_block)) },
  { id: "paragraph.tableDialog", title: "Paragraph: Table…", key: "CmdOrCtrl+T", run: () => { insertTable(3, 3)(editor.view.state, editor.view.dispatch); editor.view.focus(); } },
  { id: "format.strong", title: "Format: Strong", key: "CmdOrCtrl+B", run: markCmd("strong") },
  { id: "format.emphasis", title: "Format: Emphasis", key: "CmdOrCtrl+I", run: markCmd("em") },
  { id: "format.code", title: "Format: Code", key: "CmdOrCtrl+Shift+`", run: markCmd("code") },
  { id: "format.strike", title: "Format: Strike", key: "Alt+Shift+5", run: markCmd("strike") },
  { id: "file.preferences", title: "File: Preferences…", key: "CmdOrCtrl+,", run: () => { document.body.classList.add("pin-outline"); sidebar.select("settings"); } },
  { id: "help.about", title: "Help: About MD Nest", run: () => notify("MD Nest 0.1.1") },
  { id: "view.palette", title: "View: Command Palette", key: "CmdOrCtrl+Shift+P", run: () => openPalette(commands) },
].forEach(addCmd);
// Recent-file slots. `run` is replaced whenever the recent list changes.
for (let i = 0; i < 12; i++) addCmd({ id: "file.recent." + i, title: "File: Recent", run: () => {} });
for (const t of [] as string[]) addCmd({ id: "theme." + t, title: "Theme: " + t, run: () => themes.apply(t) });

function syncRecentCommands() {
  const list = recent();
  for (let i = 0; i < 12; i++) {
    const p = list[i];
    addCmd({
      id: "file.recent." + i,
      title: p ? "File: " + p.split(/[\\/]/).pop() : "File: Recent",
      when: () => i < recent().length,
      run: () => { const path = recent()[i]; if (path) openFile(path); },
    });
  }
}
function syncThemeCommands() {
  for (const name of themes.themes()) {
    addCmd({ id: "theme." + name, title: "Theme: " + name, run: () => themes.apply(name).then(() => { const s = document.getElementById("theme-select") as HTMLSelectElement | null; if (s) s.value = themes.current; refreshMenu(); }) });
  }
}

function menuState(): MenuState {
  let inTable = false;
  try { inTable = editor.view.state.selection.$from.node(1)?.type.name === "table" || !!editor.view.dom.querySelector("table .selectedCell, .ProseMirror-selectednode"); } catch { /* boot */ }
  try {
    const sel = editor.view.state.selection.$from;
    for (let d = sel.depth; d > 0; d--) if (sel.node(d).type.spec.tableRole) inTable = true;
  } catch { /* ignore */ }
  return {
    recent: recent(),
    themes: themes.themes(),
    currentTheme: themes.current,
    sourceMode: source.active,
    sidebar: document.body.classList.contains("pin-outline"),
    outline: document.body.classList.contains("ty-show-outline"),
    hasPath: !!state.path,
    inTable,
    pluginKeyOwners: new Set(),
  };
}

let menuTimer: any;
let lastSpec = "";
async function refreshMenu() {
  syncRecentCommands();
  syncThemeCommands();
  const spec = buildMenuSpec(commands, menuState(), MAC);
  const json = JSON.stringify(spec);
  if (json === lastSpec) return;
  lastSpec = json;
  if (menuEl) renderMenuBar(menuEl, spec, (id) => { dispatcher.note(id); void runCommand(id); });
  if (host.kind === "tauri") {
    try { const { invoke } = await import("@tauri-apps/api/core"); await invoke("set_app_menu", { spec }); }
    catch (e) { console.error("set_app_menu", e); }
  }
}
function scheduleMenu() { clearTimeout(menuTimer); menuTimer = setTimeout(() => { void refreshMenu(); }, 40); }

// The capture-phase dispatcher owns every menu accelerator, including ones the editor keymap
// also binds. `runCommand` tells the editor keymap to skip a key the dispatcher just claimed,
// so save / find / heading shortcuts still run once (and still work from CodeMirror).
const EDITOR_KEYS = new Set<string>();
function runCommand(id: string) {
  claimedId = id; claimedUntil = Date.now() + 50;
  if (id.startsWith("theme.")) { const name = id.slice(6); void themes.apply(name).then(() => { const s = document.getElementById("theme-select") as HTMLSelectElement | null; if (s) s.value = themes.current; scheduleMenu(); }); return; }
  const c = commands.find((x) => x.id === id);
  if (!c) return;
  if (c.when) { try { if (!c.when()) return; } catch { return; } }
  if (id === "edit.undo" || id === "edit.redo" || id === "edit.selectAll") {
    runFocusAware(id, document.activeElement, () => { void c.run(); });
  } else void c.run();
  scheduleMenu();
}
const dispatcher = installKeyboardDispatcher(() => commands, runCommand, () => {
  const set = new Set<string>();
  for (const c of commands) {
    if (!c.key || EDITOR_KEYS.has(c.id)) continue;
    // A plugin that owns a key (AI Rewrite = Mod-k) keeps it. Do not also dispatch a core item.
    set.add(c.id);
  }
  // Focus-aware editing keys are dispatched here so an <input> or CodeMirror is edited in place.
  // Hyperlink is CmdOrCtrl+K, the same key as AI Rewrite. While AI owns it, do not dispatch.
  const ai = commands.find((c) => c.id === "ai.rewrite" || c.id === "rewrite");
  if (ai && commandEnabled(ai)) set.delete("format.link");
  set.add("edit.undo"); set.add("edit.redo"); set.add("edit.selectAll");
  return set;
});
installPageKeyGuard();
installContextMenuGuard();

const menuEl = document.createElement("div");
if (menuBarVisible(host.kind)) {
  document.body.classList.add("mdn-menubar-on");
  document.body.insertBefore(menuEl, document.body.firstChild);
}

document.getElementById("sidebar-toggle")!.onclick = () => { document.body.classList.toggle("pin-outline"); scheduleMenu(); };
document.getElementById("source-toggle")!.onclick = () => { toggleSource(); scheduleMenu(); };
document.addEventListener("keydown", (e) => {
  // Reject a pending suggestion even when focus has left the editor (palette, prompt, sidebar).
  if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !source.active && document.querySelector("#write .md-sug")) {
    e.preventDefault();
    cancelPendingSuggestions(editor.view);
    return;
  }
}, true);

plugins.activateAll([readingGoal, wordStats, ai, library]); // order irrelevant: topo-sorted by depends
sidebar.addTab("settings", "⚙", undefined, {
  id: "settings", title: "Settings", render: (el) => {
    const folder = imageFolderPattern();
    const core = `<h4>Editor</h4><label><input type="checkbox" id="set-autosave" ${localStorage.getItem(AUTOSAVE_KEY) === "1" ? "checked" : ""}> Autosave (1.5 s after edits)</label>
      <label><input type="checkbox" id="set-reopen" ${localStorage.getItem(REOPEN_KEY) !== "0" ? "checked" : ""}> Reopen last file on startup</label>
      <h4>Images</h4><label>When pasting / dropping images, copy them to<br><select id="set-imgfolder">
      ${["./assets", "./${filename}.assets"].map((o) => `<option value="${o}" ${o === folder ? "selected" : ""}>${o}</option>`).join("")}
      <option value="custom" ${["./assets", "./${filename}.assets"].includes(folder) ? "" : "selected"}>custom…</option></select>
      <input id="set-imgfolder-custom" type="text" value="${folder}" style="margin-top:4px"></label>`;
    el.innerHTML = `<div class="mdn-settings">` + core + settingSpecs.map(({ owner, specs }) => `<h4>${escapeHtml(owner)}</h4>` + specs.map((s) => renderSetting(owner, s)).join("")).join("") + (plugins.errors.length ? `<h4>Plugin errors</h4>` + plugins.errors.map((e) => `<div>${escapeHtml(e.id)}: ${escapeHtml(e.error)}</div>`).join("") : "") + `</div>`;
    (el.querySelector("#set-autosave") as HTMLInputElement).onchange = (e) => localStorage.setItem(AUTOSAVE_KEY, (e.target as HTMLInputElement).checked ? "1" : "0");
    (el.querySelector("#set-reopen") as HTMLInputElement).onchange = (e) => localStorage.setItem(REOPEN_KEY, (e.target as HTMLInputElement).checked ? "1" : "0");
    const fsel = el.querySelector("#set-imgfolder") as HTMLSelectElement, fcus = el.querySelector("#set-imgfolder-custom") as HTMLInputElement;
    fsel.onchange = () => { if (fsel.value !== "custom") { localStorage.setItem(IMAGE_FOLDER_KEY, fsel.value); fcus.value = fsel.value; } else fcus.focus(); };
    fcus.onchange = () => { localStorage.setItem(IMAGE_FOLDER_KEY, fcus.value.trim() || "./assets"); fsel.value = ["./assets", "./${filename}.assets"].includes(fcus.value) ? fcus.value : "custom"; };
    el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("[data-o]").forEach((inp) => inp.onchange = () => {
      const v = inp instanceof HTMLInputElement && inp.type === "checkbox" ? inp.checked
        : inp instanceof HTMLInputElement && inp.type === "number" ? +inp.value : inp.value;
      const ok = plugins.commitSetting(inp.dataset.o!, inp.dataset.k!, v);
      if (!ok) {
        if (inp instanceof HTMLInputElement && inp.type === "checkbox") inp.checked = !inp.checked;
        else inp.value = String(JSON.parse(localStorage.getItem(plugins.settingKey(inp.dataset.o!, inp.dataset.k!)) ?? "null") ?? "");
        return;
      }
      editor.refreshDecorations();
    });
    el.querySelectorAll<HTMLButtonElement>("button[data-secret]").forEach((btn) => btn.onclick = () => saveOrClearSecret(btn));
    el.querySelectorAll<HTMLElement>("[data-secret-status]").forEach((node) => refreshSecretStatus(node));
  },
});

function renderSetting(owner: string, s: SettingSpec): string {
  if (s.when) { try { if (!s.when()) return ""; } catch { return ""; } }
  const raw = localStorage.getItem(plugins.settingKey(owner, s.key));
  const v = raw == null ? s.default : JSON.parse(raw);
  const title = escapeHtml(s.title);
  if (s.type === "note") return `<p class="mdn-note">${escapeHtml(s.text ?? s.title)}</p>`;
  if (s.type === "boolean") return `<label><input type="checkbox" data-o="${owner}" data-k="${s.key}" ${v ? "checked" : ""}> ${title}</label>`;
  if (s.type === "select") {
    const opts = (s.options ?? []).map((o) => `<option value="${escapeHtml(o.value)}" ${String(v) === o.value ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("");
    return `<label>${title}<br><select data-o="${owner}" data-k="${s.key}">${opts}</select></label>`;
  }
  if (s.type === "text") return `<label>${title}<br><textarea data-o="${owner}" data-k="${s.key}" rows="3">${escapeHtml(String(v ?? ""))}</textarea></label>`;
  if (s.type === "url") return `<label>${title}<br><input type="url" data-o="${owner}" data-k="${s.key}" data-type="url" value="${escapeHtml(String(v ?? ""))}"></label>`;
  if (s.type === "secret") {
    return `<div class="mdn-secret" data-secret-row="${owner}.${s.key}"><label>${title}</label>
      <input type="password" autocomplete="off" data-secret-input="${owner}.${s.key}" placeholder="not shown after save">
      <span class="mdn-secret-actions"><button type="button" data-secret="set" data-o="${owner}" data-k="${s.key}">Save</button>
      <button type="button" data-secret="clear" data-o="${owner}" data-k="${s.key}">Clear</button></span>
      <span class="mdn-secret-status" data-secret-status="${owner}.${s.key}">…</span></div>`;
  }
  return `<label>${title}<br><input type="${s.type === "number" ? "number" : "text"}" data-o="${owner}" data-k="${s.key}" value="${escapeHtml(String(v ?? ""))}"></label>`;
}

function hostSecretId(owner: string, key: string): string {
  // Host ids are `^[a-z0-9._-]{1,64}$`. Plugins pass camelCase (`apiKey`); the net path
  // lowercases via secretIdFor, so the settings form must store the same id.
  return `${owner}.${key}`.toLowerCase();
}

async function refreshSecretStatus(node: HTMLElement) {
  const id = node.dataset.secretStatus!;
  const dot = id.indexOf(".");
  const owner = id.slice(0, dot), key = id.slice(dot + 1);
  try {
    const sid = hostSecretId(owner, key);
    const [has, backend] = await Promise.all([host.secrets.has(sid), host.secrets.backend()]);
    node.textContent = has ? `stored ✓ (${backend})` : `not stored (${backend})`;
  } catch { node.textContent = "unavailable"; }
}

async function saveOrClearSecret(btn: HTMLButtonElement) {
  const owner = btn.dataset.o!, key = btn.dataset.k!;
  const sid = hostSecretId(owner, key);
  const row = btn.closest(".mdn-secret");
  const input = row?.querySelector("input") as HTMLInputElement | null;
  const status = row?.querySelector("[data-secret-status]") as HTMLElement | null;
  try {
    if (btn.dataset.secret === "clear") await host.secrets.delete(sid);
    else {
      const value = input?.value ?? "";
      if (!value) { notify("Enter a value to store"); return; }
      await host.secrets.set(sid, value);
      if (input) input.value = "";
    }
  } catch (e: any) { notify("Secret " + (e?.message ?? e)); }
  if (status) await refreshSecretStatus(status);
}
sidebar.addTab("recent", "Recent", undefined, { id: "recent", title: "Recent", render: (el) => { recentEl = el; renderRecent(); return () => (recentEl = null); } });
sidebar.select("files");
function onNativeDrop(drop: NativeDrop) {
  return handleNativeDrop(drop, {
    openFile,
    openFolder: (p) => pickFolderPath(p),
    view: editor.view,
    host,
    docPath: state.path,
    notify,
  });
}
(window as any).mdnest = { editor, host, notify, exportHtmlString, findBar, state, openAt, commands, runCommand, refreshMenu, dispatcher, handleNativeDrop: onNativeDrop };

window.addEventListener("beforeunload", (e) => { if (state.dirty && host.kind === "browser") e.preventDefault(); });

// ---------- boot ----------
(async () => {
  await initThemes();
  const q = new URLSearchParams(location.search);
  const cli = await host.cliFile().catch(() => null);
  const args = await host.cliArgs().catch(() => [] as string[]);
  // --no-restore (or ?restore=0, or the setting) → no last folder/file: start on the welcome page
  const restore = !args.includes("--no-restore") && q.get("restore") !== "0" && localStorage.getItem(REOPEN_KEY) !== "0";
  const ws = q.get("folder") ?? (cli ? cli.replace(/[\\/][^\\/]*$/, "") : null) ?? (restore ? localStorage.getItem("mdnest.lastFolder") : null) ?? (await host.defaultWorkspace());
  if (ws) { await sidebar.openFolder(ws).catch(() => {}); if (sidebar.root) plugins.emit("workspace-changed", sidebar.root); }
  const f = cli ?? q.get("file") ?? (restore ? localStorage.getItem("mdnest.lastFile") : null) ?? (restore && ws && host.kind === "browser" ? ws + "/sample.md" : null);
  if (f) await openFile(f); else afterLoad();
  if (q.get("sidebar") === "0") document.body.classList.remove("pin-outline");
  document.body.classList.add("mdn-ready");
  await refreshMenu();
  if (host.kind === "tauri") {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      await listen<string>("mdn-menu", (ev) => {
        const id = ev.payload;
        if (!id || dispatcher.recent(id)) return;
        dispatcher.note(id);
        runCommand(id);
      });
      await listen<{ paths?: string[]; position?: { x: number; y: number } }>("tauri://drag-drop", (ev) => {
        const paths = ev.payload?.paths ?? [];
        if (paths.length) void onNativeDrop({ paths, position: ev.payload?.position });
      });
    } catch (e) { console.error(e); }
  }
  document.addEventListener("drop", (e) => {
    const dt = e.dataTransfer;
    if (!dt) return;
    const raw = dt.getData("text/uri-list") || dt.getData("text/plain") || "";
    const paths = pathsFromUriList(raw);
    if (!paths.length) return;
    // Images stay with the editor's HTML5 handler. Folders and Markdown files open.
    if (paths.every((p) => /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?)$/i.test(p))) return;
    e.preventDefault();
    void onNativeDrop({ paths, position: { x: e.clientX, y: e.clientY } });
  }, true);
  let cliFailed = false;
  // CLI: mdnest doc.md [--theme name] [--export-html out.html] [--export-pdf out.pdf] [--quit] [--no-restore] [--debug-log path]
  const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  if (arg("--theme")) { await themes.apply(arg("--theme")!); sel.value = themes.current; }
  // --debug-log PATH: write clipboard/drag-and-drop event diagnostics to PATH (native testing aid)
  if (arg("--debug-log")) {
    const out = arg("--debug-log")!; const lines: string[] = []; let t: any = 0;
    const log = (m: string) => { lines.push(new Date().toISOString().slice(11, 23) + " " + m); clearTimeout(t); t = setTimeout(() => host.writeFile(out, lines.join("\n") + "\n").catch(() => {}), 200); };
    (window as any).mdnestDebug = log;
    for (const ev of ["paste", "drop", "beforeinput"]) document.addEventListener(ev, (e: any) => {
      const dt: DataTransfer | null = e.clipboardData ?? e.dataTransfer ?? null;
      const types = dt ? [...dt.types].join(",") : "-";
      const files = dt ? [...dt.files].map((f) => f.name + ":" + f.type + ":" + f.size).join(",") : "";
      const items = dt ? [...(dt.items ?? [])].map((i) => i.kind + ":" + i.type).join(",") : "";
      const data = dt ? [...dt.types].map((k) => k + "=" + JSON.stringify((() => { try { return dt.getData(k); } catch { return "?"; } })().replace(/ style="[^"]*"/g, "").slice(0, 400))).join(" ") : "";
      log(`${ev}${e.inputType ? "(" + e.inputType + ")" : ""} types=[${types}] files=[${files}] items=[${items}] ${data}`);
    }, true);
    log("debug log on");
  }
  try {
    if (arg("--export-html")) await exportHtml(arg("--export-html")!);
    if (arg("--export-pdf")) await exportPdf(arg("--export-pdf")!);
  } catch (e) { console.error(e); cliFailed = true; }
  if (args.includes("--quit")) host.quit(cliFailed ? 1 : 0);
})();
