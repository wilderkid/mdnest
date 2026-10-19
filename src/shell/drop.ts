// Native drag-drop (Windows WebView2: HTML5 drops carry no paths) and the Linux uri-list path.
// One function so the browser host can unit-test routing with fake paths.
import type { EditorView } from "prosemirror-view";
import type { Host } from "../host/types";
import { insertImageFiles } from "./images";

const MD = /\.(md|markdown|mdown|mkd|mdx|txt|text)$/i;
const IMG = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?)$/i;

export interface NativeDrop {
  paths: string[];
  /** Viewport coordinates from Tauri (`position`), or a client point from an HTML5 drop. */
  position?: { x: number; y: number };
}

export interface DropDeps {
  openFile(path: string): void | Promise<void>;
  openFolder(path: string): void | Promise<void>;
  view: EditorView;
  host: Host;
  docPath: string | null;
  notify(m: string): void;
  /** True when `path` is a directory. Defaults to a trailing slash or a host.listDir probe. */
  isDir?(path: string): Promise<boolean> | boolean;
}

async function looksLikeDir(path: string, host: Host, isDir?: DropDeps["isDir"]): Promise<boolean> {
  if (isDir) return !!(await isDir(path));
  if (/[\\/]$/.test(path)) return true;
  try {
    await host.listDir(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Route a native drop: a folder opens as the workspace, a Markdown/text file opens,
 * images are inserted at `position` (posAtCoords) through the existing path import.
 * Mixed drops: the first folder or Markdown file wins; leftover images still insert.
 */
export async function handleNativeDrop(drop: NativeDrop, deps: DropDeps): Promise<"folder" | "file" | "images" | "none"> {
  const paths = (drop.paths ?? []).map((p) => p.trim()).filter(Boolean);
  if (!paths.length) return "none";
  let folder: string | null = null;
  let file: string | null = null;
  const images: string[] = [];
  for (const p of paths) {
    if (IMG.test(p)) { images.push(p); continue; }
    if (MD.test(p)) { if (!file) file = p; continue; }
    if (await looksLikeDir(p, deps.host, deps.isDir)) { if (!folder) folder = p; }
    else if (MD.test(p) || /\.(md|txt)$/i.test(p)) { if (!file) file = p; }
  }
  if (folder) {
    await deps.openFolder(folder);
    return "folder";
  }
  if (file) {
    await deps.openFile(file);
    return "file";
  }
  if (images.length) {
    let pos: number | null = null;
    if (drop.position && deps.view?.posAtCoords) {
      const hit = deps.view.posAtCoords({ left: drop.position.x, top: drop.position.y });
      pos = hit ? hit.pos : null;
    }
    await insertImageFiles(deps.view, deps.host, deps.docPath, images.map((path) => ({ path })), pos, deps.notify);
    return "images";
  }
  return "none";
}

/** `text/uri-list` (and a plain-text file:// list) → filesystem paths. Used on Linux HTML5 drops. */
export function pathsFromUriList(raw: string): string[] {
  return raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.startsWith("file://"))
    .map((u) => {
      try { return decodeURIComponent(new URL(u).pathname); } catch { return ""; }
    }).filter(Boolean);
}
