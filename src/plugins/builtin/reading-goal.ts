// Tiny dependent plugin: uses word-stats' exported API (demonstrates manifest.depends).
import type { EditorPlugin } from "../api";
const plugin: EditorPlugin = {
  manifest: { id: "reading-goal", name: "Writing Goal", version: "0.1.0", depends: { "word-stats": "^1.0.0" } },
  activate(ctx) {
    const ws = ctx.deps["word-stats"];
    ctx.settings.register([{ key: "goal", title: "Word goal", type: "number", default: 500 }]);
    ctx.commands.add({ id: "progress", title: "Writing Goal: Show progress", run: () => {
      const goal = ctx.settings.get<number>("goal") || 500; const { words } = ws.stats();
      ctx.ui.notify(`Goal: ${words}/${goal} words (${Math.min(100, Math.round((words / goal) * 100))}%)`);
    } });
  },
};
export default plugin;
