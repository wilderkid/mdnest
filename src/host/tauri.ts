import type { Host, DirEntry, ListedFile, SearchHit, StreamEvent, StreamRequest, FilePreview } from "./types";
import { invoke, Channel } from "@tauri-apps/api/core";
import { fileUrlPath } from "./fileurl";
// Custom URI schemes registered in src-tauri: "mdtheme" (theme folder) and "mdfile" (local files).
const isWin = navigator.userAgent.includes("Windows");
const scheme = (s: string) => (isWin ? `http://${s}.localhost/` : `${s}://localhost/`);
export const tauriHost: Host = {
  kind: "tauri",
  pickFile: (kind, label) => invoke<string | null>("pick_file", { kind: kind ?? null, label: label ?? null }),
  pickFolder: () => invoke<string | null>("pick_folder"),
  pickSavePath: (defaultName, ext) => invoke<string | null>("pick_save_path", { defaultName: defaultName ?? "untitled.md", ext: ext ?? "md" }),
  readFile: (path) => invoke<string>("read_text_file", { path }),
  writeFile: (path, text) => invoke<void>("write_text_file", { path, text }),
  readFileBytes: (path) => invoke<string>("read_file_bytes", { path }),
  writeFileBytes: (path, data) => invoke<void>("write_file_bytes", { path, data }),
  listDir: (path) => invoke<DirEntry[]>("list_dir", { path }),
  listThemes: () => invoke<string[]>("list_themes"),
  themeUrl: (file) => scheme("mdtheme") + encodeURIComponent(file).replace(/%2F/g, "/"),
  // Forward slashes, every segment percent-encoded. A Windows path `C:\Users\x\a.png` becomes
  // `http://mdfile.localhost/C:/Users/x/a.png` (WebView2 serves custom schemes as http://<scheme>.localhost/).
  fileUrl: (abs) => scheme("mdfile") + fileUrlPath(abs),
  defaultWorkspace: () => invoke<string | null>("default_workspace"),
  cliFile: () => invoke<string | null>("cli_file"),
  cliArgs: () => invoke<string[]>("cli_args"),
  writeBinary: (path, data, unique) => invoke<string>("write_binary_file", { path, data, unique }),
  copyFile: (src, dest, unique) => invoke<string>("copy_file", { src, dest, unique }),
  mtime: (path) => invoke<number | null>("file_mtime", { path }),
  exportPdf: (html, out) => invoke<void>("export_pdf", { html, out }),
  quit: (code = 0) => invoke<void>("quit_app", { code }),
  createFile: (path) => invoke<void>("create_file", { path }),
  createDir: (path) => invoke<void>("create_dir", { path }),
  renamePath: (from, to) => invoke<void>("rename_path", { from, to }),
  duplicatePath: (path) => invoke<string>("duplicate_path", { path }),
  trashPath: (path) => invoke<void>("trash_path", { path }),
  revealPath: (path) => invoke<void>("reveal_path", { path }),
  openExternal: (url) => invoke<void>("open_external", { url }),
  pandocInfo: () => invoke<{ found: boolean; version: string; path: string }>("pandoc_info"),
  pandocExport: (markdown, to, out, cwd) => invoke<void>("pandoc_export", { markdown, to, out, cwd: cwd ?? null }),
  setSpellcheck: (enabled) => invoke<void>("set_spellcheck", { enabled }),
  listFiles: (root, max) => invoke<ListedFile[]>("list_files", { root, max: max ?? 5000 }),
  fileExcerpt: (path) => invoke<string>("file_excerpt", { path }),
  recentPreviews: (paths) => invoke<FilePreview[]>("recent_previews", { paths }),
  pathKind: (path) => invoke<string>("path_kind", { path }),
  searchFiles: (root, query, max) => invoke<SearchHit[]>("search_files", { root, query, max: max ?? 80 }),
  openWindow: (file) => invoke<string>("open_window", { file: file ?? null }),
  closeWindow: () => invoke<void>("close_window"),
  windowLabel: () => invoke<string>("window_label"),
  secrets: {
    set: (id, value) => invoke<void>("secret_set", { id, value }),
    has: (id) => invoke<boolean>("secret_has", { id }),
    delete: (id) => invoke<void>("secret_delete", { id }),
    backend: () => invoke<string>("secret_backend"),
  },
  index: {
    call: (req) => invoke("kb_call", { req }),
    async watch(root, onChange) {
      const id = "w" + Math.random().toString(36).slice(2);
      const ch = new Channel<string[]>();
      ch.onmessage = (paths) => onChange(paths);
      await invoke("kb_watch", { id, root, onChange: ch });
      return () => { void invoke("kb_unwatch", { id }); };
    },
  },
  async watchFs(root, onChange) {
    await this.unwatchFs();
    const id = "fs" + Math.random().toString(36).slice(2);
    fsWatchId = id;
    const ch = new Channel<string[]>();
    ch.onmessage = (paths) => onChange(paths);
    try {
      await invoke("fs_watch", { id, root, onChange: ch });
      return true;
    } catch {
      fsWatchId = null;
      return false;
    }
  },
  async unwatchFs() {
    const id = fsWatchId;
    fsWatchId = null;
    if (id) { try { await invoke("fs_unwatch", { id }); } catch { /* gone */ } }
  },
  net: {
    stream(req: StreamRequest, onEvent: (ev: StreamEvent) => void) {
      const id = streamId();
      const channel = new Channel<StreamEvent>();
      channel.onmessage = (ev) => { try { onEvent(ev); } catch { /* plugin handler */ } };
      const started = invoke<void>("net_stream", {
        id,
        req: {
          url: req.url,
          method: req.method,
          headers: req.headers ?? {},
          body: req.body ?? null,
          secretRef: req.secretRef ?? null,
          auth: req.auth ?? null,
          timeoutMs: req.timeoutMs ?? null,
        },
        onEvent: channel,
      });
      let cancelled = false;
      started.catch((e) => {
        if (cancelled) return;
        onEvent({ type: "error", message: String((e as any)?.message ?? e) });
        onEvent({ type: "done" });
      });
      return {
        cancel() {
          if (cancelled) return;
          cancelled = true;
          void invoke<boolean>("net_cancel", { id });
        },
      };
    },
  },
};

let fsWatchId: string | null = null;

function streamId(): string {
  const rnd = Math.random().toString(36).slice(2, 10);
  return `s${Date.now().toString(36)}${rnd}`;
}
