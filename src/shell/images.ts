// Image paste / drop: copy into an assets folder next to the document and insert a relative path.
// Folder pattern (Typora-like), stored in localStorage "mdnest.imageFolder":
//   "./assets" (default) | "./${filename}.assets" | any relative path; ${filename} = document stem.
import { EditorView } from "prosemirror-view";
import type { Host } from "../host/types";
import { schema } from "../editor/schema";
import type { Node as PMNode } from "prosemirror-model";

export const IMAGE_FOLDER_KEY = "mdnest.imageFolder";
export const imageFolderPattern = () => localStorage.getItem(IMAGE_FOLDER_KEY) || "./assets";

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/bmp": "bmp", "image/avif": "avif" };
const sanitize = (n: string) => n.replace(/[\\/:*?"<>|#%\s]+/g, "-").replace(/^-+|-+$/g, "") || "image";
function toBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf); let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const stamp = () => { const d = new Date(), p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };

const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?)$/i;
/** an image to import: clipboard/dropped bytes, or a local file path (native drops from file managers) */
export type ImageItem = File | { path: string };

/**
 * Images carried by a paste/drop. WebKitGTK does not always expose dropped files as `files` (a drag
 * from a GTK file manager arrives as `text/uri-list` only, and the default action would insert the URI
 * as text), and it may leave `File.type` empty — so accept image extensions and file:// URIs too.
 */
export function collectImages(dt: DataTransfer | null | undefined): ImageItem[] {
  if (!dt) return [];
  const all = [...(dt.files ?? [])];
  if (!all.length) for (const it of [...(dt.items ?? [])]) if (it.kind === "file") { const f = it.getAsFile(); if (f) all.push(f); }
  const files = all.filter((f) => f.type.startsWith("image/") || (!f.type && IMG_EXT.test(f.name)));
  if (files.length) return files;
  let raw = dt.getData("text/uri-list") || dt.getData("x-special/gnome-copied-files") || "";
  // WebKitGTK hands a GTK uri-list drag to the page as text/plain only
  const plain = dt.getData("text/plain") || "";
  if (!raw && plain.trim() && plain.trim().split(/\r?\n/).every((l) => l.trim().startsWith("file://"))) raw = plain;
  // …and keeps text/uri-list unreadable during drop, while text/html carries <a href="file://…">
  if (!raw) {
    const html = dt.getData("text/html") || "";
    if (/file:\/\//i.test(html)) {
      const d = new DOMParser().parseFromString(html, "text/html");
      // WebKitGTK renders the dragged URI as <a>file:///…</a> (no href)
      raw = [...d.querySelectorAll("a, img[src]")].map((e) => e.getAttribute("href") ?? e.getAttribute("src") ?? e.textContent ?? "")
        .map((u) => u.trim()).filter((u) => /^file:\/\//i.test(u)).join("\n");
    }
  }
  const list = raw.split(/\r?\n/);
  const paths = list.map((l) => l.trim()).filter((l) => l.startsWith("file://"))
    .map((u) => { try { return decodeURIComponent(new URL(u).pathname); } catch { return ""; } })
    .filter((p) => p && IMG_EXT.test(p));
  return paths.map((path) => ({ path }));
}

/**
 * WebKitGTK pastes a clipboard image as HTML (`<img src="blob:…">`) without exposing a File. If the
 * pasted HTML is nothing but images with blob:/data: sources, fetch their bytes into Files.
 */
export async function imagesFromPastedHtml(html: string): Promise<File[]> {
  if (!html || !/<img/i.test(html)) return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  const imgs = [...doc.querySelectorAll("img")];
  if (!imgs.length || (doc.body.textContent || "").trim()) return [];
  const out: File[] = [];
  for (const img of imgs) {
    const src = img.getAttribute("src") || "";
    if (!/^(blob|data):/i.test(src)) return [];
    try {
      const b = await (await fetch(src)).blob();
      const type = b.type && b.type.startsWith("image/") ? b.type : "image/png";
      out.push(new File([b], "image." + (EXT[type] ?? "png"), { type }));
    } catch { return []; }
  }
  return out;
}
export const pastedHtmlIsOnlyImages = (html: string) => {
  if (!html || !/<img/i.test(html)) return false;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const imgs = [...doc.querySelectorAll("img")];
  return imgs.length > 0 && !(doc.body.textContent || "").trim() && imgs.every((i) => /^(blob|data):/i.test(i.getAttribute("src") || ""));
};

/** saves files and inserts image nodes at `pos` (or the selection). Returns false if not handled. */
export async function insertImageFiles(view: EditorView, host: Host, docPath: string | null, files: ImageItem[], pos: number | null, notify: (m: string) => void) {
  if (!files.length) return false;
  if (!docPath) { notify("Save the document first — images are copied next to it."); return true; }
  const dir = docPath.replace(/[\\/][^\\/]*$/, ""), stem = docPath.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const rel = imageFolderPattern().replace(/\$\{filename\}/g, stem).replace(/\\/g, "/").replace(/\/+$/, "");
  const relClean = rel.replace(/^\.\//, "");
  const nodes: PMNode[] = [];
  for (const f of files) {
    const fname = f instanceof File ? f.name : f.path.replace(/^.*[\\/]/, "");
    const ext = (f instanceof File ? EXT[f.type] : undefined) ?? (fname.includes(".") ? fname.split(".").pop()!.toLowerCase() : "png");
    const base = fname && !/^image\.(png|jpe?g)$/i.test(fname) ? sanitize(fname.replace(/\.[^.]+$/, "")) : `image-${stamp()}`;
    const target = `${dir}/${relClean}/${base}.${ext}`;
    try {
      const final = f instanceof File
        ? await host.writeBinary(target, toBase64(await f.arrayBuffer()), true)
        : await host.copyFile(f.path, target, true);
      const name = final.replace(/^.*[\\/]/, "");
      const src = (relClean ? relClean + "/" : "") + name;
      nodes.push(schema.nodes.image.create({ src: src.split("/").map(encodeURIComponent).join("/"), alt: base }));
    } catch (e: any) { notify("Image save failed: " + (e.message ?? e)); }
  }
  if (!nodes.length) return true;
  let tr = view.state.tr;
  const at = pos ?? tr.selection.from;
  // images are inline: insert into a paragraph at `at` (create one if the position is between blocks)
  const $at = tr.doc.resolve(at);
  if ($at.parent.inlineContent) tr = tr.insert(at, nodes);
  else tr = tr.insert(at, schema.nodes.paragraph.create(null, nodes));
  view.dispatch(tr.scrollIntoView()); view.focus();
  notify(`Inserted ${nodes.length} image${nodes.length > 1 ? "s" : ""} → ${relClean || "."}/`);
  return true;
}
