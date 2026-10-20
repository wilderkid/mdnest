// Image toolbar (0.2.2): shown above a selected image. Zoom presets, custom width, original size,
// left/center/right alignment, and a corner handle to resize by dragging (saved as Typora's zoom:N%).
import { NodeSelection, Plugin, PluginKey } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { icon } from "../shell/icons";
import { openContextMenu } from "../shell/sidebar";
import { t } from "../i18n";
import { ZOOM_PRESETS } from "./imagestyle";
import { resetImageSize, setImageAlign, setImageWidth, setImageZoom } from "./editops";
import { openPrompt } from "./prompt";

/** Ask for a custom width in pixels for the selected image. */
export async function promptImageWidth(view: EditorView): Promise<void> {
  const sel = view.state.selection;
  if (!(sel instanceof NodeSelection) || sel.node.type.name !== "image") return;
  const img = view.nodeDOM(sel.from) as HTMLElement | null;
  const cur = sel.node.attrs.width || String(Math.round(img?.querySelector("img")?.getBoundingClientRect().width ?? 0) || "");
  const pos = sel.from;
  const v = await openPrompt(view, { placeholder: t("Width in pixels, e.g. 320"), value: cur, anchor: pos });
  if (v == null) return;
  const n = parseInt(v.replace(/px$/i, ""), 10);
  if (!(n > 0)) return;
  const now = view.state.doc.nodeAt(pos);
  if (!now || now.type.name !== "image") return;
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
  setImageWidth(n)(view.state, view.dispatch);
  view.focus();
}

export function zoomMenuItems(current: number | null) {
  return [
    ...ZOOM_PRESETS.map((z) => ({ id: "zoom:" + z, label: z + "%", checked: (current ?? 100) === z })),
    { id: "-", label: "", sep: true },
    { id: "width", label: "Custom Width…", icon: "width" },
    { id: "reset", label: "Original Size", icon: "actualSize" },
  ];
}

