import { readFileSync } from "node:fs";
import { parseMarkdown, serializeMarkdown } from "../src/editor/markdown";
const files = process.argv.slice(2);
let fail = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const once = serializeMarkdown(parseMarkdown(src));
  const twice = serializeMarkdown(parseMarkdown(once));
  const stable = once === twice;
  if (!stable) fail++;
  console.log(`${f}: idempotent=${stable} identical=${once === src}`);
  if (process.env.SHOW) console.log(once);
  if (!stable) console.log("--- once ---\n" + once + "\n--- twice ---\n" + twice);
}
process.exit(fail ? 1 : 0);
