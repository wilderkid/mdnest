import type { Host, DirEntry } from "./types";
const j = async (r: Response) => { if (!r.ok) throw new Error(await r.text()); return r.json(); };
export const browserHost: Host = {
  kind: "browser",
  async pickFile() { return prompt("Path of a Markdown file (inside the dev workspace):", (await this.defaultWorkspace()) + "/sample.md"); },
  async pickFolder() { return prompt("Folder path:", (await this.defaultWorkspace()) ?? ""); },
  async pickSavePath(name = "untitled.md") { return prompt("Save as:", (await this.defaultWorkspace()) + "/" + name); },
  async readFile(path) { return (await j(await fetch("/api/read?path=" + encodeURIComponent(path)))).text; },
  async writeFile(path, text) { await j(await fetch("/api/write", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, text }) })); },
  async listDir(path): Promise<DirEntry[]> { return (await j(await fetch("/api/list?path=" + encodeURIComponent(path)))).entries; },
  async listThemes() { return (await j(await fetch("/api/themes"))).themes; },
  themeUrl(file) { return "/themes/" + file; },
  fileUrl(abs) { return "/fs" + abs; },
  async defaultWorkspace() { return (await j(await fetch("/api/workspace"))).path; },
};
