// Live keymap for plugin commands. Commands are registered after the editor is created,
// so the handler reads the current list on each keypress.
import { Plugin } from "prosemirror-state";
import type { Command as PluginCommand } from "../plugins/api";

const mac = typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform);

/** Turn a prosemirror-keymap name (`Mod-k`) into the normalized event name (`Ctrl-k`). */
export function normalizeBinding(name: string): string {
  const parts = name.split(/-(?!$)/);
  let result = parts[parts.length - 1];
  if (result === "Space") result = " ";
  let alt = false, ctrl = false, shift = false, meta = false;
  for (let i = 0; i < parts.length - 1; i++) {
    const mod = parts[i];
    if (/^(cmd|meta|m)$/i.test(mod)) meta = true;
    else if (/^a(lt)?$/i.test(mod)) alt = true;
    else if (/^(c|ctrl|control)$/i.test(mod)) ctrl = true;
    else if (/^s(hift)?$/i.test(mod)) shift = true;
    else if (/^mod$/i.test(mod)) { if (mac) meta = true; else ctrl = true; }
  }
  if (alt) result = "Alt-" + result;
  if (ctrl) result = "Ctrl-" + result;
  if (meta) result = "Meta-" + result;
  if (shift) result = "Shift-" + result;
  return result;
}

function eventName(event: KeyboardEvent): string {
  let name = event.key;
  if (event.altKey) name = "Alt-" + name;
  if (event.ctrlKey) name = "Ctrl-" + name;
  if (event.metaKey) name = "Meta-" + name;
  if (event.shiftKey) name = "Shift-" + name;
  return name;
}

function active(c: PluginCommand) {
  if (!c.key) return false;
  if (!c.when) return true;
  try { return !!c.when(); } catch { return false; }
}

/** Bind plugin command hotkeys. Placed before the built-in keymap so a plugin `Mod-Enter` can win when active. */
export function liveCommandKeymap(commands: () => PluginCommand[]) {
  return new Plugin({
    props: {
      handleKeyDown(_view, event) {
        const name = eventName(event);
        const cmd = commands().find((c) => active(c) && normalizeBinding(c.key!) === name);
        if (!cmd) return false;
        event.preventDefault();
        void cmd.run();
        return true;
      },
    },
  });
}

/** Used by tests that want the same matching rules as the keymap plugin. */
export function commandForEvent(commands: PluginCommand[], event: { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): PluginCommand | undefined {
  const fake = { key: event.key, altKey: !!event.altKey, ctrlKey: !!event.ctrlKey, metaKey: !!event.metaKey, shiftKey: !!event.shiftKey } as KeyboardEvent;
  const name = eventName(fake);
  return commands.find((c) => active(c) && normalizeBinding(c.key!) === name);
}

