// AI assistant. Heavy UI and prompts stay in a separate chunk until the user turns AI on.
import type { EditorPlugin, PluginContext, SettingSpec } from "../../api";
import {
  PRESETS, applyPresetChange, createProvider, presetOf, type AiProvider, type PresetId,
} from "./provider";

export const PRIVACY_NOTE =
  "Selected text, nearby document context, and chat messages are sent to the configured provider. Nothing is sent while AI is off. Documents in excluded folders are never sent. There is no telemetry.";

const PRESET_OPTIONS = [
  { value: "relay", label: "Relay (Grok)" },
  { value: "openai", label: "OpenAI" },
  { value: "ollama", label: "Ollama (local)" },
  { value: "custom", label: "Custom" },
];

function settingSpecs(): SettingSpec[] {
  return [
    { key: "enabled", title: "Enable AI", type: "boolean", default: false },
    { key: "preset", title: "Provider preset", type: "select", default: "relay", options: PRESET_OPTIONS },
    { key: "baseUrl", title: "Base URL", type: "url", default: PRESETS.relay.baseUrl },
    { key: "model", title: "Model", type: "string", default: PRESETS.relay.model },
    { key: "apiKey", title: "API key", type: "secret" },
    { key: "temperature", title: "Temperature", type: "number", default: 0.7 },
    { key: "maxTokens", title: "Max tokens", type: "number", default: 1024 },
    { key: "translateTo", title: "Translate into", type: "string", default: "English" },
    { key: "localOnly", title: "Local only (localhost or private LAN)", type: "boolean", default: false },
    { key: "exclude", title: "Excluded folders (one prefix per line)", type: "text", default: "" },
    { key: "privacy", title: "Privacy", type: "note", text: PRIVACY_NOTE },
  ];
}

const plugin: EditorPlugin = {
  manifest: {
    id: "ai",
    name: "AI Assistant",
    version: "1.0.0",
    description: "Selection actions, /ai generation, and a sidebar chat. Off until enabled.",
    provides: ["ai.provider@1"],
    permissions: {
      net: ["http://localhost:11434", "http://127.0.0.1:11434"],
      secrets: true,
      editor: ["read", "suggest", "write"],
    },
  },
  activate(ctx) {
    ctx.settings.register(settingSpecs());
    seedDefaults(ctx);
    ctx.guardSetting((key, value) => {
      if (key !== "enabled" || value !== true) return true;
      if (ctx.settings.get(ACK_KEY) === true) return true;
      // confirm() is synchronous, so the settings control can revert in the same turn.
      const ok = window.confirm(PRIVACY_NOTE + "\n\nEnable AI?");
      if (ok) ctx.settings.set(ACK_KEY, true);
      else ctx.ui.notify("AI stays off");
      return ok;
    });

    let heavy: Promise<typeof import("./runtime")> | null = null;
    const load = () => (heavy ??= import("./runtime"));

    const provider: AiProvider = createProvider({
      stream: (req, onEvent) => ctx.net.stream(req, onEvent),
      hasSecret: () => ctx.secrets.has("apiKey"),
      enabled: () => isOn(ctx),
      preset: () => presetOf(ctx.settings.get("preset") ?? "relay"),
      baseUrl: () => String(ctx.settings.get("baseUrl") ?? ""),
      model: () => String(ctx.settings.get("model") ?? ""),
      temperature: () => num(ctx.settings.get("temperature"), 0.7),
      maxTokens: () => num(ctx.settings.get("maxTokens"), 1024),
      localOnly: () => ctx.settings.get("localOnly") === true,
      secretKey: "apiKey",
    });
    ctx.services.provide("ai.provider@1", provider);

    let slashOn = false;
    const ensureSlash = () => {
      if (slashOn || !isOn(ctx)) return;
      slashOn = true;
      void load().then((mod) => mod.registerSlash(ctx, provider));
    };

    ctx.commands.add({
      id: "enable",
      title: "AI: Enable",
      when: () => !isOn(ctx),
      run: () => enableAi(ctx, load),
    });

    const whenOn = () => isOn(ctx);
    ctx.commands.add({ id: "rewrite", title: "AI: Rewrite…", key: "Mod-k", when: whenOn, run: () => load().then((m) => m.runRewrite(ctx, provider)) });
    ctx.commands.add({ id: "polish", title: "AI: Polish", when: whenOn, run: () => load().then((m) => m.runAction(ctx, provider, "polish")) });
    ctx.commands.add({ id: "translate", title: "AI: Translate", when: whenOn, run: () => load().then((m) => m.runAction(ctx, provider, "translate")) });
    ctx.commands.add({ id: "summarize", title: "AI: Summarize", when: whenOn, run: () => load().then((m) => m.runAction(ctx, provider, "summarize")) });
    ctx.commands.add({ id: "continue", title: "AI: Continue writing", when: whenOn, run: () => load().then((m) => m.runAction(ctx, provider, "continue")) });
    ctx.commands.add({ id: "ask", title: "AI: Ask about selection", when: whenOn, run: () => load().then((m) => m.askAboutSelection(ctx)) });

    ctx.ui.registerSidebarPanel({
      id: "ai",
      title: "AI",
      render: (el) => {
        let disposed = false;
        let cleanup: (() => void) | void;
        const paintOff = () => {
          el.replaceChildren();
          const box = document.createElement("div");
          box.className = "mdn-ai mdn-ai-off";
          const p = document.createElement("p");
          p.textContent = "AI is off. Nothing is sent.";
          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = "Enable AI";
          btn.onclick = () => { void enableAi(ctx, load); };
          box.append(p, btn);
          el.appendChild(box);
        };
        const paintOn = () => {
          el.replaceChildren();
          const holder = document.createElement("div");
          holder.className = "mdn-ai mdn-ai-loading";
          holder.textContent = "Loading AI…";
          el.appendChild(holder);
          void load().then((mod) => {
            if (disposed) return;
            cleanup = mod.mountChat(el, ctx, provider);
          });
        };
        const sync = () => {
          if (!isOn(ctx)) {
            if (typeof cleanup === "function") cleanup();
            cleanup = undefined;
            paintOff();
            return;
          }
          ensureSlash();
          // Status-only changes must not reload the chat chunk or wipe the transcript.
          if (cleanup) return;
          paintOn();
        };
        sync();
        const onSettings = (owner: string, key: string) => {
          if (owner !== "ai") return;
          if (key === "preset") fillPreset(ctx);
          if (key === "enabled") sync();
        };
        ctx.events.on("settings-changed", onSettings);
        return () => {
          disposed = true;
          if (typeof cleanup === "function") cleanup();
        };
      },
    });

    if (isOn(ctx)) ensureSlash();
    ctx.events.on("settings-changed", (owner: string, key: string) => {
      if (owner !== "ai") return;
      if (key === "preset") fillPreset(ctx);
      if (key === "enabled" && isOn(ctx)) ensureSlash();
    });

    return provider;
  },
};

