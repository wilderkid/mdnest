// HostAPI: everything the frontend needs from the native side. Implemented by the Tauri host
// (src/host/tauri.ts) and by a dev-only browser host backed by Vite middleware (src/host/browser.ts).
export interface DirEntry { name: string; path: string; isDir: boolean }
export interface Host {
  kind: "tauri" | "browser";
  pickFile(): Promise<string | null>;
  pickFolder(): Promise<string | null>;
  pickSavePath(defaultName?: string): Promise<string | null>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  listThemes(): Promise<string[]>;
  themeUrl(file: string): string;          // e.g. "drake.css", "base.user.css"
  fileUrl(absPath: string): string;        // for images relative to the open document
  defaultWorkspace(): Promise<string | null>;
}
