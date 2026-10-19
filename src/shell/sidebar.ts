import type { Host, DirEntry, ListedFile } from "../host/types";
import type { SidebarPanel } from "../plugins/api";
import { EditorView } from "prosemirror-view";
import { escapeHtml } from "../editor/render";
import { osClass } from "./os";
import { ICONS, iconButton } from "./icons";

const DOC = /\.(md|markdown|mdown|mkd|mdx|txt|text)$/i;
const SORT_KEY = "mdnest.sidebarSort";
const VIEW_KEY = "mdnest.sidebarView";

export type SortKey = "name" | "modified" | "created" | "natural";
export interface SortState { key: SortKey; desc: boolean }

export interface SidebarActions {
  openFile(path: string): void;
  newFile(dir: string): void | Promise<void>;
  newFolder(dir: string): void | Promise<void>;
  rename(path: string, name: string): void | Promise<void>;
  duplicate(path: string): void | Promise<void>;
  trash(path: string): void | Promise<void>;
  reveal(path: string): void | Promise<void>;
  openFolder(): void | Promise<void>;
  openWindow(path?: string): void | Promise<void>;
  copyPath(path: string): void | Promise<void>;
  notify(m: string): void;
}

export function loadSort(): SortState {
  try {
    const raw = JSON.parse(localStorage.getItem(SORT_KEY) || "");
    if (raw && ["name", "modified", "created", "natural"].includes(raw.key)) {
      return { key: raw.key, desc: !!raw.desc };
    }
  } catch { /* default */ }
  return { key: "name", desc: false };
}
export function saveSort(s: SortState) { localStorage.setItem(SORT_KEY, JSON.stringify(s)); }

export function naturalCmp(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function sortEntries<T extends { name: string; isDir: boolean; mtime?: number; ctime?: number }>(entries: T[], sort: SortState): T[] {
  const dir = sort.desc ? -1 : 1;
  const cmp = (a: T, b: T) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let n = 0;
    if (sort.key === "modified") n = (a.mtime ?? 0) - (b.mtime ?? 0);
    else if (sort.key === "created") n = (a.ctime ?? 0) - (b.ctime ?? 0);
    else if (sort.key === "natural") n = naturalCmp(a.name, b.name);
    else n = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    return n * dir;
  };
  return [...entries].sort(cmp);
}

function parentOf(p: string): string {
  return p.replace(/[\\/][^\\/]*$/, "") || p;
}
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}
function revealLabel(): string {
  const os = osClass();
  if (os === "os-windows") return "Reveal in Explorer";
  if (os === "is-mac") return "Reveal in Finder";
  return "Open Containing Folder";
}

export interface ContextItem {
  id: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  /** Nested items. The parent stays open; the submenu opens beside it. */
  submenu?: ContextItem[];
}

interface MenuLevel { el: HTMLElement; rows: HTMLElement[]; index: number }

/**
 * Shared context menu (`.context-menu.dropdown-menu`).
 * A row with `submenu` opens that list beside the parent on hover, click, or ArrowRight.
 * The parent stays open. Near the window edge the submenu flips left or up.
 * Arrows move, Enter runs, Escape closes the deepest open level (then the menu).
 * Returns a close function.
 */
