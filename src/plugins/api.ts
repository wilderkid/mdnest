// Plugin API. Plugins are plain ES modules exporting { manifest, activate }.
import type { EditorState } from "prosemirror-state";
import type { EditorView, DecorationSet } from "prosemirror-view";
import type { Host, StreamEvent, StreamRequest } from "../host/types";
import { selectionMarkdown, contextMarkdown, sliceForInsert } from "../editor/insertmd";
import {
  addSuggestion, beginRecord, cancelAll, patchSuggestion, suggestKey, type SugRecord, type SugResult,
} from "../editor/suggest";
import { registerSlashItem, type SlashItem } from "../editor/slash";
import { openPrompt } from "../editor/prompt";

export type EditorPerm = "read" | "suggest" | "write";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  depends?: Record<string, string>;
  description?: string;
  /** Capability grants. Absent means the matching API throws when called. */
  permissions?: { net?: string[]; secrets?: boolean; editor?: EditorPerm[]; index?: boolean; workspace?: ("read" | "open")[] };
  /** Service names this plugin provides (see ctx.services.provide). */
  provides?: string[];
  /** Service names this plugin requires. A missing one disables the plugin. */
  consumes?: string[];
}

export interface Command {
  id: string;
  title: string;
  run: () => void | Promise<void>;
  /** prosemirror-keymap name, e.g. "Mod-k". Bound in the editor keymap and shown in the palette. */
  key?: string;
  /** Hide from the palette and skip the hotkey when this returns false. */
  when?: () => boolean;
}

export interface SidebarPanel { id: string; title: string; render: (el: HTMLElement) => void | (() => void) }

export interface SettingOption { value: string; label: string }

export interface SettingSpec {
  key: string;
  title: string;
  type: "boolean" | "string" | "number" | "select" | "secret" | "text" | "url" | "note";
  default?: any;
  /** For type "select". */
  options?: SettingOption[];
  /** Static text for type "note". Rendered HTML-escaped. */
  text?: string;
  /** Hide the control when this returns false. */
  when?: () => boolean;
}

export type DecorationProvider = (state: EditorState) => DecorationSet | null;
export type AppEvent = "doc-changed" | "file-opened" | "file-saved" | "theme-changed" | "settings-changed" | "workspace-changed";

export interface SlashRunCtx { from: number; to: number; query: string }
export interface SlashSpec { id: string; title: string; hint?: string; run: (ctx: SlashRunCtx) => void }

export interface SuggestionHandle {
  id: string;
  append(text: string): void;
  setText(text: string): void;
  finish(): void;
  fail(msg: string): void;
  cancel(): void;
  onSettled(cb: (result: SugResult) => void): void;
}

export interface PluginContext {
  manifest: PluginManifest;
  commands: { add(c: Command): void; run(id: string): void };
  ui: {
    registerSidebarPanel(p: SidebarPanel): void;
    notify(msg: string): void;
    revealPanel(id: string): void;
    prompt(opts: { placeholder?: string; anchor?: number; value?: string }): Promise<string | null>;
  };
  settings: { register(specs: SettingSpec[]): void; get<T = any>(key: string): T; set(key: string, v: any): void };
  editor: {
    registerDecorations(p: DecorationProvider): void;
    getMarkdown(): string;
    getState(): EditorState;
    refresh(): void;
    getSelection(): { from: number; to: number; empty: boolean };
    getSelectionMarkdown(): string;
    getDocMarkdown(): string;
    /** Absolute path of the open document, or null when untitled. Requires editor "read". */
    getFilePath(): string | null;
    getContext(opts: { before: number; after: number }): string;
    insertMarkdown(md: string, at?: "cursor" | { from: number; to: number }): void;
    beginSuggestion(spec: {
      range?: { from: number; to: number };
      mode: "replace" | "insert";
      onRetry?: () => void;
      label?: string;
    }): SuggestionHandle;
    registerSlashItem(item: SlashSpec): void;
  };
  events: { on(ev: AppEvent, fn: (...a: any[]) => void): void };
  /**
   * Reject a settings-panel write before it is stored. Return false to keep the previous value
   * (the control reverts). Used for a confirmation on the first enable.
   */
  guardSetting(fn: (key: string, value: any) => boolean): void;
  /** exported API objects of plugins listed in manifest.depends */
  deps: Record<string, any>;
  services: { provide(name: string, impl: unknown): void; require(name: string): unknown };
  /** Streaming HTTP. Requires manifest.permissions.net. Origins must match that list or a url setting. */
  net: { stream(req: StreamRequest, onEvent: (ev: StreamEvent) => void): { cancel(): void } };
  /** Presence checks only. Values are never returned. Requires permissions.secrets. */
  secrets: { has(key: string): Promise<boolean>; backend(): Promise<string> };
  /** Open folder. Requires permissions.workspace. */
  workspace: {
    root(): string | null;
    /** Open a file and reveal the block at a 1-based source line (citation jump). Requires "open". */
    openAt(path: string, line?: number): Promise<void>;
  };
  /**
   * Workspace index (Rust: SQLite + FTS5 + sqlite-vec) for the open folder. Requires permissions.index.
   * ops: scan {exclude, paths?}, pending {limit}, putVectors {model, items:[[id, vec]]},
   * search {query, vector?, k?, pathPrefix?}, related {path, k?}, stats, model, clear.
   */
  index: {
    call<T = any>(op: string, args?: Record<string, any>): Promise<T>;
    watch(onChange: (paths: string[]) => void): Promise<() => void>;
  };
}

