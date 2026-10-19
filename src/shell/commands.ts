// Command registry + keyboard dispatcher.
// Accelerators are stored as "CmdOrCtrl+Shift+K" (Ctrl on Windows/Linux, Cmd on macOS).
// The palette, menus, context menus and this dispatcher all run commands by id.
import type { Command } from "../plugins/api";

export type { Command };

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform + navigator.userAgent);

/** Named keys that appear in accelerators, mapped to KeyboardEvent.key. */
const NAMED: Record<string, string> = {
  comma: ",",
  period: ".",
  slash: "/",
  backslash: "\\",
  semicolon: ";",
  equal: "=",
  equals: "=",
  minus: "-",
  plus: "+",
  quote: "'",
  backquote: "`",
  space: " ",
  tab: "Tab",
  enter: "Enter",
  escape: "Escape",
  esc: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5", f6: "F6",
  f7: "F7", f8: "F8", f9: "F9", f10: "F10", f11: "F11", f12: "F12",
};

export interface Accel {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  /** Original "CmdOrCtrl+…" form, for menus and the palette. */
  canonical: string;
}

/**
 * Parse "CmdOrCtrl+Shift+K" / "Ctrl+/" / "Alt+Shift+5" / "F3".
 * `CmdOrCtrl` becomes Meta on macOS and Ctrl elsewhere. Returns null for empty input.
 */
export function parseAccelerator(raw: string | undefined | null): Accel | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;
  const parts = text.split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  let ctrl = false, shift = false, alt = false, meta = false;
  const mods: string[] = [];
  let keyToken = "";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const low = p.toLowerCase();
    const isMod = /^(cmdorctrl|commandorcontrol|mod|ctrl|control|cmd|command|meta|shift|alt|option)$/.test(low);
    if (isMod && i < parts.length - 1) {
      if (low === "cmdorctrl" || low === "commandorcontrol" || low === "mod") {
        if (MAC) meta = true; else ctrl = true;
        if (!mods.includes("CmdOrCtrl")) mods.push("CmdOrCtrl");
      } else if (low === "ctrl" || low === "control") { ctrl = true; mods.push("Ctrl"); }
      else if (low === "cmd" || low === "command" || low === "meta") { meta = true; mods.push("Cmd"); }
      else if (low === "shift") { shift = true; mods.push("Shift"); }
      else if (low === "alt" || low === "option") { alt = true; mods.push("Alt"); }
    } else {
      keyToken = p;
    }
  }
  if (!keyToken) return null;
  const named = NAMED[keyToken.toLowerCase()];
  const key = named ?? (keyToken.length === 1 ? keyToken : keyToken);
  // Canonical order: CmdOrCtrl, Ctrl, Cmd, Alt, Shift, key.
  const order = ["CmdOrCtrl", "Ctrl", "Cmd", "Alt", "Shift"];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const displayKey = key === " " ? "Space"
    : key === "," ? ","
    : key === "`" ? "`"
    : key.length === 1 ? key.toUpperCase()
    : key;
  return { key, ctrl, shift, alt, meta, canonical: [...mods, displayKey].join("+") };
}

/** Turn a KeyboardEvent into the same shape `parseAccelerator` produces, or null if it is a bare key. */
export function accelFromEvent(e: KeyboardEvent): Accel | null {
  if (e.isComposing) return null;
  const key = e.key;
  if (!key || key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") return null;
  // A shortcut is a modified key, or a function / navigation key we bind on its own (F3, F5, F8…).
  const bare = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
  const functionKey = /^F\d{1,2}$/.test(key) || key === "Home" || key === "End";
  if (bare && !functionKey) return null;
  if (bare && e.shiftKey) return null;
  return {
    key: key.length === 1 ? key : key,
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    meta: e.metaKey,
    canonical: "",
  };
}

function keyEqual(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === 1 && b.length === 1 && a.toLowerCase() === b.toLowerCase()) return true;
  // "=" and "+" share a key; accelerators written either way should match Shift+=.
  if ((a === "=" || a === "+") && (b === "=" || b === "+")) return true;
  return false;
}

export function accelMatches(accel: Accel, event: Accel): boolean {
  if (!!accel.ctrl !== !!event.ctrl) return false;
  if (!!accel.shift !== !!event.shift) return false;
  if (!!accel.alt !== !!event.alt) return false;
  if (!!accel.meta !== !!event.meta) return false;
  return keyEqual(accel.key, event.key);
}

export function commandEnabled(c: Command): boolean {
  if (!c.when) return true;
  try { return !!c.when(); } catch { return false; }
}

/** First enabled command whose accelerator matches the event. */
export function commandForAccel(commands: Command[], event: KeyboardEvent): Command | undefined {
  const ev = accelFromEvent(event);
  if (!ev) return undefined;
  for (const c of commands) {
    if (!c.key || !commandEnabled(c)) continue;
    const a = parseAccelerator(c.key);
    if (a && accelMatches(a, ev)) return c;
  }
  return undefined;
}

