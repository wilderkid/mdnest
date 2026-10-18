// Plugin API skeleton (Phase 1). Plugins are plain ES modules exporting { manifest, activate }.
import type { EditorState } from "prosemirror-state";
import type { DecorationSet } from "prosemirror-view";

export interface PluginManifest { id: string; name: string; version: string; depends?: Record<string, string>; description?: string }
export interface Command { id: string; title: string; run: () => void | Promise<void>; key?: string }
export interface SidebarPanel { id: string; title: string; render: (el: HTMLElement) => void | (() => void) }
export interface SettingSpec { key: string; title: string; type: "boolean" | "string" | "number"; default: any }
export type DecorationProvider = (state: EditorState) => DecorationSet | null;

export interface PluginContext {
  manifest: PluginManifest;
  commands: { add(c: Command): void; run(id: string): void };
  ui: { registerSidebarPanel(p: SidebarPanel): void; notify(msg: string): void };
  settings: { register(specs: SettingSpec[]): void; get<T = any>(key: string): T; set(key: string, v: any): void };
  editor: { registerDecorations(p: DecorationProvider): void; getMarkdown(): string; getState(): EditorState; refresh(): void };
  events: { on(ev: AppEvent, fn: (...a: any[]) => void): void };
  /** exported API objects of plugins listed in manifest.depends */
  deps: Record<string, any>;
}
export type AppEvent = "doc-changed" | "file-opened" | "file-saved" | "theme-changed" | "settings-changed";

export interface EditorPlugin { manifest: PluginManifest; activate(ctx: PluginContext): any; deactivate?(): void }

/** Hooks the host (shell) must provide to the plugin manager */
export interface PluginHost {
  addCommand(c: Command, owner: string): void;
  runCommand(id: string): void;
  addSidebarPanel(p: SidebarPanel, owner: string): void;
  notify(msg: string): void;
  addDecorations(p: DecorationProvider): void;
  getMarkdown(): string;
  getState(): EditorState;
  refreshDecorations(): void;
  addSettings(owner: string, specs: SettingSpec[]): void;
}

const satisfies = (have: string, want: string) => {
  // supports "^x.y.z", ">=x.y.z", "x.y.z", "*"
  const p = (v: string) => v.replace(/^[^\d]*/, "").split(".").map((x) => +x || 0);
  if (want === "*" || !want) return true;
  const [h, w] = [p(have), p(want)];
  const cmp = h[0] - w[0] || h[1] - w[1] || h[2] - w[2];
  if (want.startsWith("^")) return h[0] === w[0] && cmp >= 0;
  if (want.startsWith(">=")) return cmp >= 0;
  return cmp === 0;
};

export class PluginManager {
  private listeners = new Map<AppEvent, Set<(...a: any[]) => void>>();
  readonly loaded = new Map<string, { plugin: EditorPlugin; exports: any }>();
  readonly errors: { id: string; error: string }[] = [];
  constructor(private host: PluginHost) {}

  emit(ev: AppEvent, ...a: any[]) { this.listeners.get(ev)?.forEach((f) => { try { f(...a); } catch (e) { console.error(e); } }); }

  settingKey = (owner: string, key: string) => `mdnest.plugin.${owner}.${key}`;

  /** topologically sort by depends and activate; missing/incompatible deps disable the dependent */
  activateAll(plugins: EditorPlugin[]) {
    const byId = new Map(plugins.map((p) => [p.manifest.id, p]));
    const order: EditorPlugin[] = []; const state = new Map<string, 1 | 2>();
    const visit = (p: EditorPlugin, chain: string[]): boolean => {
      const id = p.manifest.id;
      if (state.get(id) === 2) return true;
      if (state.get(id) === 1) { this.errors.push({ id, error: "dependency cycle: " + [...chain, id].join(" → ") }); return false; }
      state.set(id, 1);
      for (const [dep, range] of Object.entries(p.manifest.depends ?? {})) {
        const d = byId.get(dep);
        if (!d) { this.errors.push({ id, error: `missing dependency ${dep}` }); return false; }
        if (!satisfies(d.manifest.version, range)) { this.errors.push({ id, error: `${dep}@${d.manifest.version} does not satisfy ${range}` }); return false; }
        if (!visit(d, [...chain, id])) { this.errors.push({ id, error: `dependency ${dep} failed` }); return false; }
      }
      state.set(id, 2); order.push(p); return true;
    };
    plugins.forEach((p) => visit(p, []));
    for (const p of order) {
      if (this.loaded.has(p.manifest.id)) continue;
      try {
        const exports = p.activate(this.context(p));
        this.loaded.set(p.manifest.id, { plugin: p, exports });
      } catch (e: any) { this.errors.push({ id: p.manifest.id, error: String(e?.message ?? e) }); }
    }
    this.errors.forEach((e) => console.warn(`[plugin ${e.id}]`, e.error));
  }

  private context(p: EditorPlugin): PluginContext {
    const id = p.manifest.id, h = this.host;
    const deps: Record<string, any> = {};
    for (const dep of Object.keys(p.manifest.depends ?? {})) deps[dep] = this.loaded.get(dep)?.exports;
    return {
      manifest: p.manifest, deps,
      commands: { add: (c) => h.addCommand({ ...c, id: c.id.includes(".") ? c.id : `${id}.${c.id}` }, id), run: (cid) => h.runCommand(cid) },
      ui: { registerSidebarPanel: (panel) => h.addSidebarPanel(panel, id), notify: (m) => h.notify(m) },
      settings: {
        register: (specs) => h.addSettings(id, specs.map((s) => ({ ...s }))),
        get: (key) => { const raw = localStorage.getItem(this.settingKey(id, key)); return raw == null ? undefined as any : JSON.parse(raw); },
        set: (key, v) => { localStorage.setItem(this.settingKey(id, key), JSON.stringify(v)); this.emit("settings-changed", id, key, v); },
      },
      editor: { registerDecorations: (f) => h.addDecorations(f), getMarkdown: () => h.getMarkdown(), getState: () => h.getState(), refresh: () => h.refreshDecorations() },
      events: { on: (ev, fn) => { if (!this.listeners.has(ev)) this.listeners.set(ev, new Set()); this.listeners.get(ev)!.add(fn); } },
    };
  }
}