export interface EditorPlugin { manifest: PluginManifest; activate(ctx: PluginContext): any; deactivate?(): void }

export interface PluginHost {
  addCommand(c: Command, owner: string): void;
  runCommand(id: string): void;
  addSidebarPanel(p: SidebarPanel, owner: string): void;
  notify(msg: string): void;
  revealPanel(id: string): void;
  prompt(opts: { placeholder?: string; anchor?: number; value?: string }): Promise<string | null>;
  addDecorations(p: DecorationProvider): void;
  getMarkdown(): string;
  getState(): EditorState;
  getView(): EditorView;
  /** Absolute path of the open document, or null when untitled. */
  getFilePath(): string | null;
  getWorkspaceRoot(): string | null;
  openAt(path: string, line?: number): Promise<void>;
  refreshDecorations(): void;
  addSettings(owner: string, specs: SettingSpec[]): void;
  /** Current value of a plugin setting, or undefined when unset. */
  getSetting(owner: string, key: string): any;
  /**
   * Persist a setting and emit `settings-changed`. Returns false when a plugin listener rejected it
   * (the control should revert). Used so a plugin can confirm before a toggle sticks.
   */
  commitSetting(owner: string, key: string, value: any): boolean;
  /** Specs registered so far for `owner` (used to allow user-configured url origins). */
  settingsFor(owner: string): SettingSpec[];
  host: Host;
}

const satisfies = (have: string, want: string) => {
  const p = (v: string) => v.replace(/^[^\d]*/, "").split(".").map((x) => +x || 0);
  if (want === "*" || !want) return true;
  const [h, w] = [p(have), p(want)];
  const cmp = h[0] - w[0] || h[1] - w[1] || h[2] - w[2];
  if (want.startsWith("^")) return h[0] === w[0] && cmp >= 0;
  if (want.startsWith(">=")) return cmp >= 0;
  return cmp === 0;
};

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch { return null; }
}

/** True when `url`'s origin equals an allowed origin, or matches a pattern with a single `*` host label. */
export function originAllowed(url: string, allowed: string[]): boolean {
  const origin = originOf(url);
  if (!origin) return false;
  for (const raw of allowed) {
    if (!raw) continue;
    const pat = originOf(raw.includes("://") ? raw : "https://" + raw);
    if (!pat) continue;
    if (pat === origin) return true;
    if (pat.includes("*")) {
      const re = new RegExp("^" + pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, "[^.]+") + "$");
      if (re.test(origin)) return true;
    }
  }
  return false;
}

const SECRET_ID = /^[a-z0-9._-]{1,64}$/;

