// Example plugin: word statistics + optional "long sentence" highlighting decoration.
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorPlugin } from "../api";

export function countWords(text: string) {
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) ?? []).length;
  const latin = (text.replace(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g, " ").match(/[\p{L}\p{N}'’-]+/gu) ?? []).length;
  return { words: latin + cjk, chars: text.replace(/\s/g, "").length };
}

const plugin: EditorPlugin = {
  manifest: { id: "word-stats", name: "Word Stats", version: "1.0.0", description: "Counts words and highlights long sentences" },
  activate(ctx) {
    ctx.settings.register([
      { key: "highlightLong", title: "Highlight sentences longer than N words", type: "boolean", default: false },
      { key: "maxWords", title: "Long sentence threshold (words)", type: "number", default: 30 },
    ]);
    if (ctx.settings.get("maxWords") === undefined) ctx.settings.set("maxWords", 30);
    let panelEl: HTMLElement | null = null;
    const stats = () => {
      const text = ctx.editor.getState().doc.textBetween(0, ctx.editor.getState().doc.content.size, "\n", " ");
      const { words, chars } = countWords(text);
      return { words, chars, minutes: Math.max(1, Math.round(words / 230)) };
    };
    const paint = () => {
      if (!panelEl) return; const s = stats();
      panelEl.innerHTML = `<div class="ws-panel"><h3>Document statistics</h3><table><tbody>
        <tr><td>Words</td><td>${s.words}</td></tr><tr><td>Characters</td><td>${s.chars}</td></tr>
        <tr><td>Reading time</td><td>~${s.minutes} min</td></tr></tbody></table></div>`;
    };
    ctx.ui.registerSidebarPanel({ id: "word-stats", title: "Stats", render: (el) => { panelEl = el; paint(); return () => (panelEl = null); } });
    ctx.events.on("doc-changed", paint);
    ctx.commands.add({ id: "show", title: "Word Stats: Show counts", run: () => { const s = stats(); ctx.ui.notify(`${s.words} words · ${s.chars} chars · ~${s.minutes} min read`); } });
    ctx.commands.add({ id: "toggle-long", title: "Word Stats: Toggle long-sentence highlighting", run: () => { ctx.settings.set("highlightLong", !ctx.settings.get("highlightLong")); ctx.editor.refresh(); } });
    ctx.editor.registerDecorations((state) => {
      if (!ctx.settings.get("highlightLong")) return null;
      const max = ctx.settings.get<number>("maxWords") || 30; const decos: Decoration[] = [];
      state.doc.descendants((node, pos) => {
        if (!node.isTextblock || node.type.spec.code) return true;
        const text = node.textContent; const re = /[^.!?。！？]+[.!?。！？]?/g; let m;
        while ((m = re.exec(text))) if (countWords(m[0]).words > max) {
          // map text offsets → doc positions (approximate for atoms; fine for MVP)
          decos.push(Decoration.inline(pos + 1 + m.index, pos + 1 + m.index + m[0].length, { class: "mdn-long-sentence" }));
        }
        return false;
      });
      return DecorationSet.create(state.doc, decos);
    });
    return { countWords, stats }; // exported API for dependents
  },
};
export default plugin;
