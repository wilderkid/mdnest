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
import { PluginManager, Command, SettingSpec, DecorationProvider } from "./plugins/api";
import { countWords } from "./plugins/builtin/word-stats";
import wordStats from "./plugins/builtin/word-stats";
import readingGoal from "./plugins/builtin/reading-goal";
import { FindBar, SourceSearch } from "./shell/findbar";
import { EditorSearch } from "./editor/search";
import { insertImageFiles, IMAGE_FOLDER_KEY, imageFolderPattern } from "./shell/images";
import { buildExportHtml, printHtml } from "./shell/export";
import { insertTable } from "./editor/tabletools";

const WELCOME = `# Welcome to MD Nest\n\nOpen a file (Ctrl+O) or a folder (Ctrl+Shift+O). Toggle source mode with Ctrl+/ and the command palette with Ctrl+Shift+P.\n`;

const state = { path: null as string | null, dirty: false, lastSaved: "", mtime: null as number | null, conflict: false };
const commands: Command[] = [];
const decorationProviders: DecorationProvider[] = [];
const settingSpecs: { owner: string; specs: SettingSpec[] }[] = [];

document.body.classList.add("os-linux", "pin-outline");
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
  keys: { toggleSource, save: () => save(false), saveAs: () => save(true), open: pickAndOpen, openFolder: pickFolder, palette: () => openPalette(commands) },
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
  if (source.active) { const md = source.hide(); editor.setMarkdown(md); afterLoad(); editor.view.focus(); }
  else source.show(editor.getMarkdown());
  findBar.refresh();
}
function afterLoad() { sidebar.updateOutline(editor.view); updateCount(); }

async function openFile(path: string) {
  try {
    const text = await host.readFile(path);
    state.path = path; const dir = path.replace(/[\\/][^\\/]*$/, "");
    setImageBase(host.fileUrl(dir + "/"));
    if (source.active) source.show(text); editor.setMarkdown(text);
    state.lastSaved = editor.getMarkdown(); setDirty(false); setTitle(); afterLoad(); sidebar.markActive(path);
    state.mtime = await host.mtime(path).catch(() => null); state.conflict = false; addRecent(path);
    localStorage.setItem("mdnest.lastFile", path); plugins.emit("file-opened", path);
  } catch (e: any) { notify("Open failed: " + (e.message ?? e)); }
}
async function pickAndOpen() { const p = await host.pickFile(); if (p) openFile(p); }
async function pickFolder() { const p = await host.pickFolder(); if (p) { await sidebar.openFolder(p); localStorage.setItem("mdnest.lastFolder", p); } }
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
    if (String(e?.message ?? e).includes("unsupported")) { printHtml(html); return; } // system print dialog → "Save as PDF"
    notify("PDF export failed: " + (e?.message ?? e));
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
  notify, addDecorations: (p) => decorationProviders.push(p),
  getMarkdown: () => currentMarkdown(), getState: () => editor.view.state, refreshDecorations: () => editor.refreshDecorations(),
  addSettings: (owner, specs) => settingSpecs.push({ owner, specs }),
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
document.getElementById("sidebar-toggle")!.onclick = () => document.body.classList.toggle("pin-outline");
document.getElementById("source-toggle")!.onclick = toggleSource;
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  // global shortcuts that must also work while source mode / CodeMirror has focus
  if (e.key === "/" ) { e.preventDefault(); toggleSource(); }
  else if (e.key.toLowerCase() === "s" && source.active) { e.preventDefault(); save(e.shiftKey); }
  else if (e.key.toLowerCase() === "p" && e.shiftKey) { e.preventDefault(); openPalette(commands); }
  else if (e.key.toLowerCase() === "f" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); openFind(false); }
  else if (e.key.toLowerCase() === "h" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); openFind(true); }
  else if (e.key.toLowerCase() === "t" && !e.shiftKey && !source.active) { e.preventDefault(); insertTable(3, 3)(editor.view.state, editor.view.dispatch); }
}, true);