export function openContextMenu(x: number, y: number, items: ContextItem[], run: (id: string) => void): () => void {
  document.querySelectorAll(".context-menu").forEach((e) => e.remove());
  const root = document.createElement("div");
  root.className = "context-menu dropdown-menu";
  root.tabIndex = -1;
  const levels: MenuLevel[] = [];

  const place = (el: HTMLElement, left: number, top: number) => {
    el.style.left = Math.max(4, left) + "px";
    el.style.top = Math.max(4, top) + "px";
    document.body.appendChild(el);
    const rect = el.getBoundingClientRect();
    let nx = left, ny = top;
    if (rect.right > window.innerWidth - 4) nx = Math.max(4, window.innerWidth - rect.width - 8);
    if (rect.bottom > window.innerHeight - 4) ny = Math.max(4, window.innerHeight - rect.height - 8);
    el.style.left = nx + "px";
    el.style.top = ny + "px";
  };

  const closeSubsFrom = (depth: number) => {
    while (levels.length > depth) {
      const gone = levels.pop()!;
      if (gone.el !== root) gone.el.remove();
    }
  };

  const paintActive = () => {
    for (const level of levels) {
      level.rows.forEach((row, i) => row.classList.toggle("mdn-menu-active", i === level.index));
    }
  };

  const openSub = (parent: HTMLElement, items: ContextItem[], depth: number) => {
    closeSubsFrom(depth);
    const sub = document.createElement("div");
    sub.className = "context-menu dropdown-menu mdn-submenu";
    sub.dataset.depth = String(depth);
    const rows = fill(sub, items, depth);
    const pr = parent.getBoundingClientRect();
    // Measure first. place() clamps into the window, which would hide a right-edge overflow.
    document.body.appendChild(sub);
    const width = sub.offsetWidth;
    const height = sub.offsetHeight;
    const roomRight = window.innerWidth - pr.right;
    const left = roomRight < width + 4 && pr.left > width + 8 ? pr.left - width - 2 : pr.right - 4;
    let top = pr.top - 4;
    if (top + height > window.innerHeight - 4) top = Math.max(4, pr.bottom - height);
    if (top + height > window.innerHeight - 4) top = Math.max(4, window.innerHeight - height - 8);
    place(sub, left, top);
    levels.push({ el: sub, rows, index: 0 });
    paintActive();
  };

  const activate = (it: ContextItem, row: HTMLElement, depth: number) => {
    if (it.disabled) return;
    if (it.submenu?.length) {
      openSub(row, it.submenu, depth + 1);
      return;
    }
    close();
    run(it.id);
  };

  function fill(menu: HTMLElement, list: ContextItem[], depth: number): HTMLElement[] {
    const rows: HTMLElement[] = [];
    for (const it of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mdn-menu-item" + (it.danger ? " danger" : "") + (it.submenu?.length ? " mdn-menu-sub" : "");
      b.dataset.id = it.id;
      b.disabled = !!it.disabled;
      const text = document.createElement("span");
      text.className = "mdn-menu-text";
      text.textContent = it.label;
      b.appendChild(text);
      if (it.submenu?.length) {
        const caret = document.createElement("span");
        caret.className = "mdn-menu-caret";
        caret.textContent = "▸";
        b.appendChild(caret);
      }
      b.onmouseenter = () => {
        const level = levels[depth];
        if (!level) return;
        level.index = rows.indexOf(b);
        paintActive();
        if (it.submenu?.length && !it.disabled) openSub(b, it.submenu, depth + 1);
        else closeSubsFrom(depth + 1);
      };
      b.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        activate(it, b, depth);
      };
      menu.appendChild(b);
      rows.push(b);
    }
    return rows;
  }

  const rows = fill(root, items, 0);
  place(root, x, y);
  levels.push({ el: root, rows, index: 0 });
  paintActive();

  const close = () => {
    closeSubsFrom(1);
    root.remove();
    document.removeEventListener("mousedown", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const onDoc = (e: MouseEvent) => {
    const t = e.target as Node;
    if (levels.some((l) => l.el.contains(t))) return;
    close();
  };
  const onKey = (e: KeyboardEvent) => {
    const level = levels[levels.length - 1];
    if (!level) return;
    const row = level.rows[level.index];
    const item = itemAt(levels, items);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (levels.length > 1) { closeSubsFrom(levels.length - 1); paintActive(); }
      else close();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      const n = level.rows.length;
      if (!n) return;
      level.index = (level.index + dir + n) % n;
      paintActive();
      level.rows[level.index]?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      const it = item;
      if (it?.submenu?.length && row) openSub(row, it.submenu, levels.length);
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      if (levels.length > 1) { closeSubsFrom(levels.length - 1); paintActive(); }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (item && row) activate(item, row, levels.length - 1);
    }
  };
  setTimeout(() => {
    document.addEventListener("mousedown", onDoc, true);
    document.addEventListener("keydown", onKey, true);
    root.focus();
  }, 0);
  return close;
}

