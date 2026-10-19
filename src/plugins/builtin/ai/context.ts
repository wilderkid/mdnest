// Document snippet for the chat panel. Kept out of runtime.ts so the panel chunk
// does not import the action runner (and the runner does not import the panel).
import type { PluginContext } from "../../api";
import { isExcluded, parseExclude } from "./exclude";
import { aroundCursor, cursorOffset } from "./prompts";

export function docSnippet(ctx: PluginContext): { text: string; selection: string } | null {
  const path = ctx.editor.getFilePath();
  const patterns = parseExclude(String(ctx.settings.get("exclude") ?? ""));
  if (isExcluded(path, patterns)) return null;
  const md = ctx.editor.getDocMarkdown();
  const selection = ctx.editor.getSelectionMarkdown();
  const before = ctx.editor.getContext({ before: 8, after: 0 });
  return { text: aroundCursor(md, cursorOffset(md, selection, before)), selection };
}
