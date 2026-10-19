import type { Host } from "./types";
import { browserHost } from "./browser";
import { tauriHost } from "./tauri";
export const host: Host = (window as any).__TAURI_INTERNALS__ ? tauriHost : browserHost;
export type { Host, DirEntry, StreamRequest, StreamEvent, HostSecrets, HostNet } from "./types";
