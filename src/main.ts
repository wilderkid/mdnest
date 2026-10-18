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

const WELCOME = `# Welcome to mdnest\n\nOpen a file (Ctrl+O) or a folder (Ctrl+Shift+O). Toggle source mode with Ctrl+/ and the command palette with Ctrl+Shift+P.\n`;

const state = { path: null as string | null, dirty: false, lastSaved: "" };
const commands: Command[] = [];
const decorationProviders: DecorationProvider[] = [];
const settingSpecs: { owner: string; specs: SettingSpec[] }[] = [];

document.body.classList.add("os-linux", "pin-outline");
const sidebar = new Sidebar(host, (p) => openFile(p));
document.body.appendChild(sidebar.el);
const content = document.createElement("content"); document.body.appendChild(content);
const writeEl = document.createElement("div"); content.appendChild(writeEl);
const source = new SourceMode(document.body);
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
    setDirty(true);
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => { sidebar.updateOutline(editor.view); updateCount(); plugins.emit("doc-changed"); }, 150);
  },
  keys: { toggleSource, save: () => save(false), saveAs: () => save(true), open: pickAndOpen, openFolder: pickFolder, palette: () => openPalette(commands) },
});
editor.view.dom.id = "write";
(window as any).mdnest = { editor, host, notify }; // for tests / debugging

function setDirty(d: boolean) { state.dirty = d; document.getElementById("file-title")!.classList.toggle("dirty", d); }
function updateCount() { const t = editor.view.state.doc.textContent; const { words } = countWords(t); document.getElementById("footer-word-count")!.textContent = `${words} words`; }
function setTitle() {
  const name = state.path ? state.path.split(/[\\/]/).pop()! : "Untitled";
  document.getElementById("file-title")!.textContent = name; document.title = name + " — mdnest";
}

function currentMarkdown() { return source.active ? source.value() : editor.getMarkdown(); }
function toggleSource() {
  if (source.active) { const md = source.hide(); editor.setMarkdown(md); afterLoad(); editor.view.focus(); }
  else source.show(editor.getMarkdown());
}
function afterLoad() { sidebar.updateOutline(editor.view); updateCount(); }

async function openFile(path: string) {
  try {
    const text = await host.readFile(path);
    state.path = path; const dir = path.replace(/[\\/][^\\/]*$/, "");
    setImageBase(host.fileUrl(dir + "/"));
    if (source.active) source.show(text); editor.setMarkdown(text);
    state.lastSaved = text; setDirty(false); setTitle(); afterLoad(); sidebar.markActive(path);
    localStorage.setItem("mdnest.lastFile", path); plugins.emit("file-opened", path);
  } catch (e: any) { notify("Open failed: " + (e.message ?? e)); }
}
async function pickAndOpen() { const p = await host.pickFile(); if (p) openFile(p); }
async function pickFolder() { const p = await host.pickFolder(); if (p) { await sidebar.openFolder(p); localStorage.setItem("mdnest.lastFolder", p); } }
async function save(as: boolean) {
  let p = state.path;
  if (as || !p) p = await host.pickSavePath(p ? p.split(/[\\/]/).pop() : "untitled.md");
  if (!p) return;
  const md = currentMarkdown();
  try { await host.writeFile(p, md); state.path = p; state.lastSaved = md; setDirty(false); setTitle(); notify("Saved " + p); plugins.emit("file-saved", p); }
  catch (e: any) { notify("Save failed: " + (e.message ?? e)); }
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
  { id: "view.settings", title: "Preferences: Plugin Settings", run: () => { document.body.classList.add("pin-outline"); sidebar.select("settings"); } },
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
}, true);

plugins.activateAll([readingGoal, wordStats]); // order irrelevant: topo-sorted by depends
sidebar.addTab("settings", "⚙", undefined, {
  id: "settings", title: "Settings", render: (el) => {
    el.innerHTML = `<div class="mdn-settings">` + settingSpecs.map(({ owner, specs }) => `<h4>${owner}</h4>` + specs.map((s) => {
      const v = JSON.parse(localStorage.getItem(plugins.settingKey(owner, s.key)) ?? JSON.stringify(s.default));
      return s.type === "boolean" ? `<label><input type="checkbox" data-o="${owner}" data-k="${s.key}" ${v ? "checked" : ""}> ${s.title}</label>`
        : `<label>${s.title}<br><input type="${s.type === "number" ? "number" : "text"}" data-o="${owner}" data-k="${s.key}" value="${v}"></label>`;
    }).join("")).join("") + (plugins.errors.length ? `<h4>Plugin errors</h4>` + plugins.errors.map((e) => `<div>${e.id}: ${e.error}</div>`).join("") : "") + `</div>`;
    el.querySelectorAll<HTMLInputElement>("input").forEach((inp) => inp.onchange = () => {
      const v = inp.type === "checkbox" ? inp.checked : inp.type === "number" ? +inp.value : inp.value;
      localStorage.setItem(plugins.settingKey(inp.dataset.o!, inp.dataset.k!), JSON.stringify(v));
      plugins.emit("settings-changed", inp.dataset.o, inp.dataset.k, v); editor.refreshDecorations();
    });
  },
});
sidebar.select("files");

window.addEventListener("beforeunload", (e) => { if (state.dirty && host.kind === "browser") e.preventDefault(); });

// ---------- boot ----------
(async () => {
  await initThemes();
  const q = new URLSearchParams(location.search);
  const ws = q.get("folder") ?? localStorage.getItem("mdnest.lastFolder") ?? (await host.defaultWorkspace());
  if (ws) await sidebar.openFolder(ws).catch(() => {});
  const f = q.get("file") ?? localStorage.getItem("mdnest.lastFile") ?? (ws ? ws + "/sample.md" : null);
  if (f) await openFile(f); else afterLoad();
  if (q.get("sidebar") === "0") document.body.classList.remove("pin-outline");
  document.body.classList.add("mdn-ready");
})();
