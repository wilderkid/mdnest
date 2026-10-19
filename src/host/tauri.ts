import type { Host, DirEntry } from "./types";
import { invoke } from "@tauri-apps/api/core";
// Custom URI schemes registered in src-tauri: "mdtheme" (theme folder) and "mdfile" (local files).
const isWin = navigator.userAgent.includes("Windows");
const scheme = (s: string) => (isWin ? `http://${s}.localhost/` : `${s}://localhost/`);
export const tauriHost: Host = {
  kind: "tauri",
  pickFile: () => invoke<string | null>("pick_file"),
  pickFolder: () => invoke<string | null>("pick_folder"),
  pickSavePath: (defaultName, ext) => invoke<string | null>("pick_save_path", { defaultName: defaultName ?? "untitled.md", ext: ext ?? "md" }),
  readFile: (path) => invoke<string>("read_text_file", { path }),
  writeFile: (path, text) => invoke<void>("write_text_file", { path, text }),
  listDir: (path) => invoke<DirEntry[]>("list_dir", { path }),
  listThemes: () => invoke<string[]>("list_themes"),
  themeUrl: (file) => scheme("mdtheme") + encodeURIComponent(file).replace(/%2F/g, "/"),
  fileUrl: (abs) => scheme("mdfile") + encodeURI(abs.replace(/^\//, "")),
  defaultWorkspace: () => invoke<string | null>("default_workspace"),
  cliFile: () => invoke<string | null>("cli_file"),
  cliArgs: () => invoke<string[]>("cli_args"),
  writeBinary: (path, data, unique) => invoke<string>("write_binary_file", { path, data, unique }),
  copyFile: (src, dest, unique) => invoke<string>("copy_file", { src, dest, unique }),
  mtime: (path) => invoke<number | null>("file_mtime", { path }),
  exportPdf: (html, out) => invoke<void>("export_pdf", { html, out }),
  quit: (code = 0) => invoke<void>("quit_app", { code }),
};