class ImageToolbar {
  bar: HTMLDivElement;
  grip: HTMLDivElement;
  tip: HTMLDivElement;
  pos = -1;
  dragging = false;
  constructor(private view: EditorView) {
    this.bar = document.createElement("div");
    this.bar.className = "mdn-imgbar";
    this.bar.setAttribute("role", "toolbar");
    this.bar.setAttribute("aria-label", t("Image"));
    this.bar.hidden = true;
    const b = (a: string, title: string, ic: string, extra = "") => `<button type="button" data-a="${a}" title="${t(title)}" aria-label="${t(title)}"${extra}>${ic}</button>`;
    this.bar.innerHTML = `<button type="button" data-a="zoom" class="mdn-imgbar-zoom" title="${t("Zoom")}" aria-haspopup="menu">${icon("zoomIn", 15)}<span class="z">100%</span>${icon("chevronDown", 12, 2)}</button>
      <span class="mdn-imgbar-sep"></span>
      ${b("left", "Align Left", icon("alignLeft", 16))}${b("center", "Align Center", icon("alignCenter", 16))}${b("right", "Align Right", icon("alignRight", 16))}
      <span class="mdn-imgbar-sep"></span>
      ${b("width", "Custom Width…", icon("width", 16))}${b("reset", "Original Size", icon("actualSize", 16))}`;
    document.body.appendChild(this.bar);
    this.grip = document.createElement("div");
    this.grip.className = "mdn-img-resize";
    this.grip.title = t("Drag to resize");
    this.grip.hidden = true;
    document.body.appendChild(this.grip);
    this.tip = document.createElement("div");
    this.tip.className = "mdn-img-size-tip";
    this.tip.hidden = true;
    document.body.appendChild(this.tip);
    // keep the editor focused (and the image selected) while using the toolbar
    this.bar.addEventListener("mousedown", (e) => e.preventDefault());
    this.bar.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-a]");
      if (!btn) return;
      this.act(btn.dataset.a!, btn);
    });
    this.grip.addEventListener("pointerdown", this.startDrag);
    window.addEventListener("scroll", this.reposition, true);
    window.addEventListener("resize", this.reposition);
    view.dom.addEventListener("load", this.reposition, true);
    this.update();
  }
  node() { const n = this.pos >= 0 ? this.view.state.doc.nodeAt(this.pos) : null; return n && n.type.name === "image" ? n : null; }
  img(): HTMLImageElement | null {
    const d = this.pos >= 0 ? this.view.nodeDOM(this.pos) as HTMLElement | null : null;
    return d ? (d.tagName === "IMG" ? d as HTMLImageElement : d.querySelector("img")) : null;
  }
  run(cmd: (s: any, d: any) => boolean) { this.view.focus(); cmd(this.view.state, this.view.dispatch); this.view.focus(); }
  act(a: string, btn?: HTMLElement) {
    const node = this.node(); if (!node) return;
    if (a === "zoom") {
      const r = (btn ?? this.bar).getBoundingClientRect();
      const cur = node.attrs.width ? null : node.attrs.zoom ? +node.attrs.zoom : 100;
      openContextMenu(r.left, r.bottom + 4, zoomMenuItems(cur), (id) => {
        this.view.focus();
        if (id.startsWith("zoom:")) this.run(setImageZoom(+id.slice(5)));
        else if (id === "width") void promptImageWidth(this.view);
        else if (id === "reset") this.run(resetImageSize());
      });
      return;
    }
    if (a === "left" || a === "center" || a === "right") this.run(setImageAlign(node.attrs.align === a ? null : a));
    else if (a === "width") void promptImageWidth(this.view);
    else if (a === "reset") this.run(resetImageSize());
  }
  startDrag = (e: PointerEvent) => {
    const node = this.node(); const img = this.img();
    if (!node || !img) return;
    e.preventDefault(); e.stopPropagation();
    this.grip.setPointerCapture(e.pointerId);
    this.dragging = true;
    const startX = e.clientX, startW = img.getBoundingClientRect().width || 1;
    const px = !!node.attrs.width;
    const startZoom = node.attrs.zoom ? +node.attrs.zoom : 100;
    const startPx = px ? +node.attrs.width : 0;
    const flip = node.attrs.align === "right" ? -1 : 1; // a right-aligned image grows to the left
    let ratio = 1;
    const move = (ev: PointerEvent) => {
      ratio = Math.max(24, startW + (ev.clientX - startX) * flip * (node.attrs.align === "center" ? 2 : 1)) / startW;
      if (px) img.setAttribute("width", String(Math.round(startPx * ratio)));
      else img.style.zoom = (startZoom * ratio) + "%";
      this.tip.textContent = px ? Math.round(startPx * ratio) + " px" : Math.round(startZoom * ratio) + "%";
      this.tip.hidden = false;
      this.reposition();
    };
    const up = () => {
      this.grip.removeEventListener("pointermove", move);
      this.grip.removeEventListener("pointerup", up);
      this.grip.removeEventListener("pointercancel", up);
      this.dragging = false;
      this.tip.hidden = true;
      if (Math.abs(ratio - 1) < 0.01) { this.reposition(); return; }
      if (px) this.run(setImageWidth(Math.round(startPx * ratio)));
      else this.run(setImageZoom(Math.round(startZoom * ratio)));
    };
    this.grip.addEventListener("pointermove", move);
    this.grip.addEventListener("pointerup", up);
    this.grip.addEventListener("pointercancel", up);
  };
  update() {
    if (this.dragging) return;
    const sel = this.view.state.selection;
    const on = this.view.editable && sel instanceof NodeSelection && sel.node.type.name === "image";
    this.pos = on ? sel.from : -1;
    if (!on) { this.bar.hidden = true; this.grip.hidden = true; return; }
    const node = this.node()!;
    this.bar.querySelector(".z")!.textContent = node.attrs.width ? node.attrs.width + "px" : (node.attrs.zoom || "100") + "%";
    for (const a of ["left", "center", "right"]) this.bar.querySelector(`[data-a=${a}]`)!.classList.toggle("on", node.attrs.align === a);
    this.bar.querySelector("[data-a=reset]")!.toggleAttribute("disabled", !node.attrs.zoom && !node.attrs.width);
    this.bar.hidden = false;
    this.grip.hidden = false;
    this.reposition();
  }
  reposition = () => {
    if (this.bar.hidden) return;
    const img = this.img();
    if (!img || !img.isConnected) { this.bar.hidden = true; this.grip.hidden = true; return; }
    const r = img.getBoundingClientRect();
    const host = (this.view.dom.closest("content") ?? this.view.dom).getBoundingClientRect();
    const bw = this.bar.offsetWidth || 260, bh = this.bar.offsetHeight || 34;
    // above the image and the source line Typora-style selection shows before it
    const srcEl = img.closest("p, li, td, th")?.querySelector<HTMLElement>(".md-image-src-span");
    const above = srcEl ? Math.min(r.top, srcEl.getBoundingClientRect().top) : r.top;
    let top = above - bh - 6;
    if (top < host.top + 4) top = r.bottom + 8;
    const left = Math.min(Math.max(host.left + 4, r.left), window.innerWidth - bw - 8);
    this.bar.style.top = Math.round(top) + "px";
    this.bar.style.left = Math.round(left) + "px";
    const hidden = r.bottom < host.top || r.top > host.bottom;
    this.bar.style.visibility = hidden ? "hidden" : "";
    const gx = this.node()?.attrs.align === "right" ? r.left - 6 : r.right - 6;
    this.grip.style.left = Math.round(gx) + "px";
    this.grip.style.top = Math.round(r.bottom - 6) + "px";
    this.grip.style.visibility = hidden ? "hidden" : "";
    this.grip.classList.toggle("left", this.node()?.attrs.align === "right");
    this.tip.style.left = Math.round(r.left + r.width / 2 - 24) + "px";
    this.tip.style.top = Math.round(r.top + r.height / 2 - 12) + "px";
  };
  destroy() {
    this.bar.remove(); this.grip.remove(); this.tip.remove();
    window.removeEventListener("scroll", this.reposition, true);
    window.removeEventListener("resize", this.reposition);
    this.view.dom.removeEventListener("load", this.reposition, true);
  }
}

export function imageToolsPlugin() {
  return new Plugin({ key: new PluginKey("mdn-image-tools"), view: (v) => new ImageToolbar(v) });
}