plugins.activateAll([readingGoal, wordStats]); // order irrelevant: topo-sorted by depends
sidebar.addTab("settings", "⚙", undefined, {
  id: "settings", title: "Settings", render: (el) => {
    const folder = imageFolderPattern();
    const core = `<h4>Editor</h4><label><input type="checkbox" id="set-autosave" ${localStorage.getItem(AUTOSAVE_KEY) === "1" ? "checked" : ""}> Autosave (1.5 s after edits)</label>
      <h4>Images</h4><label>When pasting / dropping images, copy them to<br><select id="set-imgfolder">
      ${["./assets", "./${filename}.assets"].map((o) => `<option value="${o}" ${o === folder ? "selected" : ""}>${o}</option>`).join("")}
      <option value="custom" ${["./assets", "./${filename}.assets"].includes(folder) ? "" : "selected"}>custom…</option></select>
      <input id="set-imgfolder-custom" type="text" value="${folder}" style="margin-top:4px"></label>`;
    el.innerHTML = `<div class="mdn-settings">` + core + settingSpecs.map(({ owner, specs }) => `<h4>${owner}</h4>` + specs.map((s) => {
      const v = JSON.parse(localStorage.getItem(plugins.settingKey(owner, s.key)) ?? JSON.stringify(s.default));
      return s.type === "boolean" ? `<label><input type="checkbox" data-o="${owner}" data-k="${s.key}" ${v ? "checked" : ""}> ${s.title}</label>`
        : `<label>${s.title}<br><input type="${s.type === "number" ? "number" : "text"}" data-o="${owner}" data-k="${s.key}" value="${v}"></label>`;
    }).join("")).join("") + (plugins.errors.length ? `<h4>Plugin errors</h4>` + plugins.errors.map((e) => `<div>${e.id}: ${e.error}</div>`).join("") : "") + `</div>`;
    (el.querySelector("#set-autosave") as HTMLInputElement).onchange = (e) => localStorage.setItem(AUTOSAVE_KEY, (e.target as HTMLInputElement).checked ? "1" : "0");
    const fsel = el.querySelector("#set-imgfolder") as HTMLSelectElement, fcus = el.querySelector("#set-imgfolder-custom") as HTMLInputElement;
    fsel.onchange = () => { if (fsel.value !== "custom") { localStorage.setItem(IMAGE_FOLDER_KEY, fsel.value); fcus.value = fsel.value; } else fcus.focus(); };
    fcus.onchange = () => { localStorage.setItem(IMAGE_FOLDER_KEY, fcus.value.trim() || "./assets"); fsel.value = ["./assets", "./${filename}.assets"].includes(fcus.value) ? fcus.value : "custom"; };
    el.querySelectorAll<HTMLInputElement>("input[data-o]").forEach((inp) => inp.onchange = () => {
      const v = inp.type === "checkbox" ? inp.checked : inp.type === "number" ? +inp.value : inp.value;
      localStorage.setItem(plugins.settingKey(inp.dataset.o!, inp.dataset.k!), JSON.stringify(v));
      plugins.emit("settings-changed", inp.dataset.o, inp.dataset.k, v); editor.refreshDecorations();
    });
  },
});
sidebar.addTab("recent", "Recent", undefined, { id: "recent", title: "Recent", render: (el) => { recentEl = el; renderRecent(); return () => (recentEl = null); } });
sidebar.select("files");
(window as any).mdnest = { editor, host, notify, exportHtmlString, findBar, state };

window.addEventListener("beforeunload", (e) => { if (state.dirty && host.kind === "browser") e.preventDefault(); });

// ---------- boot ----------
(async () => {
  await initThemes();
  const q = new URLSearchParams(location.search);
  const cli = await host.cliFile().catch(() => null);
  const ws = q.get("folder") ?? (cli ? cli.replace(/[\\/][^\\/]*$/, "") : null) ?? localStorage.getItem("mdnest.lastFolder") ?? (await host.defaultWorkspace());
  if (ws) await sidebar.openFolder(ws).catch(() => {});
  const f = cli ?? q.get("file") ?? localStorage.getItem("mdnest.lastFile") ?? (ws && host.kind === "browser" ? ws + "/sample.md" : null);
  if (f) await openFile(f); else afterLoad();
  if (q.get("sidebar") === "0") document.body.classList.remove("pin-outline");
  document.body.classList.add("mdn-ready");
  // CLI: mdnest doc.md [--theme name] [--export-html out.html] [--export-pdf out.pdf] [--quit]
  const args = await host.cliArgs().catch(() => [] as string[]);
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
  } catch (e) { console.error(e); }
  if (args.includes("--quit")) host.quit(0);
})();