/**
 * Prefix a plugin-local secret key and lowercase it so the result matches the host id charset
 * `^[a-z0-9._-]{1,64}$`. The plugin passes `"apiKey"`; the host receives `"ai.apikey"`.
 * Rejects anything that would escape `${pluginId}.`.
 */
export function secretIdFor(pluginId: string, key: string): string {
  const prefix = pluginId.toLowerCase() + ".";
  const given = key.toLowerCase();
  const bare = given.startsWith(prefix) ? given.slice(prefix.length) : given;
  if (!bare || bare.includes("/") || bare.includes("..") || bare.startsWith(".") || /\s/.test(bare)) {
    throw new Error("invalid secret key");
  }
  const id = prefix + bare;
  if (!SECRET_ID.test(id)) throw new Error("invalid secret id");
  return id;
}

export class PluginManager {
  private listeners = new Map<AppEvent, Set<(...a: any[]) => void>>();
  readonly loaded = new Map<string, { plugin: EditorPlugin; exports: any }>();
  readonly errors: { id: string; error: string }[] = [];
  private services = new Map<string, unknown>();
  /** url-type setting values, used as extra allowed origins for that plugin. */
  private urlSettings = new Map<string, Map<string, string>>();
  /** Return false to reject a settings write (the caller reverts the control). */
  private settingGuards = new Map<string, (key: string, value: any) => boolean>();

  constructor(private host: PluginHost) {}

  emit(ev: AppEvent, ...a: any[]) { this.listeners.get(ev)?.forEach((f) => { try { f(...a); } catch (e) { console.error(e); } }); }

  settingKey = (owner: string, key: string) => `mdnest.plugin.${owner}.${key}`;

  /** A plugin may confirm or reject a settings-panel write before it is stored. */
  guardSetting(owner: string, fn: (key: string, value: any) => boolean) {
    this.settingGuards.set(owner, fn);
  }

  /**
   * Store a setting unless the owner's guard returns false.
   * Callers that paint a control should revert when this returns false.
   */
  commitSetting(owner: string, key: string, value: any): boolean {
    const guard = this.settingGuards.get(owner);
    if (guard && guard(key, value) === false) return false;
    localStorage.setItem(this.settingKey(owner, key), JSON.stringify(value));
    if (typeof value === "string") this.noteUrlSetting(owner, key, value);
    this.emit("settings-changed", owner, key, value);
    return true;
  }

  /** Remember a url setting so ctx.net can allow that origin. */
  noteUrlSetting(owner: string, key: string, value: string) {
    if (!this.urlSettings.has(owner)) this.urlSettings.set(owner, new Map());
    this.urlSettings.get(owner)!.set(key, value);
  }

