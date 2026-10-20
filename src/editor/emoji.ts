// Emoji autocomplete. Typing ":" plus two letters opens .md-emoji-suggest.
// Enter, Tab, or a click inserts the character. A finished ":smile:" converts too.
// Edit ▸ Emoji & Symbols opens the same data as a searchable grid. Off in code and math.

import { Plugin, PluginKey, EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { EMOJI } from "./emoji-data";
import { t } from "../i18n";

export const EMOJI_KEY = "mdnest.emoji";

export function emojiOn(): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(EMOJI_KEY) !== "0";
}

export function emojiChar(name: string): string | undefined {
  return EMOJI[name];
}

export function emojiMatches(query: string, limit = 12): { name: string; emoji: string }[] {
  const q = query.toLowerCase();
  if (q.length < 2) return [];
  const out: { name: string; emoji: string }[] = [];
  for (const name of Object.keys(EMOJI)) {
    if (name.startsWith(q) || name.includes(q)) {
      out.push({ name, emoji: EMOJI[name] });
      if (out.length >= limit) break;
    }
  }
  return out;
}

interface EmojiSession { colon: number; query: string; index: number }

const emojiKey = new PluginKey<{ session: EmojiSession | null }>("mdn-emoji");

function inCodeOrMath(state: EditorState): boolean {
  const { $from } = state.selection;
  if ($from.parent.type.spec.code) return true;
  const name = $from.parent.type.name;
  if (name === "code_block" || name === "math_block" || name === "inline_math") return true;
  const marks = state.storedMarks || $from.marks();
  return marks.some((m) => m.type.spec.code || m.type.name === "code");
}

function queryAfter(doc: EditorState["doc"], colon: number): string | null {
  if (colon < 0 || colon >= doc.content.size) return null;
  const $c = doc.resolve(colon);
  if (!$c.parent.isTextblock || $c.parent.type.spec.code) return null;
  const rest = $c.parent.textBetween($c.parentOffset, $c.parent.content.size);
  const m = /^:([a-z0-9_+-]*)/.exec(rest);
  if (!m) return null;
  return m[1];
}

