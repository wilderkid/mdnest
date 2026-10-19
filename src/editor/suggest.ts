// Core-rendered suggestions. Pending text lives only in plugin state and decorations.
// It is written into the document in one transaction when the user accepts.
import { Plugin, PluginKey, EditorState, Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { undo } from "prosemirror-history";
import { wordDiff } from "./diff";
import { selectionMarkdown, sliceForInsert } from "./insertmd";

export type SugResult = "accepted" | "rejected" | "invalidated";
export type SugPhase = "running" | "ready" | "error";

export interface SugRecord {
  id: string;
  owner: string;
  from: number;
  to: number;
  mode: "replace" | "insert";
  text: string;
  phase: SugPhase;
  error?: string;
  label?: string;
  onRetry?: () => void;
  /** Markdown of the original range, captured when the suggestion starts. */
  originalMd: string;
  settled: ((r: SugResult) => void)[];
}

interface SugState { items: SugRecord[]; notice: string | null }

export const suggestKey = new PluginKey<SugState>("mdn-suggest");

type SugMeta =
  | { type: "add"; item: SugRecord }
  | { type: "patch"; id: string; patch: Partial<SugRecord> }
  | { type: "drop"; ids: string[]; result: SugResult }
  | { type: "notice"; text: string | null };

let seq = 0;
export function nextSugId() { return "sug-" + (++seq).toString(36); }

function overlap(a0: number, a1: number, b0: number, b1: number) {
  const aEmpty = a0 === a1, bEmpty = b0 === b1;
  if (aEmpty && bEmpty) return a0 === b0;
  if (aEmpty) return a0 >= b0 && a0 < b1;
  if (bEmpty) return b0 >= a0 && b0 < a1;
  return a0 < b1 && b0 < a1;
}

function readMeta(tr: Transaction): SugMeta | undefined {
  return tr.getMeta(suggestKey) as SugMeta | undefined;
}

export function suggestPlugin() {
  return new Plugin<SugState>({
    key: suggestKey,
    state: {
      init: (): SugState => ({ items: [], notice: null }),
      apply(tr, prev): SugState {
        const meta = readMeta(tr);
        let items = prev.items.map((it) => ({
          ...it,
          from: tr.mapping.map(it.from, -1),
          to: tr.mapping.map(it.to, 1),
          settled: it.settled,
        }));
        let notice = tr.docChanged ? null : prev.notice;
        if (meta?.type === "add") items = items.concat(meta.item);
        else if (meta?.type === "patch") items = items.map((it) => it.id === meta.id ? { ...it, ...meta.patch, settled: it.settled } : it);
        else if (meta?.type === "drop") items = items.filter((it) => !meta.ids.includes(it.id));
        else if (meta?.type === "notice") notice = meta.text;
        // A user edit that touches a suggestion invalidates it. Plugin transactions
        // (meta "plugin") and our own meta do not. No auto-rebase.
        if (tr.docChanged && tr.getMeta("plugin") == null && !meta) {
          const touched = new Map<string, SugRecord>();
          tr.steps.forEach((step) => {
            step.getMap().forEach((_newS, _newE, oldS, oldE) => {
              for (const it of prev.items) if (overlap(it.from, it.to, oldS, oldE)) touched.set(it.id, it);
            });
          });
          if (touched.size) {
            items = items.filter((it) => !touched.has(it.id));
            notice = "Suggestion discarded — the text it covered was edited";
            const list = [...touched.values()];
            queueMicrotask(() => list.forEach((it) => it.settled.forEach((cb) => { try { cb("invalidated"); } catch { /* plugin */ } })));
          }
        }
        return { items, notice };
      },
    },
    props: {
      decorations(state) {
        const st = suggestKey.getState(state);
        if (!st || (!st.items.length && !st.notice)) return null;
        const decos: Decoration[] = [];
        for (const it of st.items) {
          if (it.mode === "replace" && it.to > it.from && it.text) {
            decos.push(Decoration.inline(it.from, it.to, { class: "md-sug-del" }));
          }
          const at = Math.max(0, Math.min(it.to, state.doc.content.size));
          decos.push(Decoration.widget(at, (view) => widget(view, it), { side: 1, ignoreSelection: true, key: it.id }));
        }
        if (st.notice) {
          const pos = Math.max(0, Math.min(state.selection.from, state.doc.content.size));
          decos.push(Decoration.widget(pos, () => {
            const el = document.createElement("div");
            el.className = "md-sug-notice";
            el.textContent = st.notice!;
            return el;
          }, { side: -1, ignoreSelection: true, key: "notice" }));
        }
        return DecorationSet.create(state.doc, decos);
      },
      handleKeyDown(view, event) {
        const st = suggestKey.getState(view.state);
        if (!st?.items.length) return false;
        const head = st.items[st.items.length - 1];
        if (event.key === "Escape") { event.preventDefault(); settle(view, head, "rejected"); return true; }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
          event.preventDefault();
          accept(view, head);
          return true;
        }
        return false;
      },
    },
  });
}

