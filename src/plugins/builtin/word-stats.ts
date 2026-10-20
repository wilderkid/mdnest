// Example plugin: word statistics + optional "long sentence" highlighting decoration.
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorPlugin } from "../api";
import { t, minutesLabel, wordsLabel } from "../../i18n";
import { icon } from "../../shell/icons";

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
    const extra = () => {
      const doc = ctx.editor.getState().doc;
      let paragraphs = 0, headings = 0, images = 0, links = 0, sentences = 0;
      doc.descendants((n) => {
        if (n.type.name === "heading") headings++;
        else if (n.type.name === "paragraph" && n.textContent.trim()) paragraphs++;
        else if (n.type.name === "image") images++;
        if (n.isText && n.marks.some((m) => m.type.name === "link")) links++;
        if (n.isTextblock && !n.type.spec.code) sentences += (n.textContent.match(/[^.!?。！？]+[.!?。！？]+/g) ?? []).length || (n.textContent.trim() ? 1 : 0);
        return true;
      });
      const sel = ctx.editor.getState().selection;
      const selWords = sel.empty ? 0 : countWords(doc.textBetween(sel.from, sel.to, "\n", " ")).words;
      return { paragraphs, headings, images, links, sentences, selWords };
    };
    const goal = () => {
      try { const v = JSON.parse(localStorage.getItem("mdnest.plugin.reading-goal.goal") ?? "null"); return typeof v === "number" && v > 0 ? v : 500; } catch { return 500; }
    };
    const paint = () => {
      if (!panelEl) return; const s = stats(); const x = extra(); const g = goal();
      const pct = Math.min(100, Math.round((s.words / g) * 100));
      const card = (ic: string, label: string, value: string) => `<div class="ws-card">${icon(ic, 15)}<div><div class="ws-val">${value}</div><div class="ws-lab">${t(label)}</div></div></div>`;
      panelEl.innerHTML = `<div class="ws-panel"><h3>${t("Document statistics")}</h3>
        <div class="ws-hero"><div class="ws-big">${s.words.toLocaleString("en-US")}</div><div class="ws-cap">${t("Words")}</div></div>
        <div class="ws-goal"><div class="ws-goal-top"><span>${icon("target", 13)}${t("Word goal")}</span><span>${s.words.toLocaleString("en-US")} / ${g.toLocaleString("en-US")} · ${pct}%</span></div><div class="ws-bar"><i style="width:${pct}%"></i></div></div>
        <div class="ws-grid">${card("type", "Characters", s.chars.toLocaleString("en-US"))}${card("clock", "Reading time", minutesLabel(s.minutes))}${card("paragraph", "Paragraphs", String(x.paragraphs))}${card("heading", "Headings", String(x.headings))}${card("doc", "Sentences", String(x.sentences))}${card("image", "Images", String(x.images))}</div>
        ${x.selWords ? `<div class="ws-sel">${t("Selection")}: ${wordsLabel(x.selWords)}</div>` : ""}
        </div>`;
    };
    ctx.ui.registerSidebarPanel({ id: "word-stats", title: "Writing Stats", icon: "stats", render: (el) => { panelEl = el; paint(); return () => (panelEl = null); } });
    ctx.events.on("doc-changed", paint);
    ctx.commands.add({ id: "show", title: "Word Stats: Show counts", run: () => { const s = stats(); ctx.ui.notify(t("{words} words · {chars} chars · ~{minutes} min read", { words: s.words, chars: s.chars, minutes: s.minutes })); } });
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