function insertEmoji(view: EditorView, name: string, colon: number, query: string) {
  const emoji = EMOJI[name];
  if (!emoji) return;
  const from = colon;
  const to = colon + 1 + query.length;
  const tr = view.state.tr.insertText(emoji, from, to);
  const pos = from + emoji.length;
  tr.setSelection(TextSelection.create(tr.doc, pos));
  tr.setMeta(emojiKey, { session: null });
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

export function emojiPlugin() {
  return new Plugin({
    key: emojiKey,
    state: {
      init: () => ({ session: null as EmojiSession | null }),
      apply(tr, prev) {
        const meta = tr.getMeta(emojiKey) as { session: EmojiSession | null } | undefined;
        if (meta) return { session: meta.session };
        let session = prev.session;
        if (session && tr.docChanged) {
          const colon = tr.mapping.map(session.colon, -1);
          const q = queryAfter(tr.doc, colon);
          if (q == null) session = null;
          else session = { colon, query: q, index: Math.min(session.index, 11) };
        }
        if (session && tr.selectionSet && !tr.docChanged) {
          const head = tr.selection.head;
          if (head < session.colon || head > session.colon + 1 + session.query.length) session = null;
        }
        return { session };
      },
    },
    props: {
      handleTextInput(view, from, to, text) {
        if (!emojiOn() || view.composing || text.length !== 1 || from !== to) return false;
        if (inCodeOrMath(view.state)) return false;
        const $from = view.state.doc.resolve(from);
        const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 40), $from.parentOffset);
        if (text === ":") {
          const m = /:([a-z0-9_+-]{2,})$/.exec(before);
          if (m && EMOJI[m[1]]) {
            const start = from - m[0].length;
            const tr = view.state.tr.insertText(EMOJI[m[1]], start, to);
            tr.setSelection(TextSelection.create(tr.doc, start + EMOJI[m[1]].length));
            tr.setMeta(emojiKey, { session: null });
            view.dispatch(tr.scrollIntoView());
            return true;
          }
          return false;
        }
        if (!/^[a-z0-9_+-]$/i.test(text)) return false;
        const m = /:([a-z0-9_+-]*)$/.exec(before);
        if (!m) return false;
        const query = (m[1] + text).toLowerCase();
        if (query.length < 2 || !emojiMatches(query, 1).length) return false;
        // Let the editor insert the letter, then open the popup on the text that landed.
        const colon = from - m[0].length;
        queueMicrotask(() => {
          if (!view.dom.isConnected) return;
          const q = queryAfter(view.state.doc, colon);
          if (!q || q.length < 2) return;
          view.dispatch(view.state.tr.setMeta(emojiKey, { session: { colon, query: q, index: 0 } }).setMeta("addToHistory", false));
        });
        return false;
      },
      handleKeyDown(view, event) {
        const st = emojiKey.getState(view.state);
        if (!st?.session) return false;
        const shown = emojiMatches(st.session.query);
        if (event.key === "Escape") {
          event.preventDefault();
          view.dispatch(view.state.tr.setMeta(emojiKey, { session: null }).setMeta("addToHistory", false));
          return true;
        }
        if (!shown.length) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const n = shown.length;
          const next = event.key === "ArrowDown" ? (st.session.index + 1) % n : (st.session.index - 1 + n) % n;
          view.dispatch(view.state.tr.setMeta(emojiKey, { session: { ...st.session, index: next } }).setMeta("addToHistory", false));
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          const pick = shown[Math.min(st.session.index, shown.length - 1)];
          if (pick) insertEmoji(view, pick.name, st.session.colon, st.session.query);
          return true;
        }
        return false;
      },
    },
    view(editorView) {
      const menu = document.createElement("div");
      menu.className = "md-emoji-suggest";
      menu.style.display = "none";
      document.body.appendChild(menu);
      const place = () => {
        const st = emojiKey.getState(editorView.state);
        if (!st?.session || !emojiOn()) { menu.style.display = "none"; menu.innerHTML = ""; return; }
        const shown = emojiMatches(st.session.query);
        if (st.session.query.length < 2 || !shown.length) { menu.style.display = "none"; menu.innerHTML = ""; return; }
        menu.innerHTML = "";
        shown.forEach((it, i) => {
          const row = document.createElement("div");
          row.className = "md-emoji-suggest-item" + (i === st.session!.index ? " sel" : "");
          const glyph = document.createElement("span");
          glyph.className = "md-emoji-glyph";
          glyph.textContent = it.emoji;
          const name = document.createElement("span");
          name.textContent = ":" + it.name + ":";
          row.append(glyph, name);
          row.onmousedown = (e) => {
            e.preventDefault();
            const cur = emojiKey.getState(editorView.state)?.session;
            if (cur) insertEmoji(editorView, it.name, cur.colon, cur.query);
          };
          menu.appendChild(row);
        });
        const pos = Math.min(st.session.colon, editorView.state.doc.content.size);
        let box = { left: 80, bottom: 80 };
        try { box = editorView.coordsAtPos(pos); } catch { /* detached */ }
        menu.style.display = "block";
        menu.style.left = Math.max(8, box.left) + "px";
        menu.style.top = (box.bottom + 4) + "px";
      };
      return { update: place, destroy() { menu.remove(); } };
    },
  });
}

/** Searchable grid. Click inserts the character at the caret and closes. */
export function openEmojiPicker(view: EditorView): void {
  document.querySelector(".md-emoji-picker")?.remove();
  const box = document.createElement("div");
  box.className = "md-emoji-picker";
  const search = document.createElement("input");
  search.type = "text";
  search.placeholder = t("Search emoji");
  search.setAttribute("spellcheck", "false");
  const grid = document.createElement("div");
  grid.className = "md-emoji-grid";
  box.append(search, grid);
  document.body.appendChild(box);
  const rect = view.dom.getBoundingClientRect();
  box.style.left = Math.max(8, rect.left + 24) + "px";
  box.style.top = Math.max(8, rect.top + 24) + "px";
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    grid.innerHTML = "";
    let n = 0;
    for (const name of Object.keys(EMOJI)) {
      if (q && !name.includes(q)) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "md-emoji-cell";
      btn.textContent = EMOJI[name];
      btn.title = ":" + name + ":";
      btn.onmousedown = (e) => {
        e.preventDefault();
        const { from, to } = view.state.selection;
        view.dispatch(view.state.tr.insertText(EMOJI[name], from, to).scrollIntoView());
        view.focus();
        box.remove();
      };
      grid.appendChild(btn);
      if (++n >= 240) break;
    }
  };
  search.addEventListener("input", paint);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); box.remove(); view.focus(); }
  });
  paint();
  setTimeout(() => search.focus(), 0);
}