function widget(view: EditorView, it: SugRecord) {
  const el = document.createElement("span");
  el.className = "md-sug";
  el.contentEditable = "false";
  const diff = document.createElement("span");
  diff.className = "md-sug-diff";
  if (it.phase === "error" && !it.text) {
    diff.appendChild(span("md-sug-err", it.error || "failed"));
  } else {
    for (const op of wordDiff(it.originalMd, it.text)) {
      if (op.op === "eq") diff.appendChild(document.createTextNode(op.text));
      else diff.appendChild(span(op.op === "ins" ? "md-sug-ins" : "md-sug-old", op.text));
    }
    if (it.phase === "running") diff.appendChild(span("md-sug-caret", ""));
  }
  el.appendChild(diff);
  const bar = document.createElement("span");
  bar.className = "md-sug-bar";
  const status = document.createElement("span");
  status.className = "md-sug-status";
  status.textContent = it.phase === "running" ? "generating…" : it.phase === "error" ? (it.error || "error") : (it.label || "suggestion");
  bar.appendChild(status);
  if (it.phase !== "running") {
    bar.appendChild(button("Accept", () => accept(view, current(view, it.id) ?? it)));
    bar.appendChild(button("Reject", () => { const c = current(view, it.id); if (c) settle(view, c, "rejected"); }));
    if (it.onRetry) bar.appendChild(button("Retry", () => (current(view, it.id) ?? it).onRetry?.()));
  }
  el.appendChild(bar);
  return el;
}

function span(cls: string, text: string) {
  const s = document.createElement("span");
  s.className = cls;
  if (cls === "md-sug-caret") s.setAttribute("aria-hidden", "true");
  else s.textContent = text;
  return s;
}
function button(label: string, fn: () => void) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.onmousedown = (e) => { e.preventDefault(); fn(); };
  return b;
}
function current(view: EditorView, id: string) {
  return suggestKey.getState(view.state)?.items.find((it) => it.id === id);
}

function settle(view: EditorView, it: SugRecord, result: SugResult) {
  const live = current(view, it.id) ?? it;
  view.dispatch(view.state.tr.setMeta(suggestKey, { type: "drop", ids: [live.id], result } satisfies SugMeta));
  live.settled.forEach((cb) => { try { cb(result); } catch { /* plugin */ } });
}

/** Replace the mapped range with the parsed suggestion. One transaction, one undo step. */
export function accept(view: EditorView, it: SugRecord) {
  const live = current(view, it.id);
  if (!live) return false;
  if (!live.text && live.phase !== "ready") return false;
  const slice = sliceForInsert(live.text, view.state, live.from, live.to);
  const tr = view.state.tr.replaceRange(live.from, live.to, slice);
  tr.setMeta("plugin", live.owner);
  tr.setMeta(suggestKey, { type: "drop", ids: [live.id], result: "accepted" } satisfies SugMeta);
  tr.scrollIntoView();
  view.dispatch(tr);
  live.settled.forEach((cb) => { try { cb("accepted"); } catch { /* plugin */ } });
  return true;
}

/** Build the accept transaction without a view. Tests apply it, then undo once. */
export function acceptTransaction(state: EditorState, it: SugRecord): Transaction | null {
  const live = suggestKey.getState(state)?.items.find((x) => x.id === it.id);
  if (!live || (!live.text && live.phase !== "ready")) return null;
  const slice = sliceForInsert(live.text, state, live.from, live.to);
  const tr = state.tr.replaceRange(live.from, live.to, slice);
  tr.setMeta("plugin", live.owner);
  tr.setMeta(suggestKey, { type: "drop", ids: [live.id], result: "accepted" } satisfies SugMeta);
  return tr;
}

export function cancelAll(view: EditorView, result: SugResult = "rejected") {
  const items = suggestKey.getState(view.state)?.items ?? [];
  if (!items.length) return;
  view.dispatch(view.state.tr.setMeta(suggestKey, { type: "drop", ids: items.map((it) => it.id), result } satisfies SugMeta));
  for (const it of items) it.settled.forEach((cb) => { try { cb(result); } catch { /* plugin */ } });
}

export function addSuggestion(view: EditorView, item: SugRecord) {
  view.dispatch(view.state.tr.setMeta(suggestKey, { type: "add", item } satisfies SugMeta).setMeta("addToHistory", false));
}

export function patchSuggestion(view: EditorView, id: string, patch: Partial<SugRecord>) {
  view.dispatch(view.state.tr.setMeta(suggestKey, { type: "patch", id, patch } satisfies SugMeta).setMeta("addToHistory", false));
}

export function suggestionItems(state: EditorState): SugRecord[] {
  return suggestKey.getState(state)?.items ?? [];
}

export function beginRecord(state: EditorState, spec: {
  id?: string; owner: string; from: number; to: number; mode: "replace" | "insert"; label?: string; onRetry?: () => void;
}): SugRecord {
  const from = spec.from, to = spec.to;
  return {
    id: spec.id ?? nextSugId(),
    owner: spec.owner,
    from, to,
    mode: spec.mode,
    text: "",
    phase: "running",
    label: spec.label,
    onRetry: spec.onRetry,
    originalMd: spec.mode === "replace" ? selectionMarkdown(state, from, to) : "",
    settled: [],
  };
}

export function addMeta(item: SugRecord): SugMeta { return { type: "add", item }; }
export function patchMeta(id: string, patch: Partial<SugRecord>): SugMeta { return { type: "patch", id, patch }; }

export function undoOnce(view: EditorView) {
  return undo(view.state, view.dispatch);
}
