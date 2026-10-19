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

export function imageFiles(list: FileList | null | undefined): File[] {
  return list ? [...list].filter((f) => f.type.startsWith("image/")) : [];
}

/** saves files and inserts image nodes at `pos` (or the selection). Returns false if not handled. */
export async function insertImageFiles(view: EditorView, host: Host, docPath: string | null, files: File[], pos: number | null, notify: (m: string) => void) {
  if (!files.length) return false;
  if (!docPath) { notify("Save the document first — images are copied next to it."); return true; }
  const dir = docPath.replace(/[\\/][^\\/]*$/, ""), stem = docPath.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const rel = imageFolderPattern().replace(/\$\{filename\}/g, stem).replace(/\\/g, "/").replace(/\/+$/, "");
  const relClean = rel.replace(/^\.\//, "");
  const nodes: PMNode[] = [];
  for (const f of files) {
    const ext = EXT[f.type] ?? (f.name.split(".").pop() || "png");
    const base = f.name && !/^image\.(png|jpe?g)$/i.test(f.name) ? sanitize(f.name.replace(/\.[^.]+$/, "")) : `image-${stamp()}`;
    const target = `${dir}/${relClean}/${base}.${ext}`;
    try {
      const final = await host.writeBinary(target, toBase64(await f.arrayBuffer()), true);
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
