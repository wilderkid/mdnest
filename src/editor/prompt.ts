// Small floating input near the cursor or an anchor position. Enter resolves the text; Escape resolves null.
import type { EditorView } from "prosemirror-view";

export interface PromptOpts {
  placeholder?: string;
  /** Document position to anchor near. Defaults to the selection head. */
  anchor?: number;
  value?: string;
}

export function openPrompt(view: EditorView, opts: PromptOpts): Promise<string | null> {
  document.querySelector(".mdn-prompt")?.remove();
  return new Promise((resolve) => {
    const box = document.createElement("div");
    box.className = "mdn-prompt";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = opts.placeholder ?? "";
    input.value = opts.value ?? "";
    box.appendChild(input);
    document.body.appendChild(box);
    const pos = opts.anchor != null ? Math.max(0, Math.min(opts.anchor, view.state.doc.content.size)) : view.state.selection.head;
    let coords = { left: 80, bottom: 80 };
    try { coords = view.coordsAtPos(pos); } catch { /* detached view */ }
    box.style.left = Math.max(8, coords.left) + "px";
    box.style.top = (coords.bottom + 6) + "px";
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      box.remove();
      resolve(v);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); finish(input.value); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(null); }
    });
    input.addEventListener("blur", () => setTimeout(() => finish(null), 120));
    input.focus();
    input.select();
  });
}