const TEXT_EDIT = new Set(["edit.undo", "edit.redo", "edit.selectAll"]);

/** True when the key should edit an input / CodeMirror rather than the ProseMirror document. */
export function focusOutsideEditor(el: Element | null): boolean {
  if (!el) return false;
  if (el.closest?.("#write")) return false;
  return isTextField(el) || !!codeMirrorOf(el);
}

function isTextField(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return type !== "checkbox" && type !== "radio" && type !== "button" && type !== "file";
  }
  return (el as HTMLElement).isContentEditable;
}

/** CodeMirror 5 instance attached to an ancestor, if focus is inside one. */
function codeMirrorOf(el: Element | null): { undo(): void; redo(): void; execCommand(c: string): void } | null {
  let n: Element | null = el;
  while (n) {
    const cm = (n as any).CodeMirror;
    if (cm && typeof cm.undo === "function") return cm;
    n = n.parentElement;
  }
  return null;
}

/**
 * Undo / redo / select-all follow focus: an <input>, <textarea> or CodeMirror edits itself;
 * the ProseMirror editor uses its history plugin (the command's own run).
 */
export function runFocusAware(id: string, target: Element | null, fallback: () => void): void {
  if (!TEXT_EDIT.has(id)) { fallback(); return; }
  const cm = codeMirrorOf(target);
  if (cm) {
    if (id === "edit.undo") cm.undo();
    else if (id === "edit.redo") cm.redo();
    else cm.execCommand("selectAll");
    return;
  }
  if (isTextField(target)) {
    const cmd = id === "edit.undo" ? "undo" : id === "edit.redo" ? "redo" : "selectAll";
    try { document.execCommand(cmd); } catch { /* ignore */ }
    return;
  }
  fallback();
}

export interface Dispatcher {
  /** Capture-phase listener. Tests call this with a synthetic KeyboardEvent. */
  onKeyDown(e: KeyboardEvent): void;
  /** Record that `id` just ran, so a following key/menu within 300 ms is dropped. */
  note(id: string): void;
  /** True when `id` ran (via key or menu) within the last 300 ms. */
  recent(id: string): boolean;
  dispose(): void;
}

/**
 * One capture-phase keydown dispatcher. GTK swallows a menu accelerator, Windows may deliver both
 * the menu event and the key — so the same id is dropped if it already ran within 300 ms.
 * Pass `only` to restrict which ids the dispatcher fires. When omitted, every registered
 * accelerator is dispatched. Undo / redo / select-all follow focus (input, CodeMirror, editor).
 */
export function installKeyboardDispatcher(
  getCommands: () => Command[],
  run: (id: string) => void,
  only?: Set<string> | (() => Set<string>),
): Dispatcher {
  const last = new Map<string, number>();
  const note = (id: string) => last.set(id, Date.now());
  const recent = (id: string) => {
    const t = last.get(id);
    return t != null && Date.now() - t < 300;
  };
  const allowed = (id: string) => {
    if (!only) return true;
    const set = typeof only === "function" ? only() : only;
    return set.has(id);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const cmd = commandForAccel(getCommands(), e);
    if (!cmd || !allowed(cmd.id)) return;
    const target = (e.target as Element | null) ?? document.activeElement;
    // Undo/redo/select-all inside the editor stay with ProseMirror history (one undo step).
    // Outside it (find bar, prompts, CodeMirror source) the dispatcher edits that field.
    if (TEXT_EDIT.has(cmd.id) && !focusOutsideEditor(target)) {
      if (recent(cmd.id)) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if (recent(cmd.id)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    note(cmd.id);
    if (TEXT_EDIT.has(cmd.id)) runFocusAware(cmd.id, target, () => run(cmd.id));
    else run(cmd.id);
  };
  document.addEventListener("keydown", onKeyDown, true);
  return {
    onKeyDown,
    note,
    recent,
    dispose() { document.removeEventListener("keydown", onKeyDown, true); },
  };
}

/** Browser keys that must never reload the page or zoom it (WebView2 leaves them on by default). */
const PAGE_KEYS = new Set(["=", "+", "-", "_", "0"]);

export function isPageChromeKey(e: KeyboardEvent): boolean {
  const key = e.key;
  if (key === "F5") return true;
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return false;
  if (key === "r" || key === "R") return true;
  if (!e.altKey && PAGE_KEYS.has(key)) return true;
  return false;
}

/** Swallow F5 / Ctrl+R / Ctrl+Shift+R / page zoom on every platform. */
export function installPageKeyGuard(): void {
  document.addEventListener("keydown", (e) => {
    if (!isPageChromeKey(e)) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

/** Our menus replace the native context menu. Leave inputs, textareas and CodeMirror alone. */
export function installContextMenuGuard(): void {
  document.addEventListener("contextmenu", (e) => {
    const t = e.target as Element | null;
    if (!t) { e.preventDefault(); return; }
    if (t.closest("input, textarea, #typora-source, .CodeMirror")) return;
    e.preventDefault();
  }, true);
}
