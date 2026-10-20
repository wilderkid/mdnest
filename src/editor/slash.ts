// Slash menu. Typing "/" at the start of an empty paragraph (WYSIWYG) opens a filterable list.
// Running an item deletes the "/query" text, then calls the item with the cursor position.
import { Plugin, PluginKey, EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { t, lang } from "../i18n";

export interface SlashItem {
  id: string;
  title: string;
  hint?: string;
  owner: string;
  /** extra search terms (any language), e.g. Chinese names and pinyin initials */
  keywords?: string;
  run: (ctx: { from: number; to: number; query: string }) => void;
}

export interface SlashSession {
  /** Position of the "/" that opened the menu. */
  slash: number;
  query: string;
  index: number;
}

interface SlashState { items: SlashItem[]; session: SlashSession | null }

export const slashKey = new PluginKey<SlashState>("mdn-slash");

type SlashMeta =
  | { type: "register"; item: SlashItem }
  | { type: "session"; session: SlashSession | null }
  | { type: "index"; index: number };

function blockedParent(state: EditorState, pos: number) {
  const $p = state.doc.resolve(pos);
  for (let d = $p.depth; d > 0; d--) {
    const n = $p.node(d);
    if (n.type.spec.code || n.type.name === "code_block" || n.type.name === "math_block" || n.type.name === "inline_math") return true;
  }
  return false;
}

/** "/" at the start of an otherwise empty paragraph, not inside code or math. */
export function slashOpenAt(state: EditorState, from: number, to: number, text: string): number | null {
  if (text !== "/" || from !== to) return null;
  const $p = state.doc.resolve(from);
  if (!$p.parent.isTextblock || $p.parent.type.spec.code) return null;
  if ($p.parent.type.name !== "paragraph") return null;
  if ($p.parentOffset !== 0 || $p.parent.content.size !== 0) return null;
  if (blockedParent(state, from)) return null;
  return from;
}

export function slashPlugin() {
  return new Plugin<SlashState>({
    key: slashKey,
    state: {
      init: (): SlashState => ({ items: [], session: null }),
      apply(tr, prev): SlashState {
        const meta = tr.getMeta(slashKey) as SlashMeta | undefined;
        let items = prev.items;
        let session = prev.session;
        if (meta?.type === "register") {
          items = items.filter((it) => it.id !== meta.item.id).concat(meta.item);
        } else if (meta?.type === "session") session = meta.session;
        else if (meta?.type === "index") { if (session) session = { ...session, index: meta.index }; }
        if (session && tr.docChanged && meta?.type !== "session") {
          const slash = tr.mapping.map(session.slash, -1);
          const q2 = queryInDoc(tr.doc, slash);
          if (q2 == null) session = null;
          else session = { slash, query: q2, index: Math.min(session.index, Math.max(0, filterItems(items, q2).length - 1)) };
        }
        if (session && !tr.docChanged && tr.selectionSet && meta?.type !== "session" && meta?.type !== "index") {
          const head = tr.selection.head;
          if (head < session.slash || head > session.slash + 1 + session.query.length) session = null;
        }
        return { items, session };
      },
    },
    props: {
      handleTextInput(view, from, to, text) {
        if (view.composing) return false;
        if (view.editable === false) return false;
        const at = slashOpenAt(view.state, from, to, text);
        if (at == null) return false;
        const tr = view.state.tr.insertText("/", from, to);
        tr.setSelection(TextSelection.create(tr.doc, from + 1));
        tr.setMeta(slashKey, { type: "session", session: { slash: from, query: "", index: 0 } } satisfies SlashMeta);
        view.dispatch(tr);
        return true;
      },
      handleKeyDown(view, event) {
        if (view.composing) return false;
        const st = slashKey.getState(view.state);
        if (!st?.session) return false;
        const shown = filterItems(st.items, st.session.query);
        if (event.key === "Escape") {
          event.preventDefault();
          close(view);
          return true;
        }
        if (!shown.length && (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === "Tab")) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const n = shown.length;
          const next = event.key === "ArrowDown" ? (st.session.index + 1) % n : (st.session.index - 1 + n) % n;
          view.dispatch(view.state.tr.setMeta(slashKey, { type: "index", index: next } satisfies SlashMeta).setMeta("addToHistory", false));
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          const item = shown[Math.min(st.session.index, shown.length - 1)];
          if (item) runItem(view, item);
          return true;
        }
        return false;
      },
    },
    view(editorView) {
      const menu = document.createElement("div");
      menu.className = "mdn-slash";
      menu.style.display = "none";
      document.body.appendChild(menu);
      let lastKey = "";
      const place = () => {
        const st = slashKey.getState(editorView.state);
        if (!st?.session || !editorView.hasFocus()) { menu.style.display = "none"; menu.innerHTML = ""; lastKey = ""; return; }
        const shown = filterItems(st.items, st.session.query);
        const key = st.session.slash + "|" + st.session.query + "|" + shown.map((i) => i.id).join(",");
        if (key === lastKey) {
          // only the highlighted row moved: restyle and keep it scrolled into view (no rebuild → no scroll reset)
          menu.querySelectorAll<HTMLElement>(".mdn-slash-item").forEach((r, i) => r.classList.toggle("sel", i === st.session!.index));
          keepVisible(menu);
          return;
        }
        lastKey = key;
        menu.innerHTML = "";
        if (!shown.length) {
          const empty = document.createElement("div");
          empty.className = "mdn-slash-empty";
          empty.textContent = t(st.items.length ? "No matches" : "No slash commands");
          menu.appendChild(empty);
        } else {
          shown.forEach((it, i) => {
            const row = document.createElement("div");
            row.className = "mdn-slash-item" + (i === st.session!.index ? " sel" : "");
            const title = document.createElement("span");
            title.textContent = t(it.title);
            row.appendChild(title);
            row.dataset.id = it.id;
            const hintText = slashHint(it);
            if (hintText) {
              const hint = document.createElement("small");
              hint.textContent = hintText;
              row.appendChild(hint);
            }
            row.onmousedown = (e) => { e.preventDefault(); runItem(editorView, it); };
            menu.appendChild(row);
          });
        }
        const pos = Math.min(st.session.slash, editorView.state.doc.content.size);
        const box = editorView.coordsAtPos(pos);
        menu.style.display = "block";
        menu.style.left = Math.max(8, box.left) + "px";
        menu.style.top = (box.bottom + 4) + "px";
        menu.scrollTop = 0;
        keepVisible(menu);
      };
      return {
        update: place,
        destroy() { menu.remove(); },
      };
    },
  });
}

