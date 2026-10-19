// Library: local knowledge base for the open folder. Keyword search (FTS5) works on its own;
// with AI on and an embeddings endpoint it adds vectors (hybrid search), related notes and
// "@library" questions in the AI chat with clickable citations. Off by default; the indexing and
// panel code are loaded only when enabled.
import type { EditorPlugin, PluginContext, SettingSpec } from "../../api";
import type { AiProvider } from "../ai/provider";
import "./library.css";

const specs = (): SettingSpec[] => [
  { key: "enabled", title: "Index the open folder", type: "boolean", default: false },
  { key: "note", title: "Library", type: "note", text: "The index stays on this computer (app data folder). Keyword search needs nothing else. With AI enabled, chunk text is sent to the embeddings endpoint set in Settings → AI to build vectors; folders excluded there or here are never indexed." },
  { key: "exclude", title: "Also exclude (one folder per line)", type: "text", default: "" },
  { key: "embed", title: "Build vectors when AI is on", type: "boolean", default: true },
  { key: "k", title: "Sources per @library question", type: "number", default: 6 },
  { key: "maxDistance", title: "Meaning match cut-off for all models (cosine distance 0–2, lower = stricter; 0 = per-model default)", type: "number", default: 0 },
  { key: "cutoffs", title: "Per-model cut-offs, one per line: model = max [relative] (e.g. nomic-embed-text = 0.4 0.05). Built-in: nomic-embed-text 0.4 / 0.05, others 0.8 / 0.15", type: "text", default: "" },
];

const plugin: EditorPlugin = {
  manifest: {
    id: "library", name: "Library", version: "1.0.0",
    description: "Hybrid search over the open folder and @library questions with citations.",
    depends: { ai: "^1.0.0" },
    consumes: ["ai.provider@1"],
    permissions: { index: true, workspace: ["read", "open"], editor: ["read"] },
  },
  activate(ctx: PluginContext) {
    ctx.settings.register(specs());
    const ai = ctx.services.require("ai.provider@1") as AiProvider;
    let rt: Promise<typeof import("./runtime")> | null = null;
    const load = () => (rt ??= import("./runtime").then((m) => { m.init(ctx, ai); return m; }));
    const on = () => ctx.settings.get("enabled") === true;
    if (on()) void load().then((m) => m.start());
    ctx.events.on("settings-changed", (owner?: string, key?: string) => {
      if (owner !== "library" || key !== "enabled") return;
      if (on()) void load().then((m) => m.start()); else if (rt) void rt.then((m) => m.stop());
    });
    ctx.events.on("workspace-changed", () => { if (on()) void load().then((m) => m.start()); });
    ctx.commands.add({ id: "enable", title: "Library: Index this folder", when: () => !on(), run: () => ctx.settings.set("enabled", true) });
    ctx.commands.add({ id: "reindex", title: "Library: Re-index now", when: on, run: () => load().then((m) => m.reindex(false)) });
    ctx.commands.add({ id: "rebuild", title: "Library: Rebuild index", when: on, run: () => load().then((m) => m.reindex(true)) });
    ctx.commands.add({ id: "search", title: "Library: Search", when: on, run: () => ctx.ui.revealPanel("library") });
    ctx.ui.registerSidebarPanel({
      id: "library", title: "Library",
      render: (el) => {
        if (!on()) {
          el.replaceChildren();
          const box = document.createElement("div"); box.className = "mdn-lib mdn-lib-off";
          const p = document.createElement("p"); p.textContent = "The library is off. Nothing is indexed.";
          const b = document.createElement("button"); b.type = "button"; b.textContent = "Index this folder";
          b.onclick = () => ctx.settings.set("enabled", true);
          box.append(p, b); el.appendChild(box);
          const again = (owner?: string, key?: string) => { if (owner === "library" && key === "enabled" && on()) void load().then((m) => m.mountPanel(el)); };
          ctx.events.on("settings-changed", again);
          return;
        }
        void load().then((m) => m.mountPanel(el));
      },
    });
  },
};
export default plugin;
