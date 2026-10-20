import type { Host, DirEntry, ListedFile } from "../host/types";
import type { SidebarPanel } from "../plugins/api";
import { EditorView } from "prosemirror-view";
import { headingText } from "../editor/headingsrc";
import { escapeHtml } from "../editor/render";
import { osClass } from "./os";
import { icon, hasIcon, iconButton } from "./icons";
import { t, wordsLabel, minutesLabel } from "../i18n";
import { countWords } from "../plugins/builtin/word-stats";

const DOC = /\.(md|markdown|mdown|mkd|mdx|txt|text)$/i;
const SORT_KEY = "mdnest.sidebarSort";
const VIEW_KEY = "mdnest.sidebarView";
const SECTIONS_KEY = "mdnest.sidebarSections";
const FOLDERS_KEY = "mdnest.recentFolders";
const FOLLOW_KEY = "mdnest.outlineFollow";
const SEARCH_MODE_KEY = "mdnest.searchMode";
const IMG = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i;

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
  clearRecent?(): void | Promise<void>;
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
  /** Shell icon name shown before the label. */
  icon?: string;
  /** Shortcut hint, drawn with CSS so it is not part of the row's text. */
  accel?: string;
  /** Radio/check mark. */
  checked?: boolean;
  /** A divider line; the other fields are ignored. */
  sep?: boolean;
  /** Nested items. The parent stays open; the submenu opens beside it. */
  submenu?: ContextItem[];
}

interface MenuLevel { el: HTMLElement; rows: HTMLElement[]; items: ContextItem[]; index: number }

/**
 * Shared context menu (`.context-menu.dropdown-menu`).
 * A row with `submenu` opens that list beside the parent on hover, click, or ArrowRight.
 * The parent stays open. Near the window edge the submenu flips left or up.
 * Arrows move, Enter runs, Escape closes the deepest open level (then the menu).
 * Labels go through t(); rows can carry an icon, a check mark and a shortcut hint.
 * Returns a close function.
 */