  /** topologically sort by depends + consumes and activate; missing/incompatible deps disable the dependent */
  activateAll(plugins: EditorPlugin[]) {
    const byId = new Map(plugins.map((p) => [p.manifest.id, p]));
    const providers = new Map<string, EditorPlugin>();
    for (const p of plugins) for (const name of p.manifest.provides ?? []) {
      if (providers.has(name)) this.errors.push({ id: p.manifest.id, error: `duplicate provider for ${name}` });
      else providers.set(name, p);
    }
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
      for (const name of p.manifest.consumes ?? []) {
        const d = providers.get(name);
        if (!d) { this.errors.push({ id, error: `missing consumed service ${name}` }); return false; }
        if (d.manifest.id !== id && !visit(d, [...chain, id])) { this.errors.push({ id, error: `provider of ${name} failed` }); return false; }
      }
      state.set(id, 2); order.push(p); return true;
    };
    plugins.forEach((p) => visit(p, []));
    for (const p of order) {
      if (this.loaded.has(p.manifest.id)) continue;
      if (this.errors.some((e) => e.id === p.manifest.id)) continue;
      try {
        const exports = p.activate(this.context(p));
        this.loaded.set(p.manifest.id, { plugin: p, exports });
        for (const name of p.manifest.provides ?? []) {
          if (!this.services.has(name)) this.services.set(name, exports);
        }
      } catch (e: any) { this.errors.push({ id: p.manifest.id, error: String(e?.message ?? e) }); }
    }
    this.errors.forEach((e) => console.warn(`[plugin ${e.id}]`, e.error));
  }

  private requirePerm(p: EditorPlugin, kind: EditorPerm) {
    const list = p.manifest.permissions?.editor ?? [];
    if (!list.includes(kind)) throw new Error(`plugin ${p.manifest.id} lacks editor permission "${kind}"`);
  }

  private requireWs(p: EditorPlugin, kind: "read" | "open") {
    const list = p.manifest.permissions?.workspace ?? [];
    if (!list.includes(kind)) throw new Error(`plugin ${p.manifest.id} lacks workspace permission "${kind}"`);
  }

  private context(p: EditorPlugin): PluginContext {
    const id = p.manifest.id, h = this.host;
    const deps: Record<string, any> = {};
    for (const dep of Object.keys(p.manifest.depends ?? {})) deps[dep] = this.loaded.get(dep)?.exports;
    const view = () => h.getView();
    const readState = () => {
      this.requirePerm(p, "read");
      return view().state;
    };
    return {
      manifest: p.manifest, deps,
      commands: {
        add: (c) => h.addCommand({ ...c, id: c.id.includes(".") ? c.id : `${id}.${c.id}` }, id),
        run: (cid) => h.runCommand(cid),
      },
      ui: {
        registerSidebarPanel: (panel) => h.addSidebarPanel(panel, id),
        notify: (m) => h.notify(m),
        revealPanel: (panelId) => h.revealPanel(panelId),
        prompt: (opts) => h.prompt(opts),
      },
      settings: {
        register: (specs) => h.addSettings(id, specs.map((s) => ({ ...s }))),
        get: (key) => {
          const raw = localStorage.getItem(this.settingKey(id, key));
          return raw == null ? undefined as any : JSON.parse(raw);
        },
        set: (key, v) => {
          localStorage.setItem(this.settingKey(id, key), JSON.stringify(v));
          this.emit("settings-changed", id, key, v);
        },
      },
      editor: {
        registerDecorations: (f) => h.addDecorations(f),
        getMarkdown: () => h.getMarkdown(),
        getState: () => h.getState(),
        refresh: () => h.refreshDecorations(),
        getSelection: () => {
          const sel = readState().selection;
          return { from: sel.from, to: sel.to, empty: sel.empty };
        },
        getSelectionMarkdown: () => selectionMarkdown(readState()),
        getDocMarkdown: () => { this.requirePerm(p, "read"); return h.getMarkdown(); },
        getFilePath: () => { this.requirePerm(p, "read"); return h.getFilePath(); },
        getContext: ({ before, after }) => contextMarkdown(readState(), readState().selection.from, before, after),
        insertMarkdown: (md, at) => {
          this.requirePerm(p, "write");
          const v = view();
          const range = !at || at === "cursor" ? { from: v.state.selection.from, to: v.state.selection.to } : at;
          const slice = sliceForInsert(md, v.state, range.from, range.to);
          const tr = v.state.tr.replaceRange(range.from, range.to, slice);
          tr.setMeta("plugin", id);
          tr.scrollIntoView();
          v.dispatch(tr);
        },
        beginSuggestion: (spec) => {
          this.requirePerm(p, "suggest");
          const v = view();
          const sel = v.state.selection;
          const range = spec.range ?? { from: sel.from, to: sel.to };
          const rec = beginRecord(v.state, { owner: id, from: range.from, to: range.to, mode: spec.mode, label: spec.label, onRetry: spec.onRetry });
          addSuggestion(v, rec);
          const handle: SuggestionHandle = {
            id: rec.id,
            append: (text) => {
              const live = liveRec(v, rec.id);
              if (!live) return;
              patchSuggestion(v, rec.id, { text: live.text + text });
            },
            setText: (text) => { if (liveRec(v, rec.id)) patchSuggestion(v, rec.id, { text }); },
            finish: () => { if (liveRec(v, rec.id)) patchSuggestion(v, rec.id, { phase: "ready" }); },
            fail: (msg) => { if (liveRec(v, rec.id)) patchSuggestion(v, rec.id, { phase: "error", error: msg }); },
            cancel: () => {
              const live = liveRec(v, rec.id);
              if (!live) return;
              v.dispatch(v.state.tr.setMeta(suggestKey, { type: "drop", ids: [live.id], result: "rejected" }));
              live.settled.forEach((cb) => { try { cb("rejected"); } catch { /* plugin */ } });
            },
            onSettled: (cb) => { rec.settled.push(cb); },
          };
          return handle;
        },
        registerSlashItem: (item) => {
          const full: SlashItem = { ...item, id: item.id.includes(".") ? item.id : `${id}.${item.id}`, owner: id };
          registerSlashItem(view(), full);
        },
      },
      events: { on: (ev, fn) => { if (!this.listeners.has(ev)) this.listeners.set(ev, new Set()); this.listeners.get(ev)!.add(fn); } },
      guardSetting: (fn) => this.guardSetting(id, fn),
      services: {
        provide: (name, impl) => {
          const declared = p.manifest.provides ?? [];
          if (declared.length && !declared.includes(name)) throw new Error(`plugin ${id} did not declare service ${name}`);
          this.services.set(name, impl);
        },
        require: (name) => {
          if (!this.services.has(name)) throw new Error(`service ${name} is not provided`);
          return this.services.get(name);
        },
      },
      net: {
        stream: (req, onEvent) => {
          const allowed = p.manifest.permissions?.net;
          if (!allowed) {
            onEvent({ type: "error", message: `plugin ${id} lacks net permission` });
            onEvent({ type: "done" });
            return { cancel() {} };
          }
          const extras: string[] = [];
          const stored = this.urlSettings.get(id);
          if (stored) for (const v of stored.values()) if (v) extras.push(v);
          for (const spec of h.settingsFor(id)) {
            if (spec.type !== "url") continue;
            const v = h.getSetting(id, spec.key);
            if (typeof v === "string" && v) extras.push(v);
          }
          if (!originAllowed(req.url, [...allowed, ...extras])) {
            onEvent({ type: "error", message: "URL origin is not allowed for this plugin" });
            onEvent({ type: "done" });
            return { cancel() {} };
          }
          let secretRef = req.secretRef;
          if (secretRef) {
            if (!p.manifest.permissions?.secrets) {
              onEvent({ type: "error", message: `plugin ${id} lacks secrets permission` });
              onEvent({ type: "done" });
              return { cancel() {} };
            }
            try { secretRef = secretIdFor(id, secretRef); }
            catch (e: any) {
              onEvent({ type: "error", message: String(e?.message ?? e) });
              onEvent({ type: "done" });
              return { cancel() {} };
            }
          }
          return h.host.net.stream({ ...req, secretRef }, onEvent);
        },
      },
      workspace: {
        root: () => { this.requireWs(p, "read"); return h.getWorkspaceRoot(); },
        openAt: async (path, line) => { this.requireWs(p, "open"); await h.openAt(path, line); },
      },
      index: {
        call: async (op, args = {}) => {
          if (!p.manifest.permissions?.index) throw new Error(`plugin ${id} lacks index permission`);
          const root = h.getWorkspaceRoot();
          if (!root) throw new Error("no folder is open");
          return h.host.index.call({ ...args, op, root });
        },
        watch: async (fn) => {
          if (!p.manifest.permissions?.index) throw new Error(`plugin ${id} lacks index permission`);
          const root = h.getWorkspaceRoot();
          if (!root) return () => {};
          return h.host.index.watch(root, fn);
        },
      },
      secrets: {
        has: async (key) => {
          if (!p.manifest.permissions?.secrets) throw new Error(`plugin ${id} lacks secrets permission`);
          return h.host.secrets.has(secretIdFor(id, key));
        },
        backend: async () => {
          if (!p.manifest.permissions?.secrets) throw new Error(`plugin ${id} lacks secrets permission`);
          return h.host.secrets.backend();
        },
      },
    };
  }
}

function liveRec(view: EditorView, id: string): SugRecord | undefined {
  return suggestKey.getState(view.state)?.items.find((it) => it.id === id);
}

/** Cancel every pending suggestion. Source-mode toggles and file switches call this. */
export function cancelPendingSuggestions(view: EditorView) {
  cancelAll(view, "rejected");
}
