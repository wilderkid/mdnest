// Map a 1-based source line of a Markdown file to a document position (citation jump-back).
// Top-level markdown-it block tokens carry source line maps; top-level document nodes follow the
// same order. When the counts disagree (unusual extensions), fall back to matching the line text.
import type { Node as PMNode } from "prosemirror-model";
import { md } from "./markdown";

function topLevelMaps(src: string): [number, number][] {
  const toks = md.parse(src.replace(/\r\n/g, "\n"), {});
  const maps: [number, number][] = [];
  for (const t of toks) {
    if (t.level !== 0 || !t.map) continue;
    if (t.nesting === -1) continue;
    if (t.type === "front_matter" || t.type === "frontmatter") continue;
    maps.push([t.map[0], t.map[1]]);
  }
  return maps;
}

const plain = (s: string) => s.replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*)/, "").replace(/[*_`~=[\]()!<>#|\\]/g, "").replace(/\s+/g, " ").trim();

/** Position at the start of the top-level block containing `line` (1-based), or null. */
export function blockPosForLine(doc: PMNode, src: string, line: number): { pos: number; index: number } | null {
  const l0 = Math.max(0, line - 1);
  const maps = topLevelMaps(src);
  const offsets: number[] = [];
  doc.forEach((_n, off) => offsets.push(off));
  if (maps.length === offsets.length && maps.length) {
    let i = maps.findIndex(([a, b]) => l0 >= a && l0 < b);
    if (i < 0) i = maps.findIndex(([a]) => a >= l0);
    if (i < 0) i = maps.length - 1;
    return { pos: offsets[i], index: i };
  }
  // fallback: first block whose text contains the (marker-stripped) source line
  const lines = src.split("\n");
  for (let k = l0; k < Math.min(lines.length, l0 + 8); k++) {
    const want = plain(lines[k] ?? "").slice(0, 60);
    if (!want) continue;
    let found: { pos: number; index: number } | null = null;
    doc.forEach((n, off, i) => { if (!found && n.textContent.replace(/\s+/g, " ").includes(want)) found = { pos: off, index: i }; });
    if (found) return found;
  }
  return null;
}