/** scroll the menu so the highlighted row is fully visible */
function keepVisible(menu: HTMLElement) {
  const row = menu.querySelector<HTMLElement>(".mdn-slash-item.sel");
  if (!row) return;
  const top = row.offsetTop, bottom = top + row.offsetHeight;
  if (top < menu.scrollTop) menu.scrollTop = top - 4;
  else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight + 4;
}

function queryInDoc(doc: EditorState["doc"], slash: number): string | null {
  if (slash < 0 || slash > doc.content.size) return null;
  const $p = doc.resolve(slash);
  if (!$p.parent.isTextblock || $p.parent.type.name !== "paragraph" || $p.parent.type.spec.code) return null;
  if ($p.start() !== slash) return null;
  const text = $p.parent.textBetween(0, $p.parent.content.size);
  if (!text.startsWith("/")) return null;
  if (text.includes("\n")) return null;
  return text.slice(1);
}

/** Chinese search terms + pinyin initials for the core items (English titles/ids/hints always match too) */
const ZH_KEYWORDS: Record<string, string> = {
  h1: "一级标题 标题 bt yjbt", h2: "二级标题 标题 bt ejbt", h3: "三级标题 标题 bt sjbt", h4: "四级标题 标题 bt", h5: "五级标题 标题 bt", h6: "六级标题 标题 bt",
  paragraph: "段落 正文 dl zw", bullet: "无序列表 列表 项目符号 wxlb lb", numbered: "有序列表 编号 列表 yxlb lb", task: "任务列表 待办 复选框 rwlb db",
  quote: "引用 块引用 yy", table: "表格 bg", code: "代码块 代码 dmk dm", math: "公式块 数学 公式 gsk sx gs", mermaid: "图表 流程图 mermaid tb lct",
  html: "HTML 块 网页 html", hr: "分割线 水平线 fgx spx", toc: "目录 mulu ml", footnote: "脚注 jz", linkref: "链接引用 引用链接 ljyy",
  image: "图片 插入图片 tp", link: "链接 超链接 lj clj", frontmatter: "元数据 前言 yaml ysj", alert: "提示 标注 警告 callout ts bz",
};
/** the words a slash item can be found by: English title/id/hint, the localized title and Chinese keywords */
export function slashSearchText(it: SlashItem): string {
  return [it.title, t(it.title), it.id, it.hint ?? "", it.keywords ?? "", ZH_KEYWORDS[it.id] ?? ""].join(" ").toLowerCase();
}
export function filterItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice();
  const words = q.split(/\s+/);
  return items.filter((it) => { const hay = slashSearchText(it); return words.every((w) => hay.includes(w)); });
}
/** the hint shown under an item: Chinese keywords in the Chinese UI, the English hint otherwise */
export function slashHint(it: SlashItem): string {
  if (lang() === "zh-CN") {
    // Chinese synonyms that are not already the visible title, plus the English command word
    const title = t(it.title);
    const zh = (ZH_KEYWORDS[it.id] ?? "").split(" ").filter((w) => /[\u4e00-\u9fff]/.test(w) && !title.includes(w));
    const en = (it.hint ?? "").split(" ")[0] ?? "";
    return [...zh.slice(0, 2), en].filter(Boolean).join(" · ");
  }
  return it.hint ?? "";
}

function close(view: EditorView) {
  view.dispatch(view.state.tr.setMeta(slashKey, { type: "session", session: null } satisfies SlashMeta).setMeta("addToHistory", false));
}

function runItem(view: EditorView, item: SlashItem) {
  const st = slashKey.getState(view.state);
  if (!st?.session) return;
  const slash = st.session.slash;
  const query = st.session.query;
  const end = slash + 1 + query.length;
  const tr = view.state.tr.delete(slash, Math.min(end, view.state.doc.content.size));
  const pos = tr.mapping.map(slash);
  tr.setSelection(TextSelection.create(tr.doc, pos));
  tr.setMeta("plugin", item.owner);
  tr.setMeta(slashKey, { type: "session", session: null } satisfies SlashMeta);
  view.dispatch(tr);
  try { item.run({ from: pos, to: pos, query }); }
  catch (e) { console.error(e); }
}

export function registerSlashItem(view: EditorView, item: SlashItem) {
  view.dispatch(view.state.tr.setMeta(slashKey, { type: "register", item } satisfies SlashMeta).setMeta("addToHistory", false));
}

/** Register without a view (tests / state.apply). */
export function slashItems(state: EditorState): SlashItem[] {
  return slashKey.getState(state)?.items ?? [];
}