export function openContextMenu(x: number, y: number, items: ContextItem[], run: (id: string) => void): () => void {
  document.querySelectorAll(".context-menu").forEach((e) => e.remove());
  const root = document.createElement("div");
  root.className = "context-menu dropdown-menu";
  root.tabIndex = -1;
  const levels: MenuLevel[] = [];
  const hasIcons = (list: ContextItem[]) => list.some((i) => i.icon || i.checked !== undefined);

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

  const openSub = (parent: HTMLElement, list: ContextItem[], depth: number) => {
    closeSubsFrom(depth);
    const sub = document.createElement("div");
    sub.className = "context-menu dropdown-menu mdn-submenu";
    sub.dataset.depth = String(depth);
    const { rows, real } = fill(sub, list, depth);
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
    levels.push({ el: sub, rows, items: real, index: 0 });
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

  function fill(menu: HTMLElement, list: ContextItem[], depth: number): { rows: HTMLElement[]; real: ContextItem[] } {
    const rows: HTMLElement[] = [];
    const real: ContextItem[] = [];
    const iconCol = hasIcons(list);
    if (iconCol) menu.classList.add("mdn-menu-icons");
    for (const it of list) {
      if (it.sep) {
        if (menu.lastElementChild && !menu.lastElementChild.classList.contains("mdn-menu-sep")) {
          const sep = document.createElement("div");
          sep.className = "mdn-menu-sep";
          menu.appendChild(sep);
        }
        continue;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mdn-menu-item" + (it.danger ? " danger" : "") + (it.submenu?.length ? " mdn-menu-sub" : "") + (it.checked ? " checked" : "");
      b.dataset.id = it.id;
      b.disabled = !!it.disabled;
      if (iconCol) {
        const ic = document.createElement("span");
        ic.className = "mdn-menu-icon";
        ic.innerHTML = it.checked ? icon("check", 15, 2) : it.icon ? icon(it.icon, 15) : "";
        b.appendChild(ic);
      }
      const text = document.createElement("span");
      text.className = "mdn-menu-text";
      text.textContent = t(it.label);
      b.appendChild(text);
      if (it.accel) b.dataset.accel = it.accel;
      if (it.submenu?.length) {
        const caret = document.createElement("span");
        caret.className = "mdn-menu-caret";
        caret.innerHTML = icon("chevron", 12, 2);
        b.appendChild(caret);
      }
      const index = rows.length;
      b.onmouseenter = () => {
        const level = levels[depth];
        if (!level) return;
        level.index = index;
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
      real.push(it);
    }
    if (menu.lastElementChild?.classList.contains("mdn-menu-sep")) menu.lastElementChild.remove();
    return { rows, real };
  }

  const first = fill(root, items, 0);
  place(root, x, y);
  levels.push({ el: root, rows: first.rows, items: first.real, index: 0 });
  paintActive();

  const close = () => {
    closeSubsFrom(1);
    root.remove();
    document.removeEventListener("mousedown", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const onDoc = (e: MouseEvent) => {
    const tg = e.target as Node;
    if (levels.some((l) => l.el.contains(tg))) return;
    close();
  };
  const onKey = (e: KeyboardEvent) => {
    const level = levels[levels.length - 1];
    if (!level) return;
    const row = level.rows[level.index];
    const item = level.items[level.index];
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
      if (item?.submenu?.length && row) openSub(row, item.submenu, levels.length);
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

/** Open a menu under an element (header buttons, chips). */
export function openMenuAt(anchor: HTMLElement, items: ContextItem[], run: (id: string) => void): () => void {
  const r = anchor.getBoundingClientRect();
  return openContextMenu(r.left, r.bottom + 4, items, run);
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

/** Rail order; plugin panels not listed here go after the known ones. */
const RAIL_ORDER: Record<string, number> = { files: 1, outline: 2, search: 3, "p-ai": 4, "p-library": 5, "p-word-stats": 6, settings: 100 };
const RAIL_ICON: Record<string, string> = { files: "files", outline: "outline", search: "search", "p-ai": "ai", "p-library": "library", "p-word-stats": "stats", settings: "settings" };

type SearchMode = "all" | "name" | "content";

interface PanelRec {
  tab: HTMLElement;
  body: HTMLElement;
  head: HTMLElement;
  foot: HTMLElement;
  panel?: SidebarPanel;
  cleanup?: any;
  headCleanup?: any;
  footCleanup?: any;
}

export interface TabOptions {
  icon?: string;
  /** Builds header buttons and an optional sub-row; the core panels use this. */
  head?: (title: HTMLElement, buttons: HTMLElement, sub: HTMLElement) => void;
}

export class Sidebar {
  el: HTMLElement; rail: HTMLElement; tabs: HTMLElement; content: HTMLElement; tree: HTMLElement; outline: HTMLElement;
  list: HTMLElement; searchInput: HTMLInputElement; searchResult: HTMLElement;
  filesPane: HTMLElement; recentBody: HTMLElement; outlineFoot!: HTMLElement;
  private heads: HTMLElement; private foots: HTMLElement;
  root: string | null = null; activeFile: string | null = null;
  sort: SortState = loadSort();
  view: "tree" | "list" = (localStorage.getItem(VIEW_KEY) === "list" ? "list" : "tree");
  current = "files";
  private expanded = new Set<string>();
  private filter = "";
  private searchMode: SearchMode = (["all", "name", "content"].includes(localStorage.getItem(SEARCH_MODE_KEY) || "") ? localStorage.getItem(SEARCH_MODE_KEY) : "all") as SearchMode;
  private actions: SidebarActions | null = null;
  private panels = new Map<string, PanelRec>();
  private selectedPath: string | null = null;
  private recentPaths: string[] = [];
  private follow = localStorage.getItem(FOLLOW_KEY) !== "0";
  /** Expand a folder on the next refresh (after creating a child). */
  expandedAdd(path: string) { if (path) this.expanded.add(path); }
  private listCache: ListedFile[] = [];
  private caretHeading = -1;

  constructor(private host: Host, private openFile: (p: string) => void) {
    this.el = document.createElement("div"); this.el.id = "typora-sidebar"; this.el.className = "mdn-sb-v2";
    this.el.innerHTML = `<nav class="mdn-rail" id="sidebar-rail" aria-label="${t("Sidebar")}"><span class="rail-spacer"></span></nav>
      <div class="mdn-panel" id="sidebar-panel">
        <div class="mdn-panel-heads"></div>
        <div id="sidebar-content"></div>
        <div class="mdn-panel-foots"></div>
      </div>`;
    this.rail = this.el.querySelector(".mdn-rail")!;
    this.tabs = this.rail;
    this.heads = this.el.querySelector(".mdn-panel-heads")!;
    this.foots = this.el.querySelector(".mdn-panel-foots")!;
    this.content = this.el.querySelector("#sidebar-content")!;

    // ---- files ----
    this.filesPane = this.addTab("files", "Files", "sidebar-files-pane", undefined, { head: (title, btns) => this.buildFilesHead(title, btns) });
    const collapsed = this.loadSections();
    this.filesPane.innerHTML = `
      <section class="sb-sec${collapsed.recent ? " collapsed" : ""}" data-sec="recent">
        <div class="sb-sec-head" role="button" tabindex="0">${icon("chevronDown", 12, 2, "sec-caret")}<span class="sec-title">${t("Recently Opened")}</span><span class="sec-count">0</span></div>
        <div class="sb-sec-body" id="sidebar-recent"></div>
      </section>
      <section class="sb-sec${collapsed.ws ? " collapsed" : ""}" data-sec="ws">
        <div class="sb-sec-head" role="button" tabindex="0">${icon("chevronDown", 12, 2, "sec-caret")}<span class="sec-title">${t("Workspace")}</span>
          <button type="button" class="sec-sort" id="sidebar-sort-btn" title="${t("Sort")}" aria-label="${t("Sort")}">${icon("sort", 12, 1.8)}<span class="sidebar-sort-label"></span></button></div>
        <div class="sb-sec-body">
          <div id="file-library-tree" class="sidebar-content-content file-library"></div>
          <div id="file-library-list" class="sidebar-content-content"></div>
        </div>
      </section>`;
    this.recentBody = this.filesPane.querySelector("#sidebar-recent")!;
    this.tree = this.filesPane.querySelector("#file-library-tree")!;
    this.list = this.filesPane.querySelector("#file-library-list")!;
    this.filesPane.querySelectorAll<HTMLElement>(".sb-sec-head").forEach((h) => {
      const toggle = () => this.toggleSection(h.parentElement!.dataset.sec!);
      h.addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest("button")) toggle(); });
      h.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    });
    const sortBtn = this.filesPane.querySelector<HTMLButtonElement>("#sidebar-sort-btn")!;
    sortBtn.onclick = (e) => { e.stopPropagation(); this.openSortMenu(sortBtn); };
    this.paintSortLabel();
    this.renderRecentSection();
    this.renderEmptyTree();

    // ---- outline ----
    this.outline = this.addTab("outline", "Outline", "outline-content", undefined, { head: (title, btns) => {
      title.textContent = t("Outline");
      btns.innerHTML = iconButton("follow", t("Follow Cursor"), icon("locate", 16), this.follow ? ' aria-pressed="true"' : ' aria-pressed="false"', "ph-btn" + (this.follow ? " on" : ""))
        + iconButton("expand", t("Expand All"), icon("expandAll", 16))
        + iconButton("collapse", t("Collapse All"), icon("collapseAll", 16));
      btns.addEventListener("click", (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
        if (!b) return;
        if (b.dataset.act === "expand") this.expandOutline();
        else if (b.dataset.act === "collapse") this.collapseOutline();
        else if (b.dataset.act === "follow") {
          this.follow = !this.follow;
          localStorage.setItem(FOLLOW_KEY, this.follow ? "1" : "0");
          b.classList.toggle("on", this.follow);
          b.setAttribute("aria-pressed", String(this.follow));
          if (this.follow) this.scrollActiveOutline();
        }
      });
    } });
    this.outlineFoot = this.panels.get("outline")!.foot;
    this.outlineFoot.classList.add("mdn-panel-foot");

    // ---- search ----
    this.searchResult = this.addTab("search", "Search", "file-library-search-result", undefined, { head: (title, _btns, sub) => {
      title.textContent = t("Search");
      sub.innerHTML = `<label class="sb-search">${icon("search", 14)}<input id="file-library-search-input" type="search" placeholder="${t("Search in files…")}" autocomplete="off" spellcheck="false"></label>
        <div class="seg" role="tablist">${(["all", "name", "content"] as SearchMode[]).map((m) => `<button type="button" data-mode="${m}" class="${m === this.searchMode ? "on" : ""}">${t(m === "all" ? "All" : m === "name" ? "File names" : "Contents")}</button>`).join("")}</div>`;
      sub.querySelectorAll<HTMLButtonElement>(".seg button").forEach((b) => b.onclick = () => {
        this.searchMode = b.dataset.mode as SearchMode;
        localStorage.setItem(SEARCH_MODE_KEY, this.searchMode);
        sub.querySelectorAll(".seg button").forEach((x) => x.classList.toggle("on", x === b));
        void this.applyFilter();
      });
    } });
    this.searchInput = this.el.querySelector("#file-library-search-input")!;
    this.searchInput.addEventListener("input", () => { this.filter = this.searchInput.value; void this.applyFilter(); });
    this.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { this.searchInput.value = ""; this.filter = ""; void this.applyFilter(); this.searchInput.blur(); }
      if (e.key === "Enter") {
        const first = this.searchResult.querySelector<HTMLElement>(".file-list-item, .typora-search-item");
        first?.click();
      }
    });
    this.searchResult.innerHTML = this.searchHint();

    this.select("files");
    this.el.addEventListener("contextmenu", (e) => this.onContext(e));
    this.tree.addEventListener("keydown", (e) => this.onTreeKey(e));
    this.list.addEventListener("keydown", (e) => this.onTreeKey(e));
    this.tree.tabIndex = 0;
    this.list.tabIndex = 0;
  }

  setActions(a: SidebarActions) { this.actions = a; }

  // ---------- panels ----------

  addTab(id: string, title: string, elId?: string, panel?: SidebarPanel, opts: TabOptions = {}) {
    const name = opts.icon || panel?.icon || RAIL_ICON[id] || "";
    const label = t(title === "⚙" ? "Settings" : title);
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "mdn-rail-btn sidebar-tab";
    tab.dataset.id = id;
    tab.setAttribute("aria-label", label);
    tab.style.order = String(RAIL_ORDER[id] ?? 50);
    tab.innerHTML = (hasIcon(name) ? icon(name, 20) : `<span class="rail-letter">${escapeHtml(label.slice(0, 1))}</span>`) + `<span class="mdn-tip">${escapeHtml(label)}</span>`;
    // a click answers the tooltip's question: hide it until the pointer leaves the button
    tab.onclick = () => { tab.classList.add("tip-off"); this.select(id); };
    tab.onmouseleave = () => tab.classList.remove("tip-off");
    this.rail.appendChild(tab);

    const head = document.createElement("div");
    head.className = "mdn-head";
    head.dataset.for = id;
    head.innerHTML = `<div class="mdn-panel-head"><div class="ph-title"></div><div class="ph-btns"></div></div><div class="mdn-panel-sub"></div>`;
    const titleEl = head.querySelector<HTMLElement>(".ph-title")!;
    const btns = head.querySelector<HTMLElement>(".ph-btns")!;
    const sub = head.querySelector<HTMLElement>(".mdn-panel-sub")!;
    titleEl.textContent = label;
    this.heads.appendChild(head);

    const foot = document.createElement("div");
    foot.className = "mdn-foot";
    foot.dataset.for = id;
    this.foots.appendChild(foot);

    const body = document.createElement("div"); body.className = "sidebar-content-content"; if (elId) body.id = elId;
    body.dataset.panel = id;
    this.content.appendChild(body);
    const rec: PanelRec = { tab, body, head, foot, panel };
    this.panels.set(id, rec);

    if (opts.head) opts.head(titleEl, btns, sub);
    if (panel?.actions?.length) {
      btns.innerHTML = panel.actions.map((a) => iconButton(a.id, t(a.title), icon(a.icon, 16))).join("");
      btns.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((b) => {
        const a = panel.actions!.find((x) => x.id === b.dataset.act)!;
        b.onclick = (ev) => a.run(ev);
      });
    }
    return body;
  }

  select(id: string) {
    if (id === "recent") {
      // The recent list lives in the Files panel now.
      this.select("files");
      this.setSection("recent", false);
      this.filesPane.querySelector('[data-sec="recent"]')?.scrollIntoView({ block: "start" });
      return;
    }
    if (!this.panels.has(id)) return;
    this.current = id;
    for (const [k, p] of this.panels) {
      const on = k === id;
      p.tab.classList.toggle("active", on);
      p.tab.setAttribute("aria-pressed", String(on));
      p.body.classList.toggle("active", on);
      p.head.classList.toggle("active", on);
      p.foot.classList.toggle("active", on);
      if (on && p.panel) {
        if (!p.headCleanup && p.panel.renderHead) p.headCleanup = p.panel.renderHead(p.head.querySelector(".mdn-panel-sub")!) || true;
        if (!p.footCleanup && p.panel.renderFoot) { p.foot.classList.add("mdn-panel-foot"); p.footCleanup = p.panel.renderFoot(p.foot) || true; }
        if (!p.cleanup) p.cleanup = p.panel.render(p.body) || true;
      }
    }
    if (id === "files") this.showFilesPane();
    document.body.classList.toggle("ty-show-outline", id === "outline");
    this.el.dataset.panel = id;
  }
  private showFilesPane() {
    if (!this.tree) return;
    this.tree.classList.toggle("active", this.view !== "list");
    this.list.classList.toggle("active", this.view === "list");
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

  // ---------- files header, workspace switcher, more menu ----------

  private buildFilesHead(title: HTMLElement, btns: HTMLElement) {
    title.innerHTML = `<button type="button" class="ws-switch" id="sidebar-ws-switch" title="${t("Switch workspace")}"><span class="ws-icon">${icon("folderOpen", 14)}</span><span class="ws-name sidebar-folder-name">${t("No folder open")}</span>${icon("chevronDown", 13, 2, "ws-caret")}</button>`;
    btns.innerHTML = iconButton("new-file", t("New File"), icon("plusFile", 16))
      + iconButton("new-folder", t("New Folder"), icon("plusFolder", 16))
      + iconButton("collapse-all", t("Collapse All"), icon("collapseAll", 16))
      + iconButton("more", t("More…"), icon("more", 16), ' aria-haspopup="menu"');
    btns.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((b) => {
      b.onclick = (e) => this.onHeadAction(b.dataset.act || "", b, e);
    });
    const sw = title.querySelector<HTMLButtonElement>("#sidebar-ws-switch")!;
    sw.onclick = () => this.openWorkspaceMenu(sw);
  }

  /** Header buttons keep the old footer action names. */
  private onHeadAction(act: string, anchor: HTMLElement, _ev?: MouseEvent) {
    const dir = this.targetDir();
    if (act === "new-file") void this.actions?.newFile(dir);
    else if (act === "new-folder") void this.actions?.newFolder(dir);
    else if (act === "open-folder") void this.actions?.openFolder();
    else if (act === "search") this.focusSearch();
    else if (act === "refresh") void this.refresh();
    else if (act === "sort") this.openSortMenu(anchor);
    else if (act === "collapse-all") this.collapseAll();
    else if (act === "more") this.openMoreMenu(anchor);
  }

  private sortItems(): ContextItem[] {
    const keys: [SortKey, string][] = [["name", "Name"], ["modified", "Modified"], ["created", "Created"], ["natural", "Natural"]];
    return [
      ...keys.map(([k, label]) => ({ id: "sort:" + k, label, checked: this.sort.key === k })),
      { id: "", label: "", sep: true },
      { id: "sort:asc", label: "Ascending", checked: !this.sort.desc },
      { id: "sort:desc", label: "Descending", checked: this.sort.desc },
    ];
  }
  private runSort(id: string) {
    if (id === "sort:asc" || id === "sort:desc") this.sort = { ...this.sort, desc: id === "sort:desc" };
    else if (id === "sort:flip") this.sort = { ...this.sort, desc: !this.sort.desc };
    else this.sort = { key: id.slice(5) as SortKey, desc: this.sort.desc };
    saveSort(this.sort);
    this.paintSortLabel();
    void this.refresh();
  }
  private paintSortLabel() {
    const label = this.filesPane?.querySelector(".sidebar-sort-label");
    const names: Record<SortKey, string> = { name: "Name", modified: "Modified", created: "Created", natural: "Natural" };
    if (label) label.textContent = t(names[this.sort.key]) + (this.sort.desc ? " ↓" : "");
  }
  private openSortMenu(anchor: HTMLElement) {
    openMenuAt(anchor, this.sortItems(), (id) => this.runSort(id));
  }

  openMoreMenu(anchor: HTMLElement) {
    const items: ContextItem[] = [
      { id: "sort", label: "Sort by", icon: "sort", submenu: this.sortItems() },
      { id: "view", label: "View", icon: "list", submenu: [
        { id: "view:tree", label: "Tree View", checked: this.view === "tree" },
        { id: "view:list", label: "List View", checked: this.view === "list" },
      ] },
      { id: "", label: "", sep: true },
      { id: "locate", label: "Reveal in Sidebar", icon: "locate", disabled: !this.activeFile },
      { id: "collapse-all", label: "Collapse All", icon: "collapseAll", disabled: !this.root },
      { id: "refresh", label: "Refresh", icon: "refresh", disabled: !this.root },
      { id: "", label: "", sep: true },
      { id: "open-folder", label: "Open Folder…", icon: "folderOpen" },
      { id: "reveal-root", label: revealLabel(), icon: "reveal", disabled: !this.root },
      { id: "copy-root", label: "Copy File Path", icon: "link", disabled: !this.root },
    ];
    openMenuAt(anchor, items, (id) => {
      if (id.startsWith("sort:")) this.runSort(id);
      else if (id === "view:tree") this.setView("tree");
      else if (id === "view:list") this.setView("list");
      else if (id === "locate" && this.activeFile) void this.revealPath(this.activeFile);
      else if (id === "collapse-all") this.collapseAll();
      else if (id === "refresh") void this.refresh();
      else if (id === "open-folder") void this.actions?.openFolder();
      else if (id === "reveal-root" && this.root) void this.actions?.reveal(this.root);
      else if (id === "copy-root" && this.root) void this.actions?.copyPath(this.root);
    });
  }

  recentFolders(): string[] {
    try { const v = JSON.parse(localStorage.getItem(FOLDERS_KEY) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
  }
  private rememberFolder(p: string) {
    const list = [p, ...this.recentFolders().filter((x) => x !== p)].slice(0, 8);
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(list));
  }
  openWorkspaceMenu(anchor: HTMLElement) {
    const folders = this.recentFolders();
    const items: ContextItem[] = folders.map((f, i) => ({ id: "ws:" + i, label: baseName(f) || f, icon: f === this.root ? undefined : "folder", checked: f === this.root ? true : undefined }));
    if (!items.length) items.push({ id: "none", label: "No recent folders", disabled: true });
    items.push({ id: "", label: "", sep: true });
    items.push({ id: "open-folder", label: "Open Folder…", icon: "folderOpen" });
    items.push({ id: "new-window", label: "New Window", icon: "window" });
    if (folders.length) items.push({ id: "clear", label: "Clear Items", icon: "x" });
    const close = openMenuAt(anchor, items, (id) => {
      if (id.startsWith("ws:")) {
        const f = folders[+id.slice(3)];
        if (f && f !== this.root) { const open = (window as any).mdnest?.openFolder as ((p: string) => any) | undefined; if (open) void open(f); else void this.openFolder(f); }
      } else if (id === "open-folder") void this.actions?.openFolder();
      else if (id === "new-window") void this.actions?.openWindow();
      else if (id === "clear") localStorage.setItem(FOLDERS_KEY, JSON.stringify(this.root ? [this.root] : []));
    });
    // Full paths as tooltips, so same-named folders can be told apart.
    document.querySelectorAll<HTMLElement>(".context-menu .mdn-menu-item[data-id^='ws:']").forEach((b) => { b.title = folders[+b.dataset.id!.slice(3)] || ""; });
    return close;
  }

  // ---------- collapsible sections + recent ----------

  private loadSections(): Record<string, boolean> {
    try { return JSON.parse(localStorage.getItem(SECTIONS_KEY) || "{}") || {}; } catch { return {}; }
  }
  setSection(sec: string, collapsed: boolean) {
    const el = this.filesPane.querySelector<HTMLElement>(`.sb-sec[data-sec="${sec}"]`);
    if (!el) return;
    el.classList.toggle("collapsed", collapsed);
    const all = this.loadSections(); all[sec] = collapsed;
    localStorage.setItem(SECTIONS_KEY, JSON.stringify(all));
  }
  toggleSection(sec: string) {
    const el = this.filesPane.querySelector<HTMLElement>(`.sb-sec[data-sec="${sec}"]`);
    if (el) this.setSection(sec, !el.classList.contains("collapsed"));
  }

  /** Recent files shown at the top of the Files panel (most recent first). */
  setRecent(paths: string[]) {
    this.recentPaths = paths.slice();
    this.renderRecentSection();
  }
  private renderRecentSection() {
    const shown = this.recentPaths.slice(0, 5);
    const count = this.filesPane.querySelector(".sb-sec[data-sec=recent] .sec-count");
    if (count) count.textContent = String(this.recentPaths.length);
    this.recentBody.innerHTML = shown.map((p) => {
      const dir = baseName(parentOf(p));
      return `<div class="file-library-node file-tree-node recent-file${p === this.activeFile ? " current" : ""}" data-path="${escapeHtml(p)}" title="${escapeHtml(p)}"><div class="file-node-content"><span class="file-node-open-state"></span><span class="file-node-icon">${icon("clock", 15)}</span><span class="file-node-title">${escapeHtml(baseName(p))}</span><span class="recent-dir">${escapeHtml(dir)}</span></div></div>`;
    }).join("") || `<div class="sb-empty">${t("No recent files")}</div>`;
    this.recentBody.querySelectorAll<HTMLElement>(".recent-file").forEach((n) => (n.onclick = () => this.openFile(n.dataset.path!)));
  }

  private renderEmptyTree() {
    if (this.root) return;
    this.tree.innerHTML = `<div class="sb-empty-state">${icon("folderOpen", 28, 1.4)}<p>${t("No folder open")}</p><button type="button" class="sb-btn" data-act="open-folder" title="Open Folder…">${t("Open Folder…")}</button></div>`;
    this.tree.querySelector<HTMLButtonElement>("button")!.onclick = () => void this.actions?.openFolder();
  }

  // ---------- views ----------

  setView(view: "tree" | "list") {
    this.view = view;
    localStorage.setItem(VIEW_KEY, view);
    this.showFilesPane();
    if (view === "list") void this.renderList();
  }
  focusSearch() {
    document.body.classList.add("pin-outline");
    this.select("search");
    this.searchInput.focus();
    this.searchInput.select();
  }
  showTree() { this.select("files"); this.setView("tree"); }
  showList() { this.select("files"); this.setView("list"); }

  async openFolder(path: string) {
    this.root = path;
    this.expanded = new Set([path]);
    this.selectedPath = path;
    this.rememberFolder(path);
    const name = this.el.querySelector<HTMLElement>(".ws-name");
    if (name) { name.textContent = baseName(path) || path; name.dataset.path = path; name.title = path; }
    await this.refresh();
    this.select("files");
  }

  async refresh() {
    if (!this.root) return;
    await this.renderTree();
    if (this.view === "list") await this.renderList();
    if (this.filter.trim()) await this.applyFilter();
  }

  /** Re-list folders that are currently expanded (and the list view). Selection and expansion stay. */
  async refreshExpanded(paths?: string[]) {
    if (!this.root) return;
    if (paths && paths.length && this.view !== "list") {
      const dirs = new Set<string>();
      for (const p of paths) {
        const parent = parentOf(p);
        if (parent === this.root || this.expanded.has(parent)) dirs.add(parent);
        // A new directory event should also refresh its parent so the folder itself appears.
        if (this.expanded.has(p)) dirs.add(p);
      }
      if (dirs.size) {
        for (const dir of dirs) await this.rerenderFolder(dir);
        this.markActive(this.activeFile);
      }
    } else {
      await this.renderTree();
    }
    if (this.view === "list") await this.renderList();
    if (this.filter.trim()) await this.applyFilter();
  }

  private depthOf(path: string): number {
    if (!this.root || path === this.root) return 0;
    return path.slice(this.root.length).split(/[\\/]/).filter(Boolean).length - 1;
  }

  /** Replace the children of one expanded folder without collapsing siblings. */
  private async rerenderFolder(dir: string) {
    if (!this.root) return;
    if (dir === this.root) {
      const holder = this.tree.querySelector(":scope > .file-tree-root") as HTMLElement | null;
      if (!holder) { await this.renderTree(); return; }
      holder.innerHTML = "";
      await this.renderDir(this.root, holder, true);
      return;
    }
    const node = this.tree.querySelector<HTMLElement>(`.file-library-folder[data-path="${cssEscape(dir)}"]`);
    if (!node) {
      // Parent may have been created outside an expanded folder; refresh the root listing.
      await this.rerenderFolder(this.root);
      return;
    }
    let kids = node.querySelector(":scope > .file-node-children") as HTMLElement | null;
    if (!kids) {
      kids = document.createElement("div");
      kids.className = "file-node-children";
      node.appendChild(kids);
    }
    kids.innerHTML = "";
    if (this.expanded.has(dir)) {
      node.classList.add("file-node-expanded");
      this.paintFolderIcon(node, true);
      await this.renderDir(dir, kids, true);
    }
  }

  private async renderTree() {
    if (!this.root) { this.renderEmptyTree(); return; }
    const scroll = this.content.scrollTop;
    this.tree.innerHTML = "";
    const ul = document.createElement("div");
    ul.className = "file-tree-root";
    this.tree.appendChild(ul);
    await this.renderDir(this.root, ul, true);
    if (!ul.childElementCount) ul.innerHTML = `<div class="sb-empty">${t("No files")}</div>`;
    this.content.scrollTop = scroll;
    this.markActive(this.activeFile);
  }

  private paintFolderIcon(node: HTMLElement, open: boolean) {
    const ic = node.querySelector(":scope > .file-node-content > .file-node-icon");
    if (ic) ic.innerHTML = icon(open ? "folderOpen" : "folder", 16);
  }

  private nodeHtml(e: { name: string; path: string; isDir: boolean }, depth: number, open: boolean): string {
    const guides = Array.from({ length: depth }, () => '<i class="guide"></i>').join("");
    const caret = `<span class="file-node-open-state">${e.isDir ? icon("chevron", 12, 2) : ""}</span>`;
    const ic = e.isDir ? icon(open ? "folderOpen" : "folder", 16) : IMG.test(e.name) ? icon("image", 16) : icon("md", 16);
    const dot = e.isDir ? -1 : e.name.lastIndexOf(".");
    const title = dot > 0 ? `${escapeHtml(e.name.slice(0, dot))}<span class="ext">${escapeHtml(e.name.slice(dot))}</span>` : escapeHtml(e.name);
    return `<div class="file-node-content">${guides}${caret}<span class="file-node-icon">${ic}</span><span class="file-node-title">${title}</span><span class="row-acts"><button type="button" tabindex="-1" data-row-act="more" title="${t("More…")}" aria-label="${t("More…")}">${icon("more", 15)}</button></span></div>`;
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
    const depth = path === this.root ? 0 : this.depthOf(path) + 1;
    for (const e of sorted) {
      const node = document.createElement("div");
      const assets = e.isDir && /^(assets|images?|img|图片|素材)$/i.test(e.name);
      node.className = "file-library-node file-tree-node" + (e.isDir ? " file-library-folder" : " file-library-file") + (assets ? " kind-assets" : "");
      node.dataset.path = e.path;
      node.dataset.kind = e.isDir ? "dir" : "file";
      node.innerHTML = this.nodeHtml(e, depth, this.expanded.has(e.path));
      if (e.path === this.activeFile || e.path === this.selectedPath) node.classList.add("active");
      const content = node.firstElementChild as HTMLElement;
      const more = content.querySelector<HTMLButtonElement>("[data-row-act=more]")!;
      more.onclick = (ev) => {
        ev.stopPropagation();
        const r = more.getBoundingClientRect();
        this.showNodeMenu(node, r.left, r.bottom + 2);
      };
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
          this.paintFolderIcon(node, exp);
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

  collapseAll() {
    if (!this.root) return;
    this.expanded = new Set([this.root]);
    this.tree.querySelectorAll<HTMLElement>(".file-library-folder.file-node-expanded").forEach((n) => {
      n.classList.remove("file-node-expanded");
      this.paintFolderIcon(n, false);
    });
  }

  private async renderList() {
    if (!this.root) return;
    const files = await this.host.listFiles(this.root, 5000).catch(() => [] as ListedFile[]);
    this.listCache = files;
    const sorted = sortEntries(files.map((f) => ({ ...f, isDir: false })), this.sort);
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
        <div class="file-list-item-meta"><span class="file-list-item-time">${escapeHtml(fmtTime(f.mtime))}</span><span class="file-list-item-parent-loc">${escapeHtml(parent)}</span></div>
      </div>`;
    }).join("") || `<div class="sb-empty">${t("No files")}</div>`;
    this.list.querySelectorAll<HTMLElement>(".file-list-item").forEach((n) => {
      n.onclick = () => { this.selectedPath = n.dataset.path!; this.openFile(n.dataset.path!); };
    });
  }

  private searchHint(): string {
    return `<div class="sb-empty-state">${icon("search", 26, 1.4)}<p>${t(this.root ? "Search file names and contents in this folder." : "Open a folder to search it.")}</p></div>`;
  }

  private async applyFilter() {
    const q = this.filter.trim();
    if (!q || !this.root) { this.searchResult.innerHTML = this.searchHint(); return; }
    const wantNames = this.searchMode !== "content";
    const wantContent = this.searchMode !== "name" && this.looksLikeContentQuery(q);
    const files = wantNames ? (this.listCache.length ? this.listCache : await this.host.listFiles(this.root, 5000).catch(() => [] as ListedFile[])) : [];
    if (files.length) this.listCache = files;
    const hits = wantContent ? await this.host.searchFiles(this.root, q, 80).catch(() => []) : [];
    if (this.filter.trim() !== q) return; // a newer query is running
    const nameHits = files.filter((f) => f.name.toLowerCase().includes(q.toLowerCase())).slice(0, 30);
    const rel = (p: string) => (this.root && p.startsWith(this.root) ? p.slice(this.root.length + 1) : p);
    const nameHtml = nameHits.map((f) =>
      `<div class="file-list-item search-name-hit" data-path="${escapeHtml(f.path)}">${icon("md", 14)}<div class="sr-main"><div class="file-list-item-file-name">${escapeHtml(f.name)}</div><div class="file-list-item-parent-loc">${escapeHtml(rel(parentOf(f.path)))}</div></div></div>`).join("");
    const hitHtml = hits.map((h) =>
      `<div class="typora-search-item" data-path="${escapeHtml(h.path)}" data-line="${h.line}"><div class="file-list-item-file-name">${escapeHtml(baseName(h.path))}<span class="sr-line">:${h.line}</span></div><div class="file-list-item-summary">${markHit(h.snippet, q)}</div></div>`).join("");
    const sec = (title: string, n: number, html: string) => n ? `<div class="sr-sec-head">${t(title)}<span class="sec-count">${n}</span></div>${html}` : "";
    const total = nameHits.length + hits.length;
    this.searchResult.innerHTML = total
      ? `<div class="sr-count">${t("{n} results", { n: total })}</div>` + sec("File names", nameHits.length, nameHtml) + sec("Contents", hits.length, hitHtml)
      : `<div class="sb-empty">${t("No matches")}</div>`;
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
    this.recentBody.querySelectorAll<HTMLElement>(".recent-file").forEach((n) => n.classList.toggle("current", n.dataset.path === path));
  }
  private markSelected() {
    this.tree.querySelectorAll<HTMLElement>(".file-library-node").forEach((n) => n.classList.toggle("selected", n.dataset.path === this.selectedPath));
  }

  /** Expand ancestors so `path` is visible, then select it. */
  async revealPath(path: string) {
    if (!this.root) return;
    document.body.classList.add("pin-outline");
    this.select("files");
    this.setSection("ws", false);
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

  // ---------- outline ----------

  /** Collapsed heading positions for the document that is open. Cleared when another file opens. */
  private outlineCollapsed = new Set<number>();
  private outlineFor = "";

  private outlineKey(): string {
    return (window as any).mdnest?.state?.path || "";
  }

  updateOutline(view: EditorView) {
    const key = this.outlineKey();
    if (key !== this.outlineFor) { this.outlineCollapsed.clear(); this.outlineFor = key; }
    const items: { level: number; text: string; pos: number; children: boolean }[] = [];
    view.state.doc.descendants((n, pos) => {
      if (n.type.name === "heading") items.push({ level: n.attrs.level, text: headingText(n), pos, children: false });
      return n.type.name !== "heading" && !n.isTextblock;
    });
    for (let i = 0; i < items.length; i++) {
      items[i].children = items.slice(i + 1).some((h) => h.level > items[i].level) && (i + 1 >= items.length || items[i + 1].level > items[i].level);
    }
    const hidden = new Set<number>();
    const hiddenCount = new Map<number, number>();
    for (let i = 0; i < items.length; i++) {
      if (!this.outlineCollapsed.has(items[i].pos)) continue;
      let n = 0;
      for (let j = i + 1; j < items.length && items[j].level > items[i].level; j++) { hidden.add(j); n++; }
      hiddenCount.set(i, n);
    }
    const min = items.length ? Math.min(...items.map((h) => h.level)) : 1;
    // Guides follow the visual nesting (a heading under H1 that skips H2 still indents once).
    const stack: number[] = [];
    const depth = items.map((h) => {
      while (stack.length && stack[stack.length - 1] >= h.level) stack.pop();
      const d = stack.length;
      stack.push(h.level);
      return d;
    });
    this.outline.innerHTML = items.map((h, i) => {
      if (hidden.has(i)) return "";
      const closed = this.outlineCollapsed.has(h.pos);
      const open = closed ? "outline-item-closed" : "outline-item-open";
      const exp = h.children ? `<span class="outline-expander" data-pos="${h.pos}">${icon(closed ? "chevron" : "chevronDown", 11, 2)}</span>` : `<span class="outline-expander outline-expander-empty"></span>`;
      const guides = Array.from({ length: depth[i] }, () => '<i class="guide"></i>').join("");
      const count = closed && hiddenCount.get(i) ? `<span class="row-count">${hiddenCount.get(i)}</span>` : "";
      return `<div class="outline-item outline-h${h.level} ${h.children ? open : ""}" data-i="${i}" data-pos="${h.pos}" data-rel="${h.level - min}"><span class="ol-ind">${guides}</span>${exp}<span class="ol-lv">H${h.level}</span><span class="outline-label">${escapeHtml(h.text) || "&nbsp;"}</span>${count}</div>`;
    }).join("") || `<div class="sb-empty">${t("No headings")}</div>`;
    this.outline.querySelectorAll<HTMLElement>(".outline-expander:not(.outline-expander-empty)").forEach((el) => el.addEventListener("click", (e) => {
      e.stopPropagation();
      const pos = +(el.dataset.pos || 0);
      if (this.outlineCollapsed.has(pos)) this.outlineCollapsed.delete(pos);
      else this.outlineCollapsed.add(pos);
      this.updateOutline(view);
    }));
    this.outline.querySelectorAll<HTMLElement>(".outline-item[data-i]").forEach((el) => el.onclick = () => {
      const hs = view.dom.querySelectorAll("h1,h2,h3,h4,h5,h6");
      (hs[+el.dataset.i!] as HTMLElement)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    this.paintOutlineFoot(view, items.length);
    this.highlightOutline(view);
  }

  private paintOutlineFoot(view: EditorView, headings: number) {
    if (!this.outlineFoot) return;
    const doc = view.state.doc;
    const { words } = countWords(doc.textContent);
    const minutes = Math.max(1, Math.round(words / 230));
    this.outlineFoot.innerHTML = `<span>${t("{n} headings", { n: headings })}</span><span class="dot">·</span><span>${wordsLabel(words)}</span><span class="dot">·</span><span>${minutesLabel(minutes)}</span>`;
  }

  expandOutline() {
    this.outlineCollapsed.clear();
    const view = (window as any).mdnest?.editor?.view as EditorView | undefined;
    if (view) this.updateOutline(view);
  }
  collapseOutline() {
    const view = (window as any).mdnest?.editor?.view as EditorView | undefined;
    if (!view) return;
    view.state.doc.descendants((n, pos) => {
      if (n.type.name === "heading") this.outlineCollapsed.add(pos);
      return n.type.name !== "heading" && !n.isTextblock;
    });
    this.updateOutline(view);
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
    const changed = active !== this.caretHeading;
    this.caretHeading = active;
    this.outline.querySelectorAll(".outline-item").forEach((el, i) => el.classList.toggle("outline-item-active", i === active));
    if (changed && this.follow) this.scrollActiveOutline();
  }
  private scrollActiveOutline() {
    if (this.current !== "outline") return;
    this.outline.querySelector<HTMLElement>(".outline-item-active")?.scrollIntoView({ block: "nearest" });
  }

  private targetDir(): string {
    const p = this.selectedPath;
    if (p && this.tree.querySelector(`.file-library-folder[data-path="${cssEscape(p)}"]`)) return p;
    if (p && p !== this.root) return parentOf(p);
    return this.root || "";
  }

  private outlineContext(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, [
      { id: "expand", label: "Expand All", icon: "expandAll" },
      { id: "collapse", label: "Collapse All", icon: "collapseAll" },
    ], (id) => {
      if (id === "expand") this.expandOutline();
      else this.collapseOutline();
    });
  }

  private onContext(e: MouseEvent) {
    const tg = e.target as HTMLElement;
    if (!this.el.contains(tg)) return;
    if (tg.closest("#outline-content")) { this.outlineContext(e); return; }
    if (tg.closest(".mdn-rail, .mdn-panel-head, .mdn-panel-sub, .sb-sec-head")) return;
    if (tg.closest("input, textarea, select")) return;
    if (!tg.closest("#sidebar-files-pane, #file-library-search-result")) return;
    e.preventDefault();
    e.stopPropagation();
    const node = tg.closest<HTMLElement>(".file-library-node, .file-list-item, .typora-search-item");
    this.showNodeMenu(node, e.clientX, e.clientY);
  }

  /** File/folder menu for a tree, list, recent or search row (or the blank area when `node` is null). */
  private showNodeMenu(node: HTMLElement | null, x: number, y: number) {
    const path = node?.dataset.path || null;
    const recent = !!node?.classList.contains("recent-file");
    const isDir = !!node?.classList.contains("file-library-folder") || path === this.root;
    if (path && !recent) { this.selectedPath = path; this.markSelected(); }
    const dir = path ? (isDir ? path : parentOf(path)) : (this.root || "");
    const items: ContextItem[] = [];
    if (path && !isDir) {
      items.push({ id: "open", label: "Open", icon: "open", accel: "Enter" });
      items.push({ id: "open-window", label: "Open in New Window", icon: "window" });
      items.push({ id: "", label: "", sep: true });
    }
    if (!recent) {
      items.push({ id: "new-file", label: "New File", icon: "plusFile" });
      items.push({ id: "new-folder", label: "New Folder", icon: "plusFolder" });
      items.push({ id: "", label: "", sep: true });
    }
    if (path && path !== this.root && !recent) {
      items.push({ id: "rename", label: "Rename", icon: "pencil", accel: "F2" });
      items.push({ id: "duplicate", label: "Duplicate", icon: "duplicate" });
    }
    items.push({ id: "copy", label: "Copy File Path", icon: "link", disabled: !path });
    items.push({ id: "reveal", label: revealLabel(), icon: "reveal", disabled: !path });
    if (path && path !== this.root && !recent) {
      items.push({ id: "", label: "", sep: true });
      items.push({ id: "delete", label: "Delete", icon: "trash", accel: "Del", danger: true });
    }
    items.push({ id: "", label: "", sep: true });
    if (recent) items.push({ id: "clear-recent", label: "Clear Recent Items", icon: "x" });
    else items.push({ id: "refresh", label: "Refresh", icon: "refresh" });
    openContextMenu(x, y, items, (id) => {
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
      else if (id === "clear-recent") void this.actions?.clearRecent?.();
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
    input.addEventListener("click", (e) => e.stopPropagation());
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
      let p = n.parentElement;
      while (p && p !== this.tree) {
        if (p.classList.contains("file-node-children") && !p.parentElement?.classList.contains("file-node-expanded")) return false;
        p = p.parentElement;
      }
      return true;
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

/** Escape a search snippet and wrap the query terms in <mark>. */
export function markHit(snippet: string, q: string): string {
  const safe = escapeHtml(snippet);
  const terms = q.split(/\s+/).filter((w) => w.length >= 1).map((w) => escapeHtml(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return safe;
  return safe.replace(new RegExp(`(${terms.join("|")})`, "gi"), "<mark>$1</mark>");
}

function cssEscape(s: string): string {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}
