import type { Host, DirEntry } from "../host/types";
import type { SidebarPanel } from "../plugins/api";
import { EditorView } from "prosemirror-view";
import { escapeHtml } from "../editor/render";

export class Sidebar {
  el: HTMLElement; tabs: HTMLElement; content: HTMLElement; tree: HTMLElement; outline: HTMLElement;
  root: string | null = null; activeFile: string | null = null;
  private panels = new Map<string, { tab: HTMLElement; body: HTMLElement; panel?: SidebarPanel; cleanup?: any }>();
  constructor(private host: Host, private openFile: (p: string) => void) {
    this.el = document.createElement("div"); this.el.id = "typora-sidebar";
    this.el.innerHTML = `<div class="sidebar-tabs" id="sidebar-tabs"></div><div id="sidebar-content"></div>`;
    this.tabs = this.el.querySelector(".sidebar-tabs")!; this.content = this.el.querySelector("#sidebar-content")!;
    this.tree = this.addTab("files", "Files", "file-library-tree");
    this.tree.classList.add("file-library");
    this.outline = this.addTab("outline", "Outline", "outline-content");
    this.select("files");
  }
  addTab(id: string, title: string, elId?: string, panel?: SidebarPanel) {
    const tab = document.createElement("div"); tab.className = "sidebar-tab"; tab.textContent = title; tab.dataset.id = id;
    tab.onclick = () => this.select(id);
    const body = document.createElement("div"); body.className = "sidebar-content-content"; if (elId) body.id = elId;
    this.tabs.appendChild(tab); this.content.appendChild(body);
    this.panels.set(id, { tab, body, panel });
    return body;
  }
  select(id: string) {
    for (const [k, p] of this.panels) {
      const on = k === id; p.tab.classList.toggle("active", on); p.body.classList.toggle("active", on);
      if (on && p.panel && !p.cleanup) p.cleanup = p.panel.render(p.body) || true;
      if (!on && p.panel && p.cleanup) { if (typeof p.cleanup === "function") p.cleanup(); p.cleanup = undefined; p.body.innerHTML = ""; }
    }
    document.body.classList.toggle("ty-show-outline", id === "outline");
  }
  async openFolder(path: string) {
    this.root = path; this.tree.innerHTML = "";
    const title = document.createElement("div"); title.className = "sidebar-folder-name"; title.textContent = path.split(/[\\/]/).pop() || path;
    this.tree.appendChild(title);
    const ul = document.createElement("div"); this.tree.appendChild(ul);
    await this.renderDir(path, ul);
    this.select("files");
  }
  private async renderDir(path: string, into: HTMLElement) {
    let entries: DirEntry[] = [];
    try { entries = await this.host.listDir(path); } catch (e) { into.textContent = String(e); return; }
    for (const e of entries) {
      if (!e.isDir && !/\.(md|markdown|mdown|txt)$/i.test(e.name)) continue;
      const node = document.createElement("div");
      node.className = "file-library-node file-tree-node" + (e.isDir ? " file-library-folder" : " file-library-file");
      node.dataset.path = e.path;
      node.innerHTML = `<div class="file-node-content"><span class="file-node-icon">${e.isDir ? "▸" : "◦"}</span><span class="file-node-title">${escapeHtml(e.name)}</span></div>`;
      if (e.path === this.activeFile) node.classList.add("active");
      const content = node.firstElementChild as HTMLElement;
      if (e.isDir) {
        const kids = document.createElement("div"); kids.className = "file-node-children"; node.appendChild(kids);
        let loaded = false;
        content.onclick = async () => {
          const exp = node.classList.toggle("file-node-expanded");
          content.querySelector(".file-node-icon")!.textContent = exp ? "▾" : "▸";
          if (exp && !loaded) { loaded = true; await this.renderDir(e.path, kids); }
        };
      } else content.onclick = () => this.openFile(e.path);
      into.appendChild(node);
    }
  }
  markActive(path: string | null) {
    this.activeFile = path;
    this.tree.querySelectorAll(".file-library-node").forEach((n) => n.classList.toggle("active", (n as HTMLElement).dataset.path === path));
  }
  updateOutline(view: EditorView) {
    const items: string[] = []; let i = 0;
    view.state.doc.descendants((n) => {
      if (n.type.name === "heading") items.push(`<div class="outline-item outline-h${n.attrs.level}" data-i="${i++}"><span class="outline-label">${escapeHtml(n.textContent) || "&nbsp;"}</span></div>`);
      return n.type.name !== "heading" && !n.isTextblock;
    });
    this.outline.innerHTML = items.join("") || `<div class="outline-item" style="opacity:.6">No headings</div>`;
    this.outline.querySelectorAll<HTMLElement>(".outline-item[data-i]").forEach((el) => el.onclick = () => {
      const hs = view.dom.querySelectorAll("h1,h2,h3,h4,h5,h6"); (hs[+el.dataset.i!] as HTMLElement)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
}