function itemAt(levels: MenuLevel[], items: ContextItem[]): ContextItem | undefined {
  let list = items;
  let found: ContextItem | undefined;
  for (let d = 0; d < levels.length; d++) {
    found = list[levels[d].index];
    list = found?.submenu ?? [];
  }
  return found;
}

function fmtTime(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const same = d.getFullYear() === now.getFullYear();
  return same
    ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export class Sidebar {
  el: HTMLElement; tabs: HTMLElement; content: HTMLElement; tree: HTMLElement; outline: HTMLElement;
  list: HTMLElement; searchInput: HTMLInputElement; searchResult: HTMLElement; footer: HTMLElement;
  root: string | null = null; activeFile: string | null = null;
  sort: SortState = loadSort();
  view: "tree" | "list" = (localStorage.getItem(VIEW_KEY) === "list" ? "list" : "tree");
  private expanded = new Set<string>();
  private filter = "";
  private actions: SidebarActions | null = null;
  private panels = new Map<string, { tab: HTMLElement; body: HTMLElement; panel?: SidebarPanel; cleanup?: any }>();
  private selectedPath: string | null = null;
  /** Expand a folder on the next refresh (after creating a child). */
  expandedAdd(path: string) { if (path) this.expanded.add(path); }
  private listCache: ListedFile[] = [];
  private caretHeading = -1;

  constructor(private host: Host, private openFile: (p: string) => void) {
    this.el = document.createElement("div"); this.el.id = "typora-sidebar";
    this.el.innerHTML = `<div class="sidebar-tabs" id="sidebar-tabs"></div>
      <div class="sidebar-files-head" id="sidebar-files-head">
        <button type="button" class="sidebar-view-btn" data-view="tree" title="Tree">Tree</button>
        <button type="button" class="sidebar-view-btn" data-view="list" title="List">List</button>
        <input id="file-library-search-input" type="search" placeholder="Search files…" autocomplete="off">
      </div>
      <div id="sidebar-content"></div>
      <div class="sidebar-footer" id="sidebar-footer">
        ${iconButton("new-file", "New File", ICONS.newFile)}
        ${iconButton("new-folder", "New Folder", ICONS.newFolder)}
        ${iconButton("open-folder", "Open Folder…", ICONS.openFolder)}
        <button type="button" data-act="sort" title="Sort" aria-label="Sort" id="sidebar-sort-btn">${ICONS.sort}<span class="sidebar-sort-label">Sort ▾</span></button>
        ${iconButton("search", "Search", ICONS.search)}
        ${iconButton("refresh", "Refresh", ICONS.refresh)}
      </div>`;
    this.tabs = this.el.querySelector(".sidebar-tabs")!;
    this.content = this.el.querySelector("#sidebar-content")!;
    this.footer = this.el.querySelector("#sidebar-footer")!;
    this.searchInput = this.el.querySelector("#file-library-search-input")!;
    this.tree = this.addTab("files", "Files", "file-library-tree");
    this.tree.classList.add("file-library");
    this.list = document.createElement("div");
    this.list.id = "file-library-list";
    this.list.className = "sidebar-content-content";
    this.content.appendChild(this.list);
    this.searchResult = document.createElement("div");
    this.searchResult.id = "file-library-search-result";
    this.searchResult.className = "sidebar-content-content";
    this.content.appendChild(this.searchResult);
    this.outline = this.addTab("outline", "Outline", "outline-content");
    this.select("files");
    this.syncViewButtons();
    this.el.querySelectorAll<HTMLButtonElement>(".sidebar-view-btn").forEach((b) => {
      b.onclick = () => this.setView(b.dataset.view === "list" ? "list" : "tree");
    });
    this.searchInput.addEventListener("input", () => { this.filter = this.searchInput.value; void this.applyFilter(); });
    this.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { this.searchInput.value = ""; this.filter = ""; void this.applyFilter(); this.searchInput.blur(); }
      if (e.key === "Enter") {
        const first = this.searchResult.querySelector<HTMLElement>(".typora-search-item, .file-list-item, .file-library-node");
        first?.click();
      }
    });
    this.footer.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.onclick = (e) => this.onFooter(b.dataset.act || "", e);
    });
    this.el.addEventListener("contextmenu", (e) => this.onContext(e));
    this.tree.addEventListener("keydown", (e) => this.onTreeKey(e));
    this.list.addEventListener("keydown", (e) => this.onTreeKey(e));
    this.tree.tabIndex = 0;
    this.list.tabIndex = 0;
  }

  setActions(a: SidebarActions) { this.actions = a; }

  addTab(id: string, title: string, elId?: string, panel?: SidebarPanel) {
    const tab = document.createElement("div"); tab.className = "sidebar-tab"; tab.textContent = title; tab.dataset.id = id;
    tab.onclick = () => this.select(id);
    const body = document.createElement("div"); body.className = "sidebar-content-content"; if (elId) body.id = elId;
    this.tabs.appendChild(tab); this.content.appendChild(body);
    this.panels.set(id, { tab, body, panel });
    return body;
  }
  select(id: string) {
    this.list.classList.remove("active");
    this.searchResult.classList.remove("active");
    for (const [k, p] of this.panels) {
      const on = k === id; p.tab.classList.toggle("active", on); p.body.classList.toggle("active", on);
      if (on && p.panel && !p.cleanup) p.cleanup = p.panel.render(p.body) || true;
    }
    if (id === "files") this.showFilesPane();
    document.body.classList.toggle("ty-show-outline", id === "outline");
    this.footer.classList.toggle("hidden", id === "outline");
    this.el.querySelector("#sidebar-files-head")?.classList.toggle("hidden", id !== "files");
  }
  private showFilesPane() {
    const searching = this.filter.trim().length > 0 && this.looksLikeContentQuery(this.filter);
    const filesTab = this.panels.get("files");
    if (filesTab) filesTab.body.classList.remove("active");
    this.list.classList.remove("active");
    this.searchResult.classList.remove("active");
    if (searching) this.searchResult.classList.add("active");
    else if (this.view === "list") this.list.classList.add("active");
    else if (filesTab) filesTab.body.classList.add("active");
  }
  private looksLikeContentQuery(q: string): boolean {
    return q.trim().length >= 2 && !q.includes("/") && !q.includes("\\");
  }
  reveal(id: string) {
    document.body.classList.add("pin-outline");
    const tab = this.panels.has(id) ? id : this.panels.has("p-" + id) ? "p-" + id : id;
    this.select(tab);
  }
  rerender(id: string) {
    const tab = this.panels.has(id) ? id : "p-" + id;
    const p = this.panels.get(tab);
    if (!p?.panel) return;
    if (typeof p.cleanup === "function") p.cleanup();
    p.body.innerHTML = "";
    p.cleanup = p.panel.render(p.body) || true;
  }

  setView(view: "tree" | "list") {
    this.view = view;
    localStorage.setItem(VIEW_KEY, view);
    this.syncViewButtons();
    this.showFilesPane();
    if (view === "list") void this.renderList();
  }
  private syncViewButtons() {
    this.el.querySelectorAll<HTMLButtonElement>(".sidebar-view-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.view === this.view);
    });
  }
  focusSearch() {
    document.body.classList.add("pin-outline");
    this.select("files");
    this.searchInput.focus();
    this.searchInput.select();
  }
  showTree() { this.select("files"); this.setView("tree"); }
  showList() { this.select("files"); this.setView("list"); }

  async openFolder(path: string) {
    this.root = path;
    this.expanded = new Set([path]);
    this.selectedPath = path;
    await this.refresh();
    this.select("files");
  }

  async refresh() {
    if (!this.root) return;
    await this.renderTree();
    if (this.view === "list" || this.filter) await this.renderList();
    if (this.filter.trim()) await this.applyFilter();
  }

  /** Re-list folders that are currently expanded (and the list view). */
  async refreshExpanded() { await this.refresh(); }

  private async renderTree() {
    if (!this.root) return;
    const scroll = this.content.scrollTop;
    this.tree.innerHTML = "";
    const title = document.createElement("div");
    title.className = "sidebar-folder-name";
    title.textContent = baseName(this.root) || this.root;
    title.dataset.path = this.root;
    this.tree.appendChild(title);
    const ul = document.createElement("div");
    this.tree.appendChild(ul);
    await this.renderDir(this.root, ul, true);
    this.content.scrollTop = scroll;
    this.markActive(this.activeFile);
  }

  private async renderDir(path: string, into: HTMLElement, force: boolean) {
    let entries: DirEntry[] = [];
    try { entries = await this.host.listDir(path); } catch (e) { into.textContent = String(e); return; }
    const enriched = entries
      .filter((e) => e.isDir || DOC.test(e.name))
      .map((e) => ({ ...e, mtime: 0, ctime: 0 }));
    // mtimes only when the sort needs them; name/natural stay cheap.
    if (this.sort.key === "modified" || this.sort.key === "created") {
      await Promise.all(enriched.map(async (e) => {
        const m = await this.host.mtime(e.path).catch(() => null);
        e.mtime = m ?? 0; e.ctime = m ?? 0;
      }));
    }
    const sorted = sortEntries(enriched, this.sort);
    const q = this.filter.trim().toLowerCase();
    for (const e of sorted) {
      if (q && !e.isDir && !e.name.toLowerCase().includes(q) && !this.looksLikeContentQuery(this.filter)) continue;
      const node = document.createElement("div");
      node.className = "file-library-node file-tree-node" + (e.isDir ? " file-library-folder" : " file-library-file");
      node.dataset.path = e.path;
      node.dataset.kind = e.isDir ? "dir" : "file";
      node.innerHTML = `<div class="file-node-content"><span class="file-node-icon">${e.isDir ? (this.expanded.has(e.path) ? "▾" : "▸") : "◦"}</span><span class="file-node-title">${escapeHtml(e.name)}</span></div>`;
      if (e.path === this.activeFile || e.path === this.selectedPath) node.classList.add("active");
      const content = node.firstElementChild as HTMLElement;
      if (e.isDir) {
        const kids = document.createElement("div"); kids.className = "file-node-children"; node.appendChild(kids);
        if (this.expanded.has(e.path)) {
          node.classList.add("file-node-expanded");
          await this.renderDir(e.path, kids, force);
        }
        content.onclick = async (ev) => {
          ev.stopPropagation();
          this.selectedPath = e.path;
          this.markSelected();
          const exp = node.classList.toggle("file-node-expanded");
          if (exp) this.expanded.add(e.path); else this.expanded.delete(e.path);
          content.querySelector(".file-node-icon")!.textContent = exp ? "▾" : "▸";
          if (exp && !kids.childElementCount) await this.renderDir(e.path, kids, true);
        };
      } else {
        content.onclick = (ev) => { ev.stopPropagation(); this.selectedPath = e.path; this.markSelected(); this.openFile(e.path); };
      }
      content.ondblclick = (ev) => {
        if (!e.isDir) return;
        ev.stopPropagation();
      };
      into.appendChild(node);
    }
  }

  private async renderList() {
    if (!this.root) return;
    const files = await this.host.listFiles(this.root, 5000).catch(() => [] as ListedFile[]);
    this.listCache = files;
    const q = this.filter.trim().toLowerCase();
    const content = this.looksLikeContentQuery(this.filter);
    const filtered = q && !content ? files.filter((f) => f.name.toLowerCase().includes(q)) : files;
    const sorted = sortEntries(filtered.map((f) => ({ ...f, isDir: false })), this.sort);
    const rows = await Promise.all(sorted.slice(0, 80).map(async (f) => {
      let excerpt = "";
      try { excerpt = await this.host.fileExcerpt(f.path); } catch { /* empty */ }
      return { ...f, excerpt };
    }));
    this.list.innerHTML = rows.map((f) => {
      const parent = parentOf(f.path).split(/[\\/]/).pop() || "";
      return `<div class="file-list-item${f.path === this.activeFile ? " active" : ""}" data-path="${escapeHtml(f.path)}" tabindex="0">
        <div class="file-list-item-file-name">${escapeHtml(f.name)}</div>
        <div class="file-list-item-summary">${escapeHtml(f.excerpt || "")}</div>
        <div class="file-list-item-time">${escapeHtml(fmtTime(f.mtime))}</div>
        <div class="file-list-item-parent-loc">${escapeHtml(parent)}</div>
      </div>`;
    }).join("") || `<div class="outline-item" style="opacity:.6">No files</div>`;
    this.list.querySelectorAll<HTMLElement>(".file-list-item").forEach((n) => {
      n.onclick = () => { this.selectedPath = n.dataset.path!; this.openFile(n.dataset.path!); };
    });
  }

  private async applyFilter() {
    const q = this.filter.trim();
    this.showFilesPane();
    if (!q) {
      this.searchResult.innerHTML = "";
      if (this.root) await this.renderTree();
      if (this.view === "list") await this.renderList();
      return;
    }
    if (this.root) await this.renderTree();
    if (!this.looksLikeContentQuery(q) || !this.root) {
      this.searchResult.innerHTML = "";
      return;
    }
    const hits = await this.host.searchFiles(this.root, q, 80).catch(() => []);
    const nameHits = (this.listCache.length ? this.listCache : await this.host.listFiles(this.root, 5000).catch(() => []))
      .filter((f) => f.name.toLowerCase().includes(q.toLowerCase()));
    const nameHtml = nameHits.slice(0, 30).map((f) =>
      `<div class="file-list-item" data-path="${escapeHtml(f.path)}"><div class="file-list-item-file-name">${escapeHtml(f.name)}</div><div class="file-list-item-parent-loc">${escapeHtml(parentOf(f.path))}</div></div>`).join("");
    const hitHtml = hits.map((h) =>
      `<div class="typora-search-item" data-path="${escapeHtml(h.path)}" data-line="${h.line}"><div class="file-list-item-file-name">${escapeHtml(baseName(h.path))}:${h.line}</div><div class="file-list-item-summary">${escapeHtml(h.snippet)}</div></div>`).join("");
    this.searchResult.innerHTML = (nameHtml || hitHtml) ? nameHtml + hitHtml : `<div class="outline-item" style="opacity:.6">No matches</div>`;
    this.searchResult.querySelectorAll<HTMLElement>(".file-list-item, .typora-search-item").forEach((n) => {
      n.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const line = n.dataset.line ? +n.dataset.line : undefined;
        const path = n.dataset.path!;
        const openAt = (window as any).mdnest?.openAt as undefined | ((p: string, line?: number) => void);
        if (line && openAt) void openAt(path, line);
        else this.openFile(path);
      });
    });
  }

  markActive(path: string | null) {
    this.activeFile = path;
    this.selectedPath = path ?? this.selectedPath;
    const mark = (root: ParentNode) => root.querySelectorAll<HTMLElement>(".file-library-node, .file-list-item").forEach((n) => {
      n.classList.toggle("active", n.dataset.path === path);
    });
    mark(this.tree); mark(this.list);
  }
  private markSelected() {
    this.tree.querySelectorAll<HTMLElement>(".file-library-node").forEach((n) => n.classList.toggle("selected", n.dataset.path === this.selectedPath));
  }

  /** Expand ancestors so `path` is visible, then select it. */
  async revealPath(path: string) {
    if (!this.root) return;
    document.body.classList.add("pin-outline");
    this.select("files");
    this.setView("tree");
    let cur = parentOf(path);
    const chain: string[] = [];
    while (cur && cur.length >= this.root.length) {
      chain.push(cur);
      if (cur === this.root) break;
      const next = parentOf(cur);
      if (next === cur) break;
      cur = next;
    }
    for (const p of chain) this.expanded.add(p);
    this.selectedPath = path;
    await this.renderTree();
    const node = this.tree.querySelector<HTMLElement>(`.file-library-node[data-path="${cssEscape(path)}"]`);
    node?.scrollIntoView({ block: "nearest" });
    node?.classList.add("active");
  }

  updateOutline(view: EditorView) {
    const items: { level: number; text: string; pos: number }[] = [];
    view.state.doc.descendants((n, pos) => {
      if (n.type.name === "heading") items.push({ level: n.attrs.level, text: n.textContent, pos });
      return n.type.name !== "heading" && !n.isTextblock;
    });
    this.outline.innerHTML = items.map((h, i) =>
      `<div class="outline-item outline-h${h.level}" data-i="${i}" data-pos="${h.pos}"><span class="outline-label">${escapeHtml(h.text) || "&nbsp;"}</span></div>`).join("")
      || `<div class="outline-item" style="opacity:.6">No headings</div>`;
    this.outline.querySelectorAll<HTMLElement>(".outline-item[data-i]").forEach((el) => el.onclick = () => {
      const hs = view.dom.querySelectorAll("h1,h2,h3,h4,h5,h6");
      (hs[+el.dataset.i!] as HTMLElement)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    this.highlightOutline(view);
  }

  /** Highlight the heading that contains the caret. */
  highlightOutline(view: EditorView) {
    const head = view.state.selection.head;
    let active = -1;
    let best = -1;
    this.outline.querySelectorAll<HTMLElement>(".outline-item[data-pos]").forEach((el, i) => {
      const pos = +(el.dataset.pos || 0);
      if (pos <= head && pos >= best) { best = pos; active = i; }
    });
    this.caretHeading = active;
    this.outline.querySelectorAll(".outline-item").forEach((el, i) => el.classList.toggle("outline-item-active", i === active));
  }

  private onFooter(act: string, ev: MouseEvent) {
    const dir = this.targetDir();
    if (act === "new-file") void this.actions?.newFile(dir);
    else if (act === "new-folder") void this.actions?.newFolder(dir);
    else if (act === "open-folder") void this.actions?.openFolder();
    else if (act === "search") this.focusSearch();
    else if (act === "refresh") void this.refresh();
    else if (act === "sort") this.openSortMenu(ev.clientX, ev.clientY);
  }

  private openSortMenu(x: number, y: number) {
    const keys: [SortKey, string][] = [["name", "Name"], ["modified", "Modified"], ["created", "Created"], ["natural", "Natural"]];
    const items: ContextItem[] = keys.map(([k, label]) => ({
      id: "sort:" + k,
      label: (this.sort.key === k ? "✓ " : "") + label,
    }));
    items.push({ id: "sort:flip", label: this.sort.desc ? "Ascending" : "Descending" });
    openContextMenu(x, y, items, (id) => {
      if (id === "sort:flip") this.sort = { ...this.sort, desc: !this.sort.desc };
      else this.sort = { key: id.slice(5) as SortKey, desc: this.sort.desc };
      saveSort(this.sort);
      void this.refresh();
    });
  }

  private targetDir(): string {
    const p = this.selectedPath;
    if (p && this.tree.querySelector(`.file-library-folder[data-path="${cssEscape(p)}"]`)) return p;
    if (p) return parentOf(p);
    return this.root || "";
  }

  private onContext(e: MouseEvent) {
    const t = e.target as HTMLElement;
    if (!this.el.contains(t)) return;
    if (t.closest("#outline-content, .sidebar-tab, #sidebar-footer")) return;
    if (!t.closest("#file-library-tree, #file-library-list, #file-library-search-result, .sidebar-folder-name, #sidebar-content")) return;
    e.preventDefault();
    e.stopPropagation();
    const node = t.closest<HTMLElement>(".file-library-node, .file-list-item, .sidebar-folder-name");
    const path = node?.dataset.path || null;
    const isDir = !!node?.classList.contains("file-library-folder") || path === this.root;
    if (path) this.selectedPath = path;
    const dir = path ? (isDir ? path : parentOf(path)) : (this.root || "");
    const items: ContextItem[] = [];
    if (path && !isDir) {
      items.push({ id: "open", label: "Open" });
      items.push({ id: "open-window", label: "Open in New Window" });
    }
    items.push({ id: "new-file", label: "New File" });
    items.push({ id: "new-folder", label: "New Folder" });
    if (path && path !== this.root) {
      items.push({ id: "rename", label: "Rename" });
      items.push({ id: "duplicate", label: "Duplicate" });
      items.push({ id: "delete", label: "Delete", danger: true });
    }
    items.push({ id: "reveal", label: revealLabel(), disabled: !path });
    items.push({ id: "copy", label: "Copy File Path", disabled: !path });
    items.push({ id: "refresh", label: "Refresh" });
    openContextMenu(e.clientX, e.clientY, items, (id) => {
      if (id === "open" && path) this.openFile(path);
      else if (id === "open-window" && path) void this.actions?.openWindow(path);
      else if (id === "new-file") void this.actions?.newFile(dir);
      else if (id === "new-folder") void this.actions?.newFolder(dir);
      else if (id === "rename" && path) this.startRename(path);
      else if (id === "duplicate" && path) void this.actions?.duplicate(path);
      else if (id === "delete" && path) void this.actions?.trash(path);
      else if (id === "reveal" && path) void this.actions?.reveal(path);
      else if (id === "copy" && path) void this.actions?.copyPath(path);
      else if (id === "refresh") void this.refresh();
    });
  }

  startRename(path: string) {
    const node = this.tree.querySelector<HTMLElement>(`.file-library-node[data-path="${cssEscape(path)}"] .file-node-title`)
      || this.list.querySelector<HTMLElement>(`.file-list-item[data-path="${cssEscape(path)}"] .file-list-item-file-name`);
    if (!node) return;
    const old = baseName(path);
    const input = document.createElement("input");
    input.className = "file-node-rename";
    input.value = old;
    node.replaceWith(input);
    input.focus();
    const dot = old.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : old.length);
    let done = false;
    const finish = async (ok: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (ok && name && name !== old) await this.actions?.rename(path, name);
      else await this.refresh();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); void finish(false); }
    });
    input.addEventListener("blur", () => setTimeout(() => void finish(true), 80));
  }

  private onTreeKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement) return;
    const nodes = [...this.tree.querySelectorAll<HTMLElement>(".file-library-node")].filter((n) => {
      const hidden = n.parentElement?.classList.contains("file-node-children") && !n.parentElement.parentElement?.classList.contains("file-node-expanded");
      return !hidden;
    });
    if (!nodes.length && e.key !== "F2") return;
    const idx = nodes.findIndex((n) => n.dataset.path === this.selectedPath);
    const cur = idx >= 0 ? nodes[idx] : null;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = nodes[Math.max(0, Math.min(nodes.length - 1, (idx < 0 ? 0 : idx) + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) { this.selectedPath = next.dataset.path || null; this.markSelected(); next.scrollIntoView({ block: "nearest" }); }
    } else if (e.key === "ArrowRight" && cur?.dataset.kind === "dir") {
      e.preventDefault();
      if (!cur.classList.contains("file-node-expanded")) (cur.querySelector(".file-node-content") as HTMLElement)?.click();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (cur?.classList.contains("file-node-expanded")) (cur.querySelector(".file-node-content") as HTMLElement)?.click();
      else if (cur) {
        const parent = cur.parentElement?.closest<HTMLElement>(".file-library-node");
        if (parent?.dataset.path) { this.selectedPath = parent.dataset.path; this.markSelected(); }
      }
    } else if (e.key === "Enter" && this.selectedPath) {
      e.preventDefault();
      const node = nodes.find((n) => n.dataset.path === this.selectedPath);
      if (node?.dataset.kind === "dir") (node.querySelector(".file-node-content") as HTMLElement)?.click();
      else this.openFile(this.selectedPath);
    } else if (e.key === "F2" && this.selectedPath && this.selectedPath !== this.root) {
      e.preventDefault();
      this.startRename(this.selectedPath);
    } else if (e.key === "Delete" && this.selectedPath && this.selectedPath !== this.root) {
      e.preventDefault();
      void this.actions?.trash(this.selectedPath);
    }
  }
}

function cssEscape(s: string): string {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}
