import type { Host, DirEntry } from "./types";
import { invoke } from "@tauri-apps/api/core";
// Custom URI schemes registered in src-tauri: "mdtheme" (theme folder) and "mdfile" (local files).
const isWin = navigator.userAgent.includes("Windows");
const scheme = (s: string) => (isWin ? `http://${s}.localhost/` : `${s}://localhost/`);
export const tauriHost: Host = {
  kind: "tauri",
  pickFile: () => invoke<string | null>("pick_file"),
  pickFolder: () => invoke<string | null>("pick_folder"),
  pickSavePath: (defaultName) => invoke<string | null>("pick_save_path", { defaultName: defaultName ?? "untitled.md" }),
  readFile: (path) => invoke<string>("read_text_file", { path }),
  writeFile: (path, text) => invoke<void>("write_text_file", { path, text }),
  listDir: (path) => invoke<DirEntry[]>("list_dir", { path }),
  listThemes: () => invoke<string[]>("list_themes"),
  themeUrl: (file) => scheme("mdtheme") + encodeURIComponent(file).replace(/%2F/g, "/"),
  fileUrl: (abs) => scheme("mdfile") + encodeURI(abs.replace(/^\//, "")),
  defaultWorkspace: () => invoke<string | null>("default_workspace"),
};
