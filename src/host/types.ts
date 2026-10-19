// HostAPI: everything the frontend needs from the native side. Implemented by the Tauri host
// (src/host/tauri.ts) and by a dev-only browser host backed by Vite middleware (src/host/browser.ts).
export interface DirEntry { name: string; path: string; isDir: boolean }
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
  /** Plugin platform: secret storage. Values never come back to the frontend. */
  secrets: HostSecrets;
  /** Plugin platform: streaming HTTP. Secrets are attached in the host, not here. */
  net: HostNet;
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
