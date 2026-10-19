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
import { addColumnAfter, addColumnBefore, addRowAfter, addRowBefore, deleteColumn, deleteRow, deleteTable, isInTable } from "prosemirror-tables";
import { setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { wrapInList, liftListItem, sinkListItem } from "prosemirror-schema-list";
import { undo, redo } from "prosemirror-history";
import { schema } from "./editor/schema";
import { registerCoreSlash, insertAlert, insertFootnote, insertFrontMatter, insertHr, insertLinkRef, insertMermaid, insertTask, insertToc } from "./editor/slash-core";
import {
  clearFormat, copyMarkdownText, copyPlainText, decreaseHeading, deleteBlock, deleteImage, deleteSelection,
  imageSelection, increaseHeading, insertParagraphAfter, insertParagraphBefore, jumpBottom, jumpTop,
  linkAt, selectLine, selectStyledScope, selectWord, selectionHtml, setImageZoom, toggleTaskList,
} from "./editor/editops";
import { pairBracketsOn, pairMarkdownOn, PAIR_BRACKETS_KEY, PAIR_MARKDOWN_KEY } from "./editor/autopair";
import { openContextMenu, type ContextItem } from "./shell/sidebar";
import { APP_VERSION } from "./version";
import {
  installKeyboardDispatcher, installPageKeyGuard, installContextMenuGuard, runFocusAware, commandEnabled,
} from "./shell/commands";
import { buildMenuSpec, renderMenuBar, menuBarVisible, type MenuState } from "./shell/menu";
import { applyOsClass, osClass } from "./shell/os";
import { handleNativeDrop, pathsFromUriList, type NativeDrop } from "./shell/drop";

/** Untitled empty document shown under the welcome page. Word count stays 0 while it is visible. */
const EMPTY_DOC = "";

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
const editor: Editor = createEditor(writeEl, EMPTY_DOC, {
  decorationProviders,
  onChange: () => {
    // dirty = serialized Markdown differs from what is on disk (marker expand/collapse alone is not an edit)
    if (welcomeVisible() && !state.path) hideWelcome();
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
  onSelect: () => { sidebar.highlightOutline(editor.view); try { paintToolbar(); } catch { /* boot */ } if (document.body.classList.contains("ty-on-typewriter-mode")) centerCaret(); },
  commands: () => commands,
});
editor.view.dom.id = "write";
editor.view.dom.addEventListener("pointerdown", () => { if (welcomeVisible() && !state.path) hideWelcome(); });

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
function afterLoad() { sidebar.updateOutline(editor.view); updateCount(); syncWelcome(); try { paintToolbar(); } catch { /* boot */ } }

const CLOSED_KEY = "mdnest.closed";
const closedStack = (): string[] => { try { return JSON.parse(localStorage.getItem(CLOSED_KEY) ?? "[]"); } catch { return []; } };
function pushClosed(p: string | null) {
  if (!p) return;
  const list = [p, ...closedStack().filter((x) => x !== p)].slice(0, 20);
  localStorage.setItem(CLOSED_KEY, JSON.stringify(list));
}
function popClosed(): string | null {
  const list = closedStack();
  const p = list.shift() ?? null;
  localStorage.setItem(CLOSED_KEY, JSON.stringify(list));
  return p;
}

let welcomeEl: HTMLElement | null = null;
function welcomeVisible() { return !!welcomeEl && !welcomeEl.hidden; }
function syncWelcome() {
  const show = !state.path;
  if (show) showWelcome(); else hideWelcome();
}
function showWelcome() {
  if (!welcomeEl) {
    welcomeEl = document.createElement("div");
    welcomeEl.id = "mdn-welcome";
    content.appendChild(welcomeEl);
  }
  welcomeEl.hidden = false;
  const list = recent();
  welcomeEl.innerHTML = `<div class="mdn-welcome-card">
    <h1>MD Nest</h1>
    <p>A live-preview Markdown editor.</p>
    <div class="mdn-welcome-actions">
      <button type="button" class="btn btn-primary" data-act="new">New File</button>
      <button type="button" class="btn" data-act="open">Open File…</button>
      <button type="button" class="btn" data-act="folder">Open Folder…</button>
    </div>
    <div class="mdn-recent">${list.length ? list.map((p) => `<button type="button" data-path="${escapeHtml(p)}"><span>${escapeHtml(p.split(/[\\/]/).pop() || p)}</span></button>`).join("") : `<div style="opacity:.6">No recent files</div>`}</div>
    <div class="mdn-welcome-hints">Ctrl+N new · Ctrl+O open · Ctrl+Shift+O folder · Ctrl+P quick open · Ctrl+Shift+P command palette</div>
  </div>`;
  welcomeEl.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => {
    b.onclick = () => {
      if (b.dataset.act === "new") void newUntitled();
      else if (b.dataset.act === "open") void pickAndOpen();
      else void pickFolder();
    };
  });
  welcomeEl.querySelectorAll<HTMLButtonElement>("[data-path]").forEach((b) => {
    b.onclick = () => openFile(b.dataset.path!);
  });
}
function hideWelcome() { if (welcomeEl) welcomeEl.hidden = true; }

type GuardChoice = "save" | "discard" | "cancel";
function confirmDirty(action: string): Promise<GuardChoice> {
  if (!state.dirty) return Promise.resolve("discard");
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    const name = state.path ? state.path.split(/[\\/]/).pop() : "Untitled";
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <h3>Save changes?</h3>
      <p>${escapeHtml(name!)} has unsaved changes. Save before ${escapeHtml(action)}?</p>
      <div class="modal-actions">
        <button type="button" class="btn" data-c="cancel">Cancel</button>
        <button type="button" class="btn" data-c="discard">Don't Save</button>
        <button type="button" class="btn btn-primary" data-c="save">Save</button>
      </div>
    </div>`;
    document.body.appendChild(back);
    const done = (c: GuardChoice) => { back.remove(); resolve(c); };
    back.querySelectorAll<HTMLButtonElement>("[data-c]").forEach((b) => b.onclick = () => done(b.dataset.c as GuardChoice));
    back.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); done("cancel"); }
      else if (e.key === "Enter") { e.preventDefault(); done("save"); }
    });
    (back.querySelector("[data-c=save]") as HTMLButtonElement).focus();
  });
}
async function guard(action: string): Promise<boolean> {
  const c = await confirmDirty(action);
  if (c === "cancel") return false;
  if (c === "save") {
    const before = state.path;
    await save(false);
    if (state.dirty || (!before && !state.path)) return false;
  }
  return true;
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}
function parentDir(p: string): string { return p.replace(/[\\/][^\\/]*$/, ""); }
function baseName(p: string): string { return p.split(/[\\/]/).pop() || p; }

async function newUntitled() {
  if (!(await guard("creating a new file"))) return;
  if (state.path) pushClosed(state.path);
  cancelPendingSuggestions(editor.view);
  state.path = null;
  state.lastSaved = "";
  setDirty(false);
  if (source.active) source.show(EMPTY_DOC);
  editor.setMarkdown(EMPTY_DOC);
  state.lastSaved = editor.getMarkdown();
  setTitle();
  afterLoad();
  sidebar.markActive(null);
  localStorage.removeItem("mdnest.lastFile");
  hideWelcome();
  editor.view.focus();
  scheduleMenu();
}

async function closeDoc() {
  if (!(await guard("closing"))) return;
  pushClosed(state.path);
  cancelPendingSuggestions(editor.view);
  state.path = null;
  state.lastSaved = "";
  setDirty(false);
  if (source.active) source.show(EMPTY_DOC);
  editor.setMarkdown(EMPTY_DOC);
  state.lastSaved = editor.getMarkdown();
  setDirty(false);
  setTitle();
  afterLoad();
  sidebar.markActive(null);
  localStorage.removeItem("mdnest.lastFile");
  showWelcome();
  scheduleMenu();
}

async function reopenClosed() {
  const p = popClosed();
  if (!p) { notify("No closed file to reopen"); return; }
  if (!(await guard("reopening a file"))) { pushClosed(p); return; }
  await openFile(p);
}

async function openFile(path: string) {
  try {
    const text = await host.readFile(path);
    cancelPendingSuggestions(editor.view);
    state.path = path; const dir = path.replace(/[\\/][^\\/]*$/, "");
    setImageBase(host.fileUrl(dir + "/"));
    if (source.active) source.show(text); editor.setMarkdown(text);
    state.lastSaved = editor.getMarkdown(); setDirty(false); setTitle(); afterLoad(); sidebar.markActive(path); hideWelcome();
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
async function pickAndOpen() { if (!(await guard("opening a file"))) return; const p = await host.pickFile(); if (p) await openFile(p); }
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
  try { scheduleMenu(); } catch { /* boot */ }
}
function clearRecent() {
  localStorage.setItem(RECENT_KEY, "[]"); renderRecent();
  try { scheduleMenu(); } catch { /* boot */ }
  if (welcomeVisible()) showWelcome();
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
async function exportHtmlString(forPrint: boolean, styles = true) {
  if (source.active) editor.setMarkdown(source.value());
  const dir = docDir();
  return buildExportHtml(editor.getDoc(), host, {
    theme: themes.current, themeFiles: themes.files, title: docStem(), keepRelativeImages: !forPrint,
    baseHref: forPrint && dir ? new URL(host.fileUrl(dir + "/"), location.href).href : undefined,
    styles,
  });
}
async function exportHtml(out?: string, styles = true) {
  const p = out ?? (await host.pickSavePath(docStem() + ".html", "html")); if (!p) return;
  notify("Exporting HTML…");
  const html = await exportHtmlString(false, styles);
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
  { id: "insert.table", title: "Insert: Table…", key: "Ctrl+T", run: () => openTableDialog() },
  { id: "file.exportHtml", title: "File: Export HTML…", run: () => exportHtml() },
  { id: "file.exportPdf", title: "File: Export PDF…", run: () => exportPdf() },
  { id: "file.reload", title: "File: Reload from Disk", run: () => reloadFromDisk(true) },
  { id: "file.autosave", title: "File: Toggle Autosave", run: () => { const on = localStorage.getItem(AUTOSAVE_KEY) !== "1"; localStorage.setItem(AUTOSAVE_KEY, on ? "1" : "0"); notify("Autosave " + (on ? "on" : "off")); } },
  { id: "view.recent", title: "View: Recent Files", run: () => { document.body.classList.add("pin-outline"); sidebar.select("recent"); } },
  { id: "view.settings", title: "Preferences: Settings", run: () => { document.body.classList.add("pin-outline"); sidebar.select("settings"); } },
].forEach(addCmd);

const MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform + navigator.userAgent);

async function uniqueNewName(dir: string, stem: string, ext: string): Promise<string> {
  let i = 0;
  for (;;) {
    const name = (i === 0 ? stem : stem + " " + i) + ext;
    const kind = await host.pathKind(joinPath(dir, name));
    if (kind === "missing") return name;
    i++;
    if (i > 200) return name;
  }
}
async function createIn(dir: string, kind: "file" | "dir") {
  if (!dir) { notify("Open a folder first"); return; }
  const name = kind === "file" ? await uniqueNewName(dir, "Untitled", ".md") : await uniqueNewName(dir, "Untitled folder", "");
  const path = joinPath(dir, name);
  try {
    if (kind === "file") { await host.createFile(path); await openFile(path); }
    else await host.createDir(path);
    sidebar.expandedAdd(dir);
    await sidebar.refresh();
    sidebar.startRename(path);
  } catch (e: any) { notify((kind === "file" ? "New file" : "New folder") + " failed: " + (e.message ?? e)); }
}
async function renameTo(from: string, name: string) {
  const to = joinPath(parentDir(from), name);
  if (to === from) return;
  try {
    await host.renamePath(from, to);
    if (state.path === from || (state.path && state.path.startsWith(from + "/") || state.path?.startsWith(from + "\\"))) {
      const next = state.path === from ? to : to + state.path.slice(from.length);
      state.path = next;
      setTitle();
      addRecent(next);
      localStorage.setItem("mdnest.lastFile", next);
    }
    remapRecent(from, to);
    await sidebar.refresh();
    sidebar.markActive(state.path);
    scheduleMenu();
  } catch (e: any) { notify("Rename failed: " + (e.message ?? e)); await sidebar.refresh(); }
}
function remapRecent(from: string, to: string) {
  const list = recent().map((p) => p === from ? to : (p.startsWith(from + "/") || p.startsWith(from + "\\") ? to + p.slice(from.length) : p));
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  renderRecent();
}
async function moveCurrent() {
  if (!state.path) return;
  const destDir = await host.pickFolder();
  if (!destDir) return;
  const to = joinPath(destDir, baseName(state.path));
  try {
    await host.renamePath(state.path, to);
    remapRecent(state.path, to);
    state.path = to; setTitle(); addRecent(to);
    localStorage.setItem("mdnest.lastFile", to);
    const dir = parentDir(to);
    if (sidebar.root && (dir.startsWith(sidebar.root) || sidebar.root.startsWith(dir))) await sidebar.refresh();
    else await sidebar.openFolder(dir);
    sidebar.markActive(to);
    notify("Moved to " + to);
  } catch (e: any) { notify("Move failed: " + (e.message ?? e)); }
}
async function renameCurrent() {
  if (!state.path) return;
  const name = await openPrompt(editor.view, { placeholder: "New name", value: baseName(state.path) });
  if (!name || name === baseName(state.path)) return;
  await renameTo(state.path, name.trim());
}
async function duplicateCurrent(path = state.path) {
  if (!path) return;
  try {
    const created = await host.duplicatePath(path);
    await sidebar.refresh();
    if (/\.(md|markdown|mdown|mkd|mdx|txt|text)$/i.test(created)) await openFile(created);
    notify("Duplicated " + baseName(created));
  } catch (e: any) { notify("Duplicate failed: " + (e.message ?? e)); }
}
async function trashPath(path: string) {
  const name = baseName(path);
  const ok = await new Promise<boolean>((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = `<div class="modal" role="dialog"><h3>Delete ${escapeHtml(name)}?</h3><p>Move to the trash?</p>
      <div class="modal-actions"><button type="button" class="btn" data-c="no">Cancel</button><button type="button" class="btn btn-primary" data-c="yes">Delete</button></div></div>`;
    document.body.appendChild(back);
    const done = (v: boolean) => { back.remove(); resolve(v); };
    back.querySelector("[data-c=no]")!.addEventListener("click", () => done(false));
    back.querySelector("[data-c=yes]")!.addEventListener("click", () => done(true));
  });
  if (!ok) return;
  try {
    await host.trashPath(path);
    if (state.path === path || (state.path && (state.path.startsWith(path + "/") || state.path.startsWith(path + "\\")))) {
      pushClosed(state.path);
      state.path = null; state.lastSaved = ""; setDirty(false);
      editor.setMarkdown(EMPTY_DOC); state.lastSaved = editor.getMarkdown(); setTitle(); afterLoad(); sidebar.markActive(null);
      localStorage.removeItem("mdnest.lastFile");
      showWelcome();
    }
    await sidebar.refresh();
    notify("Moved to trash");
  } catch (e: any) { notify("Delete failed: " + (e.message ?? e)); }
}
function copyPath(path: string) {
  void navigator.clipboard?.writeText(path).then(() => notify("Copied path")).catch(() => notify(path));
}
async function openNewWindow(file?: string) {
  try { await host.openWindow(file ?? null); }
  catch (e: any) { notify("New window failed: " + (e.message ?? e)); }
}
async function printDoc() {
  const html = await exportHtmlString(true);
  printHtml(html);
}
function fuzzyScore(name: string, q: string): number {
  const n = name.toLowerCase(); const query = q.toLowerCase();
  if (!query) return 1;
  if (n.includes(query)) return 100 - n.indexOf(query);
  let i = 0; let score = 0;
  for (const ch of n) { if (ch === query[i]) { score++; i++; if (i === query.length) return score; } }
  return i === query.length ? score : 0;
}
async function quickOpen() {
  document.querySelector("#typora-quick-open")?.remove();
  const box = document.createElement("div");
  box.id = "typora-quick-open";
  box.innerHTML = `<input id="typora-quick-open-input" type="text" placeholder="Open quickly…" autocomplete="off"><div class="typora-quick-open-list"></div>`;
  document.body.appendChild(box);
  const input = box.querySelector("input") as HTMLInputElement;
  const listEl = box.querySelector(".typora-quick-open-list") as HTMLElement;
  let items: { path: string; name: string; recent: boolean }[] = [];
  let active = 0;
  const files = sidebar.root ? await host.listFiles(sidebar.root, 5000).catch(() => []) : [];
  const render = () => {
    const q = input.value.trim();
    const rec = recent().map((p) => ({ path: p, name: baseName(p), recent: true }));
    const rest = files.map((f) => ({ path: f.path, name: f.name, recent: false })).filter((f) => !rec.some((r) => r.path === f.path));
    const pool = [...rec, ...rest];
    items = (q ? pool.map((it) => ({ it, s: fuzzyScore(it.name, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.it) : pool).slice(0, 40);
    if (active >= items.length) active = 0;
    listEl.innerHTML = items.map((it, i) => `<div class="typora-quick-open-item${i === active ? " active" : ""}" data-i="${i}"><span>${escapeHtml(it.name)}</span><span class="typora-quick-open-item-path">${escapeHtml(it.path)}</span></div>`).join("")
      || `<div class="typora-quick-open-item" style="opacity:.6">No matches</div>`;
    listEl.querySelectorAll<HTMLElement>(".typora-quick-open-item[data-i]").forEach((n) => {
      n.onmouseenter = () => { active = +n.dataset.i!; render(); };
      n.onclick = () => { void pick(items[+n.dataset.i!].path); };
    });
  };
  const close = () => box.remove();
  const pick = async (path: string) => { close(); if (!(await guard("opening a file"))) return; await openFile(path); };
  input.addEventListener("input", render);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(items.length - 1, active + 1); render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); render(); }
    else if (e.key === "Enter" && items[active]) { e.preventDefault(); void pick(items[active].path); }
  });
  input.focus();
  render();
}
const MARKDOWN_REF = `# Markdown reference\n\n# Heading\n\n**bold** *italic* ~~strike~~ \`code\`\n\n- list\n- [ ] task\n\n> quote\n\n\`\`\`\ncode\n\`\`\`\n\n[link](https://example.com)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n`;
function showHelp(title: string, body: string) {
  const back = document.createElement("div");
  back.className = "modal-backdrop";
  const pre = document.createElement("pre");
  pre.style.cssText = "white-space:pre-wrap;max-height:50vh;overflow:auto;font:13px var(--monospace)";
  pre.textContent = body;
  back.innerHTML = `<div class="modal" role="dialog" style="max-width:560px"><h3></h3><div class="mdn-help-body"></div><div class="modal-actions"><button type="button" class="btn btn-primary">Close</button></div></div>`;
  back.querySelector("h3")!.textContent = title;
  back.querySelector(".mdn-help-body")!.appendChild(pre);
  document.body.appendChild(back);
  back.querySelector("button")!.onclick = () => back.remove();
}
function shortcutHelp(): string {
  return commands.filter((c) => c.key).map((c) => `${c.key}  ${c.title}`).join("\n");
}

[
  { id: "file.new", title: "File: New", key: "CmdOrCtrl+N", run: () => newUntitled() },
  { id: "file.newWindow", title: "File: New Window", key: "CmdOrCtrl+Shift+N", run: () => openNewWindow(state.path ?? undefined) },
  { id: "file.quickOpen", title: "File: Open Quickly…", key: "CmdOrCtrl+P", run: () => quickOpen() },
  { id: "file.reopenClosed", title: "File: Reopen Closed File", key: "CmdOrCtrl+Shift+T", run: () => reopenClosed() },
  { id: "file.moveTo", title: "File: Move To…", when: () => !!state.path, run: () => moveCurrent() },
  { id: "file.rename", title: "File: Rename…", when: () => !!state.path, run: () => renameCurrent() },
  { id: "file.duplicate", title: "File: Duplicate", when: () => !!state.path, run: () => duplicateCurrent() },
  { id: "file.openLocation", title: "File: Open File Location", when: () => !!state.path, run: () => state.path && host.revealPath(state.path).catch((e) => notify(String(e?.message ?? e))) },
  { id: "file.revealSidebar", title: "File: Reveal in Sidebar", when: () => !!state.path, run: () => state.path && sidebar.revealPath(state.path) },
  { id: "file.print", title: "File: Print…", key: "CmdOrCtrl+Alt+P", run: () => printDoc() },
  { id: "file.close", title: "File: Close", key: "CmdOrCtrl+W", run: () => closeWindow() },
  { id: "file.quit", title: "File: Quit", key: "CmdOrCtrl+Q", run: () => quitApp() },
  { id: "file.clearRecent", title: "File: Clear Recent Items", when: () => recent().length > 0, run: () => clearRecent() },
  { id: "file.exportHtmlPlain", title: "File: Export HTML (without styles)", run: () => exportHtml(undefined, false) },
  { id: "view.articles", title: "View: Articles", key: "CmdOrCtrl+Shift+2", run: () => sidebar.showList() },
  { id: "view.fileTree", title: "View: File Tree", key: "CmdOrCtrl+Shift+3", run: () => sidebar.showTree() },
  { id: "view.searchFolder", title: "View: Search in Folder", key: "CmdOrCtrl+Shift+F", run: () => sidebar.focusSearch() },
  { id: "themes.openFolder", title: "Themes: Open Theme Folder", run: async () => {
    if (host.kind === "browser") { notify("Themes: " + (location.origin + "/themes/")); return; }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const { appConfigDir } = await import("@tauri-apps/api/path");
      const dir = (await appConfigDir()) + "themes";
      await invoke("reveal_path", { path: dir });
    } catch (e: any) { notify("Theme folder: " + (e?.message ?? e)); }
  } },
  { id: "help.markdown", title: "Help: Markdown Reference", run: () => showHelp("Markdown reference", MARKDOWN_REF) },
  { id: "help.shortcuts", title: "Help: Keyboard Shortcuts", run: () => showHelp("Keyboard shortcuts", shortcutHelp()) },
  { id: "help.dataFolder", title: "Help: Open Data Folder", run: () => notify("App data lives in the platform config directory") },
].forEach(addCmd);

async function closeWindow() {
  if (!(await guard("closing"))) return;
  if (host.kind === "tauri") { await host.closeWindow().catch((e) => notify(String(e?.message ?? e))); return; }
  await closeDoc();
}
async function quitApp() {
  if (!(await guard("quitting"))) return;
  await host.quit(0);
}

sidebar.setActions({
  openFile: (p) => { void openFile(p); },
  newFile: (dir) => createIn(dir, "file"),
  newFolder: (dir) => createIn(dir, "dir"),
  rename: (path, name) => renameTo(path, name),
  duplicate: (path) => duplicateCurrent(path),
  trash: (path) => trashPath(path),
  reveal: (path) => host.revealPath(path).catch((e) => notify(String(e?.message ?? e))),
  openFolder: () => pickFolder(),
  openWindow: (path) => openNewWindow(path),
  copyPath: (path) => copyPath(path),
  notify,
});

function pmRun(fn: (state: any, dispatch?: any, view?: any) => boolean) {
  const v = editor.view;
  fn(v.state, v.dispatch, v);
  v.focus();
}
function inTableNow() {
  try { return isInTable(editor.view.state); } catch { return false; }
}
function aiOwnsHyperlink() {
  const ai = commands.find((c) => c.id === "ai.rewrite" || c.id === "rewrite");
  return !!(ai && commandEnabled(ai));
}
function togglePair(key: string, _defaultOn: boolean) {
  const on = key === PAIR_BRACKETS_KEY ? pairBracketsOn() : pairMarkdownOn();
  localStorage.setItem(key, on ? "0" : "1");
  const now = key === PAIR_BRACKETS_KEY ? pairBracketsOn() : pairMarkdownOn();
  notify((key === PAIR_BRACKETS_KEY ? "Auto-pair brackets" : "Auto-pair Markdown") + " " + (now ? "on" : "off"));
  scheduleMenu();
}
async function copyAs(kind: "markdown" | "html" | "plain") {
  const st = editor.view.state;
  const text = kind === "markdown" ? copyMarkdownText(st) : kind === "html" ? selectionHtml(st) : copyPlainText(st);
  try { await navigator.clipboard.writeText(text); notify(kind === "markdown" ? "Copied Markdown" : kind === "html" ? "Copied HTML" : "Copied plain text"); }
  catch { notify(text.slice(0, 80)); }
}
async function pastePlain() {
  let text = "";
  try { text = await navigator.clipboard.readText(); } catch { text = ""; }
  if (!text) { notify("Clipboard is empty"); return; }
  const v = editor.view;
  v.dispatch(v.state.tr.insertText(text).scrollIntoView());
  v.focus();
}
function findStep(dir: 1 | -1) {
  if (!findBar.visible) openFind(false);
  const searcher = source.active ? sourceSearch : editorSearch;
  searcher.go(dir);
}
function insertInlineMath() {
  const v = editor.view;
  const { from, to, empty } = v.state.selection;
  const tex = empty ? "x" : v.state.doc.textBetween(from, to);
  const node = schema.nodes.inline_math.create({ tex });
  v.dispatch(v.state.tr.replaceSelectionWith(node).scrollIntoView());
  v.focus();
}
function wrapComment() {
  const v = editor.view;
  const { from, to, empty } = v.state.selection;
  if (empty) {
    const text = schema.text("comment", [schema.marks.comment.create()]);
    v.dispatch(v.state.tr.replaceSelectionWith(text, false).scrollIntoView());
  } else {
    pmRun(toggleMark(schema.marks.comment));
    return;
  }
  v.focus();
}
async function promptHyperlink() {
  if (aiOwnsHyperlink()) return;
  const v = editor.view;
  const existing = linkAt(v.state);
  const url = await openPrompt(v, { placeholder: "https://", value: existing?.href || "https://" });
  if (url == null) return;
  const { from, to, empty } = v.state.selection;
  const mark = schema.marks.link.create({ href: url });
  if (empty && !existing) {
    const text = schema.text(url.replace(/^https?:\/\//, "") || "link", [mark]);
    v.dispatch(v.state.tr.replaceSelectionWith(text, false).scrollIntoView());
  } else if (v.state.doc.rangeHasMark(from, to, schema.marks.link) || existing) {
    const a = existing?.from ?? from, b = existing?.to ?? to;
    let tr = v.state.tr.removeMark(a, b, schema.marks.link);
    if (url) tr = tr.addMark(a, b, mark);
    v.dispatch(tr);
  } else {
    v.dispatch(v.state.tr.addMark(from, to, mark));
  }
  v.focus();
}
async function insertLocalImage() {
  const path = await host.pickFile();
  if (!path) return;
  if (!/\.(png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?)$/i.test(path)) { notify("Not an image"); return; }
  await insertImageFiles(editor.view, host, state.path, [{ path }], editor.view.state.selection.from, notify);
}
function openTableDialog() {
  document.getElementById("table-insert-dialog")?.remove();
  const back = document.createElement("div");
  back.className = "modal-backdrop";
  back.id = "table-insert-dialog";
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
    <h3>Insert table</h3>
    <p><label>Rows <input id="table-rows" type="number" min="1" max="50" value="3" style="width:4em"></label>
       <label>Columns <input id="table-cols" type="number" min="1" max="20" value="3" style="width:4em"></label></p>
    <div class="modal-actions">
      <button type="button" class="btn" data-c="cancel">Cancel</button>
      <button type="button" class="btn btn-primary" data-c="ok">Insert</button>
    </div>
  </div>`;
  document.body.appendChild(back);
  const rows = back.querySelector("#table-rows") as HTMLInputElement;
  const cols = back.querySelector("#table-cols") as HTMLInputElement;
  const close = () => back.remove();
  const go = () => {
    const r = Math.max(1, Math.min(50, +rows.value || 3));
    const c = Math.max(1, Math.min(20, +cols.value || 3));
    close();
    insertTable(r, c)(editor.view.state, editor.view.dispatch);
    editor.view.focus();
  };
  back.querySelector("[data-c=cancel]")!.addEventListener("click", close);
  back.querySelector("[data-c=ok]")!.addEventListener("click", go);
  back.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Enter") { e.preventDefault(); go(); }
  });
  rows.focus(); rows.select();
}
function toggleBodyClass(cls: string) {
  document.body.classList.toggle(cls);
  scheduleMenu();
  if (cls === "ty-on-typewriter-mode") centerCaret();
}
function toggleToolbar() {
  const on = localStorage.getItem(TOOLBAR_KEY) === "1";
  localStorage.setItem(TOOLBAR_KEY, on ? "0" : "1");
  syncToolbar();
  scheduleMenu();
}
function toggleStatusBar() {
  const on = localStorage.getItem(STATUS_KEY) !== "0";
  localStorage.setItem(STATUS_KEY, on ? "0" : "1");
  syncStatusBar();
  scheduleMenu();
}
const ZOOM_KEY = "mdnest.zoom";
function zoomLevel() {
  const n = +(localStorage.getItem(ZOOM_KEY) || "1");
  return n > 0.4 && n < 3 ? n : 1;
}
function setZoom(n: number) {
  const z = Math.round(Math.max(0.5, Math.min(2.5, n)) * 100) / 100;
  localStorage.setItem(ZOOM_KEY, String(z));
  document.documentElement.style.setProperty("--zoom", String(z));
  content.style.zoom = String(z);
  if (host.kind === "tauri") {
    void import("@tauri-apps/api/webview").then((m) => m.getCurrentWebview().setZoom(z)).catch(() => {});
  }
  notify(Math.round(z * 100) + "%");
}
let fullScreen = false;
let alwaysOnTop = false;
async function toggleFullScreen() {
  fullScreen = !fullScreen;
  document.body.classList.toggle("mdn-fullscreen", fullScreen);
  if (host.kind === "tauri") {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setFullscreen(fullScreen);
    } catch (e: any) { notify(String(e?.message ?? e)); }
  }
  scheduleMenu();
}
async function toggleAlwaysOnTop() {
  alwaysOnTop = !alwaysOnTop;
  if (host.kind === "tauri") {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setAlwaysOnTop(alwaysOnTop);
    } catch (e: any) { notify(String(e?.message ?? e)); }
  } else notify("Always on top " + (alwaysOnTop ? "on" : "off"));
  scheduleMenu();
}
function centerCaret() {
  if (!document.body.classList.contains("ty-on-typewriter-mode")) return;
  try {
    const coords = editor.view.coordsAtPos(editor.view.state.selection.head);
    const box = content.getBoundingClientRect();
    const delta = coords.top - (box.top + box.height / 2);
    content.scrollTop += delta;
  } catch { /* empty doc */ }
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
  { id: "paragraph.tableDialog", title: "Paragraph: Table…", key: "CmdOrCtrl+T", run: () => openTableDialog() },
  { id: "format.strong", title: "Format: Strong", key: "CmdOrCtrl+B", run: markCmd("strong") },
  { id: "format.emphasis", title: "Format: Emphasis", key: "CmdOrCtrl+I", run: markCmd("em") },
  { id: "format.code", title: "Format: Code", key: "CmdOrCtrl+Shift+`", run: markCmd("code") },
  { id: "format.strike", title: "Format: Strike", key: "Alt+Shift+5", run: markCmd("strike") },
  { id: "file.preferences", title: "File: Preferences…", key: "CmdOrCtrl+,", run: () => { document.body.classList.add("pin-outline"); sidebar.select("settings"); } },
  { id: "help.about", title: "Help: About MD Nest", run: () => notify("MD Nest " + APP_VERSION) },
  { id: "view.palette", title: "View: Command Palette", key: "CmdOrCtrl+Shift+P", run: () => openPalette(commands) },
  { id: "edit.copyMarkdown", title: "Edit: Copy as Markdown", key: "CmdOrCtrl+Shift+C", run: () => copyAs("markdown") },
  { id: "edit.copyHtml", title: "Edit: Copy as HTML Code", run: () => copyAs("html") },
  { id: "edit.copyPlain", title: "Edit: Copy as Plain Text", run: () => copyAs("plain") },
  { id: "edit.pastePlain", title: "Edit: Paste as Plain Text", key: "CmdOrCtrl+Shift+V", run: () => pastePlain() },
  { id: "edit.delete", title: "Edit: Delete", run: () => pmRun(deleteSelection()) },
  { id: "edit.selectLine", title: "Edit: Select Line/Sentence", key: "CmdOrCtrl+L", run: () => pmRun(selectLine()) },
  { id: "edit.selectScope", title: "Edit: Select Styled Scope", key: "CmdOrCtrl+E", run: () => pmRun(selectStyledScope()) },
  { id: "edit.selectWord", title: "Edit: Select Word", key: "CmdOrCtrl+D", run: () => pmRun(selectWord()) },
  { id: "edit.jumpTop", title: "Edit: Jump to Top", key: "CmdOrCtrl+Home", run: () => pmRun(jumpTop()) },
  { id: "edit.jumpBottom", title: "Edit: Jump to Bottom", key: "CmdOrCtrl+End", run: () => pmRun(jumpBottom()) },
  { id: "edit.findNext", title: "Edit: Find Next", key: "F3", run: () => findStep(1) },
  { id: "edit.findPrevious", title: "Edit: Find Previous", key: "Shift+F3", run: () => findStep(-1) },
  { id: "edit.autoPair.brackets", title: "Edit: Auto Pair Brackets and Quotes", run: () => togglePair(PAIR_BRACKETS_KEY, true) },
  { id: "edit.autoPair.markdown", title: "Edit: Auto Pair Markdown Syntax", run: () => togglePair(PAIR_MARKDOWN_KEY, false) },
  { id: "paragraph.increaseHeading", title: "Paragraph: Increase Heading Level", key: "CmdOrCtrl+=", run: () => pmRun(increaseHeading()) },
  { id: "paragraph.decreaseHeading", title: "Paragraph: Decrease Heading Level", key: "CmdOrCtrl+-", run: () => pmRun(decreaseHeading()) },
  { id: "paragraph.table.addRowAbove", title: "Table: Add Row Above", when: () => inTableNow(), run: () => pmRun(addRowBefore) },
  { id: "paragraph.table.addRowBelow", title: "Table: Add Row Below", when: () => inTableNow(), run: () => pmRun(addRowAfter) },
  { id: "paragraph.table.addColBefore", title: "Table: Add Column Before", when: () => inTableNow(), run: () => pmRun(addColumnBefore) },
  { id: "paragraph.table.addColAfter", title: "Table: Add Column After", when: () => inTableNow(), run: () => pmRun(addColumnAfter) },
  { id: "paragraph.table.deleteRow", title: "Table: Delete Row", when: () => inTableNow(), run: () => pmRun(deleteRow) },
  { id: "paragraph.table.deleteColumn", title: "Table: Delete Column", when: () => inTableNow(), run: () => pmRun(deleteColumn) },
  { id: "paragraph.table.deleteTable", title: "Table: Delete Table", when: () => inTableNow(), run: () => pmRun(deleteTable) },
  { id: "paragraph.mathBlock", title: "Paragraph: Math Block", key: "CmdOrCtrl+Shift+M", run: () => pmRun(setBlockType(schema.nodes.math_block)) },
  { id: "paragraph.taskList", title: "Paragraph: Task List", key: "CmdOrCtrl+Shift+X", run: () => pmRun(toggleTaskList()) },
  { id: "paragraph.indent", title: "Paragraph: Indent", key: "CmdOrCtrl+]", run: () => pmRun(sinkListItem(schema.nodes.list_item)) },
  { id: "paragraph.outdent", title: "Paragraph: Outdent", key: "CmdOrCtrl+[", run: () => pmRun(liftListItem(schema.nodes.list_item)) },
  { id: "paragraph.insertBefore", title: "Paragraph: Insert Paragraph Before", run: () => pmRun(insertParagraphBefore()) },
  { id: "paragraph.insertAfter", title: "Paragraph: Insert Paragraph After", run: () => pmRun(insertParagraphAfter()) },
  { id: "paragraph.linkRef", title: "Paragraph: Link Reference", run: () => insertLinkRef(editor.view) },
  { id: "paragraph.footnote", title: "Paragraph: Footnote", run: () => insertFootnote(editor.view) },
  { id: "paragraph.hr", title: "Paragraph: Horizontal Line", run: () => insertHr(editor.view) },
  { id: "paragraph.toc", title: "Paragraph: Table of Contents", run: () => insertToc(editor.view) },
  { id: "paragraph.frontMatter", title: "Paragraph: YAML Front Matter", run: () => insertFrontMatter(editor.view) },
  { id: "paragraph.alert.note", title: "Alert: Note", run: () => insertAlert(editor.view, "NOTE") },
  { id: "paragraph.alert.tip", title: "Alert: Tip", run: () => insertAlert(editor.view, "TIP") },
  { id: "paragraph.alert.important", title: "Alert: Important", run: () => insertAlert(editor.view, "IMPORTANT") },
  { id: "paragraph.alert.warning", title: "Alert: Warning", run: () => insertAlert(editor.view, "WARNING") },
  { id: "paragraph.alert.caution", title: "Alert: Caution", run: () => insertAlert(editor.view, "CAUTION") },
  { id: "paragraph.mermaid", title: "Paragraph: Mermaid Diagram", run: () => insertMermaid(editor.view) },
  { id: "paragraph.deleteBlock", title: "Paragraph: Delete Block", run: () => pmRun(deleteBlock()) },
  { id: "format.underline", title: "Format: Underline", key: "CmdOrCtrl+U", run: markCmd("underline") },
  { id: "format.highlight", title: "Format: Highlight", run: markCmd("highlight") },
  { id: "format.inlineMath", title: "Format: Inline Math", run: () => insertInlineMath() },
  { id: "format.superscript", title: "Format: Superscript", run: markCmd("superscript") },
  { id: "format.subscript", title: "Format: Subscript", run: markCmd("subscript") },
  { id: "format.comment", title: "Format: Comment", run: () => wrapComment() },
  { id: "format.link", title: "Format: Hyperlink", key: "CmdOrCtrl+K", when: () => !aiOwnsHyperlink(), run: () => promptHyperlink() },
  { id: "format.image", title: "Format: Insert Local Image…", key: "CmdOrCtrl+Shift+I", run: () => insertLocalImage() },
  { id: "format.image.zoom50", title: "Image: Zoom 50%", when: () => !!imageSelection(editor.view.state), run: () => pmRun(setImageZoom(50)) },
  { id: "format.image.zoom100", title: "Image: Zoom 100%", when: () => !!imageSelection(editor.view.state), run: () => pmRun(setImageZoom(100)) },
  { id: "format.image.zoom200", title: "Image: Zoom 200%", when: () => !!imageSelection(editor.view.state), run: () => pmRun(setImageZoom(200)) },
  { id: "format.clear", title: "Format: Clear Format", key: "CmdOrCtrl+\\", run: () => pmRun(clearFormat()) },
  { id: "view.focus", title: "View: Focus Mode", key: "F8", run: () => toggleBodyClass("on-focus-mode") },
  { id: "view.typewriter", title: "View: Typewriter Mode", key: "F9", run: () => toggleBodyClass("ty-on-typewriter-mode") },
  { id: "view.toolbar", title: "View: Formatting Toolbar", run: () => toggleToolbar() },
  { id: "view.statusBar", title: "View: Status Bar", run: () => toggleStatusBar() },
  { id: "view.wordCount", title: "View: Word Count", run: () => toggleWordPopover() },
  { id: "view.fullScreen", title: "View: Full Screen", key: "F11", run: () => toggleFullScreen() },
  { id: "view.alwaysOnTop", title: "View: Always on Top", run: () => toggleAlwaysOnTop() },
  { id: "view.actualSize", title: "View: Actual Size", key: "CmdOrCtrl+Shift+0", run: () => setZoom(1) },
  { id: "view.zoomIn", title: "View: Zoom In", key: "CmdOrCtrl+Shift+=", run: () => setZoom(zoomLevel() * 1.1) },
  { id: "view.zoomOut", title: "View: Zoom Out", key: "CmdOrCtrl+Shift+-", run: () => setZoom(zoomLevel() / 1.1) },
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
    focusMode: document.body.classList.contains("on-focus-mode"),
    typewriter: document.body.classList.contains("ty-on-typewriter-mode"),
    toolbar: localStorage.getItem(TOOLBAR_KEY) === "1",
    statusBar: localStorage.getItem(STATUS_KEY) !== "0",
    fullScreen,
    alwaysOnTop,
    pairBrackets: pairBracketsOn(),
    pairMarkdown: pairMarkdownOn(),
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

const TOOLBAR_KEY = "mdnest.formatToolbar";
const STATUS_KEY = "mdnest.statusBar";
const formatBar = document.createElement("div");
formatBar.id = "mdn-format-toolbar";
formatBar.hidden = true;
const TOOL_BUTTONS: { label: string; title: string; cmd: string; mark?: string }[] = [
  { label: "H1", title: "Heading 1", cmd: "paragraph.heading.1" },
  { label: "H2", title: "Heading 2", cmd: "paragraph.heading.2" },
  { label: "H3", title: "Heading 3", cmd: "paragraph.heading.3" },
  { label: "B", title: "Strong", cmd: "format.strong", mark: "strong" },
  { label: "I", title: "Emphasis", cmd: "format.emphasis", mark: "em" },
  { label: "U", title: "Underline", cmd: "format.underline", mark: "underline" },
  { label: "S", title: "Strike", cmd: "format.strike", mark: "strike" },
  { label: "</>", title: "Code", cmd: "format.code", mark: "code" },
  { label: "Link", title: "Hyperlink", cmd: "format.link" },
  { label: "Img", title: "Insert image", cmd: "format.image" },
  { label: "❝", title: "Quote", cmd: "paragraph.quote" },
  { label: "•", title: "Bullet list", cmd: "paragraph.unorderedList" },
  { label: "1.", title: "Numbered list", cmd: "paragraph.orderedList" },
  { label: "☑", title: "Task list", cmd: "paragraph.taskList" },
  { label: "Tbl", title: "Table", cmd: "paragraph.tableDialog" },
  { label: "{ }", title: "Code block", cmd: "paragraph.codeFence" },
  { label: "∑", title: "Math block", cmd: "paragraph.mathBlock" },
  { label: "—", title: "Horizontal line", cmd: "paragraph.hr" },
];
formatBar.innerHTML = TOOL_BUTTONS.map((b) => `<button type="button" data-cmd="${b.cmd}" data-mark="${b.mark ?? ""}" title="${b.title}" aria-label="${b.title}">${b.label}</button>`).join("");
content.insertBefore(formatBar, content.firstChild);
formatBar.addEventListener("mousedown", (e) => {
  const btn = (e.target as HTMLElement).closest("button");
  if (!btn) return;
  e.preventDefault();
  const sel = editor.view.state.selection;
  editor.view.focus();
  editor.view.dispatch(editor.view.state.tr.setSelection(sel));
  runCommand(btn.dataset.cmd || "");
  paintToolbar();
});
function syncToolbar() {
  const on = localStorage.getItem(TOOLBAR_KEY) === "1";
  formatBar.hidden = !on;
  document.body.classList.toggle("mdn-toolbar-on", on);
  paintToolbar();
}
function toolbarOn() { return localStorage.getItem(TOOLBAR_KEY) === "1"; }
function paintToolbar() {
  if (!toolbarOn()) return;
  formatBar.hidden = false;
  let marks: string[] = [];
  let heading = 0;
  try {
    const sel = editor.view.state.selection;
    if (sel.empty) {
      marks = sel.$from.marks().map((m) => m.type.name);
      // Inside an expanded marker the real mark is stored, not applied.
      const stored = sel.$from.marks().find((m) => m.type.name === "md_src");
      if (stored) marks.push(...(editor.view.state.storedMarks ?? []).map((m) => m.type.name));
    } else sel.$from.doc.nodesBetween(sel.from, sel.to, (node) => { node.marks.forEach((m) => marks.push(m.type.name)); });
    if (sel.$from.parent.type.name === "heading") heading = sel.$from.parent.attrs.level;
  } catch { /* boot */ }
  formatBar.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
    const mark = b.dataset.mark;
    const cmd = b.dataset.cmd || "";
    const active = (mark && marks.includes(mark))
      || (cmd === "paragraph.heading.1" && heading === 1)
      || (cmd === "paragraph.heading.2" && heading === 2)
      || (cmd === "paragraph.heading.3" && heading === 3);
    b.classList.toggle("active", !!active);
  });
}
function syncStatusBar() {
  const on = localStorage.getItem(STATUS_KEY) !== "0";
  footer.hidden = !on;
  document.body.classList.toggle("mdn-statusbar-off", !on);
}
const wordPop = document.createElement("div");
wordPop.id = "mdn-word-popover";
wordPop.hidden = true;
document.body.appendChild(wordPop);
function wordStatsNow() {
  const st = editor.view.state;
  const { from, to, empty } = st.selection;
  const text = empty ? st.doc.textBetween(0, st.doc.content.size, "\n", " ") : st.doc.textBetween(from, to, "\n", " ");
  const { words, chars } = countWords(text);
  const lines = text ? text.split("\n").length : 0;
  const minutes = Math.max(words ? 1 : 0, Math.round(words / 230));
  return { words, chars, lines, minutes, selection: !empty };
}
function toggleWordPopover() {
  if (!wordPop.hidden) { wordPop.hidden = true; return; }
  const s = wordStatsNow();
  wordPop.innerHTML = `<div><b>${s.selection ? "Selection" : "Document"}</b></div>
    <div>${s.words} words</div><div>${s.chars} characters</div><div>${s.lines} lines</div><div>~${s.minutes} min read</div>`;
  const anchor = document.getElementById("footer-word-count")!.getBoundingClientRect();
  wordPop.hidden = false;
  wordPop.style.left = Math.max(8, anchor.right - 180) + "px";
  wordPop.style.top = Math.max(8, anchor.top - 120) + "px";
}
function editorContextMenu(e: MouseEvent) {
  const t = e.target as HTMLElement;
  if (!t.closest("#write")) return;
  const st = editor.view.state;
  const link = linkAt(st);
  const img = imageSelection(st);
  const items: ContextItem[] = [
    { id: "cut", label: "Cut" },
    { id: "copy", label: "Copy" },
    { id: "paste", label: "Paste" },
    { id: "edit.copyMarkdown", label: "Copy as Markdown" },
    { id: "edit.pastePlain", label: "Paste as Plain Text" },
    { id: "paragraph", label: "Paragraph ▸" },
    { id: "format", label: "Format ▸" },
    { id: "insert", label: "Insert ▸" },
  ];
  if (inTableNow()) items.push({ id: "table", label: "Table ▸" });
  if (link) {
    items.push({ id: "link.open", label: "Open Link" });
    items.push({ id: "link.copy", label: "Copy Link Address" });
  }
  if (img) {
    items.push({ id: "image.open", label: "Open Image Location" });
    items.push({ id: "image.delete", label: "Delete Image" });
  }
  items.push({ id: "edit.selectAll", label: "Select All" });
  openContextMenu(e.clientX, e.clientY, items, (id) => {
    if (id === "cut") document.execCommand("cut");
    else if (id === "copy") document.execCommand("copy");
    else if (id === "paste") document.execCommand("paste");
    else if (id === "paragraph") openSubmenu(e.clientX + 180, e.clientY, [
      ["paragraph.heading.1", "Heading 1"], ["paragraph.paragraph", "Paragraph"],
      ["paragraph.quote", "Quote"], ["paragraph.taskList", "Task List"],
      ["paragraph.insertBefore", "Insert Paragraph Before"], ["paragraph.insertAfter", "Insert Paragraph After"],
      ["paragraph.deleteBlock", "Delete Block"],
    ]);
    else if (id === "format") openSubmenu(e.clientX + 180, e.clientY, [
      ["format.strong", "Strong"], ["format.emphasis", "Emphasis"], ["format.underline", "Underline"],
      ["format.code", "Code"], ["format.strike", "Strike"], ["format.clear", "Clear Format"],
    ]);
    else if (id === "insert") openSubmenu(e.clientX + 180, e.clientY, [
      ["format.link", "Hyperlink"], ["format.image", "Image…"], ["paragraph.hr", "Horizontal Line"],
      ["paragraph.footnote", "Footnote"], ["paragraph.toc", "Table of Contents"], ["paragraph.tableDialog", "Table…"],
    ]);
    else if (id === "table") openSubmenu(e.clientX + 180, e.clientY, [
      ["paragraph.table.addRowAbove", "Add Row Above"], ["paragraph.table.addRowBelow", "Add Row Below"],
      ["paragraph.table.deleteRow", "Delete Row"], ["paragraph.table.deleteTable", "Delete Table"],
    ]);
    else if (id === "link.open" && link) window.open(link.href, "_blank");
    else if (id === "link.copy" && link) void navigator.clipboard.writeText(link.href);
    else if (id === "image.open" && img) window.open(img.src, "_blank");
    else if (id === "image.delete") pmRun(deleteImage());
    else runCommand(id);
  });
}
function openSubmenu(x: number, y: number, rows: [string, string][]) {
  openContextMenu(x, y, rows.map(([id, label]) => ({ id, label })), (id) => runCommand(id));
}
editor.view.dom.addEventListener("contextmenu", (e) => editorContextMenu(e));
document.getElementById("footer-word-count")!.addEventListener("click", () => toggleWordPopover());
document.addEventListener("mousedown", (e) => {
  if (!wordPop.hidden && !wordPop.contains(e.target as Node) && (e.target as HTMLElement).id !== "footer-word-count") wordPop.hidden = true;
});
syncToolbar();
syncStatusBar();
setZoom(zoomLevel());

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
registerCoreSlash(editor.view, {
  insertImage: () => { void insertLocalImage(); },
  promptLink: () => { void promptHyperlink(); },
});
sidebar.addTab("settings", "⚙", undefined, {
  id: "settings", title: "Settings", render: (el) => {
    const folder = imageFolderPattern();
    const core = `<h4>Editor</h4><label><input type="checkbox" id="set-autosave" ${localStorage.getItem(AUTOSAVE_KEY) === "1" ? "checked" : ""}> Autosave (1.5 s after edits)</label>
      <label><input type="checkbox" id="set-reopen" ${localStorage.getItem(REOPEN_KEY) !== "0" ? "checked" : ""}> Reopen last file on startup</label>
      <label><input type="checkbox" id="set-pair-brackets" ${pairBracketsOn() ? "checked" : ""}> Auto-pair brackets and quotes</label>
      <label><input type="checkbox" id="set-pair-md" ${pairMarkdownOn() ? "checked" : ""}> Auto-pair Markdown syntax</label>
      <h4>Images</h4><label>When pasting / dropping images, copy them to<br><select id="set-imgfolder">
      ${["./assets", "./${filename}.assets"].map((o) => `<option value="${o}" ${o === folder ? "selected" : ""}>${o}</option>`).join("")}
      <option value="custom" ${["./assets", "./${filename}.assets"].includes(folder) ? "" : "selected"}>custom…</option></select>
      <input id="set-imgfolder-custom" type="text" value="${folder}" style="margin-top:4px"></label>`;
    el.innerHTML = `<div class="mdn-settings">` + core + settingSpecs.map(({ owner, specs }) => `<h4>${escapeHtml(owner)}</h4>` + specs.map((s) => renderSetting(owner, s)).join("")).join("") + (plugins.errors.length ? `<h4>Plugin errors</h4>` + plugins.errors.map((e) => `<div>${escapeHtml(e.id)}: ${escapeHtml(e.error)}</div>`).join("") : "") + `</div>`;
    (el.querySelector("#set-autosave") as HTMLInputElement).onchange = (e) => localStorage.setItem(AUTOSAVE_KEY, (e.target as HTMLInputElement).checked ? "1" : "0");
    (el.querySelector("#set-reopen") as HTMLInputElement).onchange = (e) => localStorage.setItem(REOPEN_KEY, (e.target as HTMLInputElement).checked ? "1" : "0");
    (el.querySelector("#set-pair-brackets") as HTMLInputElement).onchange = (e) => { localStorage.setItem(PAIR_BRACKETS_KEY, (e.target as HTMLInputElement).checked ? "1" : "0"); scheduleMenu(); };
    (el.querySelector("#set-pair-md") as HTMLInputElement).onchange = (e) => { localStorage.setItem(PAIR_MARKDOWN_KEY, (e.target as HTMLInputElement).checked ? "1" : "0"); scheduleMenu(); };
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
(window as any).mdnest = { editor, host, notify, exportHtmlString, findBar, state, openAt, commands, runCommand, refreshMenu, dispatcher, handleNativeDrop: onNativeDrop, sidebar, confirmDirty, guard };

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
  const f = cli ?? q.get("file") ?? (restore ? localStorage.getItem("mdnest.lastFile") : null) ?? (restore && ws && host.kind === "browser" && !q.has("welcome") ? ws + "/sample.md" : null);
  if (f) await openFile(f); else { editor.setMarkdown(EMPTY_DOC); state.lastSaved = editor.getMarkdown(); setDirty(false); afterLoad(); showWelcome(); }
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
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().onCloseRequested(async (ev) => {
        ev.preventDefault();
        if (!(await guard("closing"))) return;
        await host.closeWindow();
      });
      await listen("tauri://focus", () => { void sidebar.refreshExpanded(); });
      await listen<{ paths?: string[]; position?: { x: number; y: number } }>("tauri://drag-drop", (ev) => {
        const paths = ev.payload?.paths ?? [];
        if (paths.length) void onNativeDrop({ paths, position: ev.payload?.position });
      });
    } catch (e) { console.error(e); }
  }
  window.addEventListener("focus", () => { void sidebar.refreshExpanded(); });
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
