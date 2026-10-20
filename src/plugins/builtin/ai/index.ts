// AI assistant. Heavy UI and prompts stay in a separate chunk until the user turns AI on.
import { createUsage, type UsageLog } from "./usage";
import { t } from "../../../i18n";
import { icon } from "../../../shell/icons";
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
    { key: "embedNote", title: "Embeddings (used by the Library plugin)", type: "note", text: "OpenAI-compatible /v1/embeddings. The default is a local Ollama (ollama pull nomic-embed-text); the relay preset has no embeddings endpoint. Changing the model rebuilds the index." },
    { key: "embedBaseUrl", title: "Embeddings base URL", type: "url", default: "http://localhost:11434/v1" },
    { key: "embedModel", title: "Embeddings model", type: "string", default: "nomic-embed-text" },
    { key: "embedApiKey", title: "Embeddings API key (optional)", type: "secret" },
    { key: "dailyRequestLimit", title: "Daily request limit (0 = none)", type: "number", default: 0 },
    { key: "dailyTokenLimit", title: "Daily token limit (0 = none)", type: "number", default: 0 },
    { key: "exclude", title: "Excluded folders (one prefix per line)", type: "text", default: "" },
    { key: "rewriteShortcut", title: "Rewrite shortcut", type: "string", default: "Mod-j" },
    { key: "privacy", title: "Privacy", type: "note", text: PRIVACY_NOTE },
  ];
}

/** prosemirror-keymap name for AI Rewrite. Empty disables the shortcut. Default is Mod-j (Ctrl/Cmd+J). */
export function rewriteShortcut(ctx: PluginContext): string {
  const raw = ctx.settings.get("rewriteShortcut");
  if (raw == null) return "Mod-j";
  return String(raw).trim();
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
      workspace: ["open"],
    },
  },
  activate(ctx) {
    ctx.settings.register(settingSpecs());
    seedDefaults(ctx);
    ctx.guardSetting((key, value) => {
      if (key !== "enabled" || value !== true) return true;
      if (ctx.settings.get(ACK_KEY) === true) return true;
      // confirm() is synchronous, so the settings control can revert in the same turn.
      const ok = window.confirm(t(PRIVACY_NOTE) + "\n\n" + t("Enable AI?"));
      if (ok) ctx.settings.set(ACK_KEY, true);
      else ctx.ui.notify("AI stays off");
      return ok;
    });

    let heavy: Promise<typeof import("./runtime")> | null = null;
    const load = () => (heavy ??= import("./runtime"));

    const usage = createUsage({
      load: () => ctx.settings.get("usage") as UsageLog | undefined,
      save: (log) => ctx.settings.set("usage", log),
      requestLimit: () => num(ctx.settings.get("dailyRequestLimit"), 0),
      tokenLimit: () => num(ctx.settings.get("dailyTokenLimit"), 0),
    });
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
      usage,
      exclude: () => String(ctx.settings.get("exclude") ?? ""),
      embedBaseUrl: () => String(ctx.settings.get("embedBaseUrl") ?? ""),
      embedModel: () => String(ctx.settings.get("embedModel") ?? ""),
      hasEmbedSecret: () => ctx.secrets.has("embedApiKey"),
      embedSecretKey: "embedApiKey",
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
    const syncRewrite = () => {
      const key = rewriteShortcut(ctx);
      ctx.commands.add({
        id: "rewrite",
        title: "AI: Rewrite…",
        ...(key ? { key } : {}),
        when: whenOn,
        run: () => load().then((m) => m.runRewrite(ctx, provider)),
      });
    };
    syncRewrite();
    ctx.commands.add({ id: "polish", title: "AI: Polish", when: whenOn, run: () => load().then((m) => m.runAction(ctx, provider, "polish")) });
    ctx.commands.add({ id: "translate", title: "AI: Translate", when: whenOn, run: () => load().then((m) => m.runAction(ctx, provider, "translate")) });
    ctx.commands.add({ id: "summarize", title: "AI: Summarize", when: whenOn, run: () => load().then((m) => m.runAction(ctx, provider, "summarize")) });
    ctx.commands.add({ id: "continue", title: "AI: Continue writing", when: whenOn, run: () => load().then((m) => m.runAction(ctx, provider, "continue")) });
    ctx.commands.add({ id: "ask", title: "AI: Ask about selection", when: whenOn, run: () => load().then((m) => m.askAboutSelection(ctx)) });

    ctx.ui.registerSidebarPanel({
      id: "ai",
      title: "AI Assistant",
      icon: "ai",
      actions: [
        { id: "new-chat", title: "New chat (clear)", icon: "newChat", run: () => window.dispatchEvent(new CustomEvent("mdn-ai-clear")) },
        { id: "ai-settings", title: "AI settings", icon: "settings", run: () => openSettingsFor("AI") },
      ],
      render: (el) => {
        let disposed = false;
        let cleanup: (() => void) | void;
        const paintOff = () => {
          el.replaceChildren();
          const box = document.createElement("div");
          box.className = "mdn-ai mdn-ai-off";
          const art = document.createElement("div");
          art.className = "mdn-off-art";
          art.innerHTML = icon("ai", 30, 1.4);
          const p = document.createElement("p");
          p.textContent = t("AI is off. Nothing is sent.");
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "mdn-primary-btn";
          btn.textContent = t("Enable AI");
          box.append(art);
          btn.onclick = () => { void enableAi(ctx, load); };
          box.append(p, btn);
          el.appendChild(box);
        };
        let painted = false;
        const paintOn = () => {
          if (painted) return;
          painted = true;
          el.replaceChildren();
          const holder = document.createElement("div");
          holder.className = "mdn-ai mdn-ai-loading";
          holder.textContent = t("Loading AI…");
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
            painted = false;
            paintOff();
            return;
          }
          ensureSlash();
          // Status-only changes must not reload the chat chunk or wipe the transcript.
          if (painted) return;
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
      if (key === "rewriteShortcut") syncRewrite();
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
  if (ctx.settings.get("rewriteShortcut") == null) ctx.settings.set("rewriteShortcut", "Mod-j");
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
  const ok = window.confirm(t(PRIVACY_NOTE) + "\n\n" + t("Enable AI?"));
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

/** Show the settings panel filtered to one group (builtin plugins only). */
export function openSettingsFor(query: string) {
  document.body.classList.add("pin-outline");
  (document.querySelector('#typora-sidebar .sidebar-tab[data-id="settings"]') as HTMLElement | null)?.click();
  const input = document.getElementById("settings-search") as HTMLInputElement | null;
  if (input) { input.value = query; input.dispatchEvent(new Event("input")); }
}