function isOn(ctx: PluginContext): boolean {
  return ctx.settings.get("enabled") === true;
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function seedDefaults(ctx: PluginContext) {
  if (ctx.settings.get("preset") == null) ctx.settings.set("preset", "relay");
  if (ctx.settings.get("baseUrl") == null) ctx.settings.set("baseUrl", PRESETS.relay.baseUrl);
  if (ctx.settings.get("model") == null) ctx.settings.set("model", PRESETS.relay.model);
  if (ctx.settings.get("temperature") == null) ctx.settings.set("temperature", 0.7);
  if (ctx.settings.get("maxTokens") == null) ctx.settings.set("maxTokens", 1024);
  if (ctx.settings.get("translateTo") == null) ctx.settings.set("translateTo", "English");
  if (ctx.settings.get("enabled") == null) ctx.settings.set("enabled", false);
  if (ctx.settings.get("localOnly") == null) ctx.settings.set("localOnly", false);
  if (ctx.settings.get("exclude") == null) ctx.settings.set("exclude", "");
}

function fillPreset(ctx: PluginContext) {
  const next = presetOf(ctx.settings.get("preset"));
  const prev = presetOf(ctx.settings.get("_presetApplied") ?? "relay");
  if (next === prev && ctx.settings.get("_presetApplied") != null) return;
  const patch = applyPresetChange(
    next,
    prev,
    String(ctx.settings.get("baseUrl") ?? ""),
    String(ctx.settings.get("model") ?? ""),
  );
  if (patch.baseUrl != null) ctx.settings.set("baseUrl", patch.baseUrl);
  if (patch.model != null) ctx.settings.set("model", patch.model);
  ctx.settings.set("_presetApplied", next);
}

const ACK_KEY = "privacyAck";

export function confirmEnable(ctx: PluginContext): boolean {
  if (ctx.settings.get(ACK_KEY) === true) return true;
  const ok = window.confirm(PRIVACY_NOTE + "\n\nEnable AI?");
  if (ok) ctx.settings.set(ACK_KEY, true);
  return ok;
}

function enableAi(ctx: PluginContext, load: () => Promise<typeof import("./runtime")>) {
  if (isOn(ctx)) {
    ctx.ui.revealPanel("ai");
    return;
  }
  if (!confirmEnable(ctx)) {
    ctx.ui.notify("AI stays off");
    return;
  }
  ctx.settings.set("enabled", true);
  void load();
  ctx.ui.revealPanel("ai");
  ctx.ui.notify("AI enabled");
}

export default plugin;

export type { PresetId };
