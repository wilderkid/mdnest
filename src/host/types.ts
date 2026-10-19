// HostAPI: everything the frontend needs from the native side. Implemented by the Tauri host
// (src/host/tauri.ts) and by a dev-only browser host backed by Vite middleware (src/host/browser.ts).
export interface DirEntry { name: string; path: string; isDir: boolean }
export interface ListedFile { path: string; name: string; mtime: number; ctime: number; size: number }
export interface SearchHit { path: string; line: number; snippet: string }
export interface Host {
  kind: "tauri" | "browser";
  pickFile(): Promise<string | null>;
  pickFolder(): Promise<string | null>;
  pickSavePath(defaultName?: string, ext?: "md" | "html" | "pdf"): Promise<string | null>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  listThemes(): Promise<string[]>;
  themeUrl(file: string): string;          // e.g. "drake.css", "base.user.css"
  fileUrl(absPath: string): string;        // for images relative to the open document
  defaultWorkspace(): Promise<string | null>;
  cliFile(): Promise<string | null>;        // file passed on the command line, if any
  cliArgs(): Promise<string[]>;
  writeBinary(path: string, base64: string, unique: boolean): Promise<string>; // returns final path
  copyFile(src: string, dest: string, unique: boolean): Promise<string>; // returns final path
  mtime(path: string): Promise<number | null>;
  exportPdf(html: string, outPath: string): Promise<void>; // throws "unsupported" where no native path exists
  quit(code?: number): Promise<void>;
  /** Create an empty file. Fails if it already exists. */
  createFile(path: string): Promise<void>;
  /** Create a directory. Fails if it already exists. */
  createDir(path: string): Promise<void>;
  /** Rename or move. Fails if the target exists. */
  renamePath(from: string, to: string): Promise<void>;
  /** Copy beside the original as "name copy.ext". Returns the new path. */
  duplicatePath(path: string): Promise<string>;
  /** Recycle Bin / trash (browser host: dev-data/.trash). */
  trashPath(path: string): Promise<void>;
  /** Show the path in the system file manager. */
  revealPath(path: string): Promise<void>;
  /** Open an http(s)/mailto URL or a local file in the system handler. */
  openExternal(url: string): Promise<void>;
  /** Recursive Markdown/txt walk. */
  listFiles(root: string, max?: number): Promise<ListedFile[]>;
  /** First ~240 characters, front matter stripped. */
  fileExcerpt(path: string): Promise<string>;
  /** "file" | "dir" | "other" | "missing". */
  pathKind(path: string): Promise<string>;
  /** Case-insensitive content search. */
  searchFiles(root: string, query: string, max?: number): Promise<SearchHit[]>;
  /** Open another window, optionally on a file. Browser host is a no-op that returns null. */
  openWindow(file?: string | null): Promise<string | null>;
  /** Close the calling window (Tauri). Browser host closes the tab. */
  closeWindow(): Promise<void>;
  /** Window label (`main`, `w-1`) or `"browser"`. */
  windowLabel(): Promise<string>;
  /** Plugin platform: secret storage. Values never come back to the frontend. */
  secrets: HostSecrets;
  /** Plugin platform: streaming HTTP. Secrets are attached in the host, not here. */
  net: HostNet;
  /** Plugin platform: workspace index (SQLite + FTS5 + sqlite-vec in Rust). */
  index: HostIndex;
}

/** Index requests are `{ op, root, ... }`; see src-tauri/src/kb/mod.rs `dispatch`. */
export interface HostIndex {
  call<T = any>(req: { op: string; root: string; [k: string]: any }): Promise<T>;
  /** debounced batches of changed Markdown paths under root; returns stop() */
  watch(root: string, onChange: (paths: string[]) => void): Promise<() => void>;
}

/** `^[a-z0-9._-]{1,64}$` */
export type SecretId = string;

export interface HostSecrets {
  set(id: SecretId, value: string): Promise<void>;
  has(id: SecretId): Promise<boolean>;
  delete(id: SecretId): Promise<void>;
  /** `"keyring"` (OS store) or `"file"` (0600 fallback / in-memory+file in the browser host). */
  backend(): Promise<string>;
}

export interface StreamRequest {
  url: string;
  method: "POST" | "GET";
  headers?: Record<string, string>;
  body?: string;
  /** Stored secret id. The host reads it and sets Authorization (or `auth`). */
  secretRef?: string;
  /** `"bearer"` (default) or `"header:<name>"`. */
  auth?: "bearer" | `header:${string}`;
  timeoutMs?: number;
}

/** Same shapes the Rust `StreamEvent` enum serialises. */
export type StreamEvent =
  | { type: "open"; status: number }
  | { type: "data"; event?: string; data: string }
  | { type: "error"; status?: number; message: string }
  | { type: "done" };

export interface HostNet {
  /**
   * Start a stream. `onEvent` receives each event, including the terminal `done`.
   * The returned `cancel` aborts the in-flight request.
   */
  stream(req: StreamRequest, onEvent: (ev: StreamEvent) => void): { cancel(): void };
}
