import type { Host, DirEntry, StreamEvent, StreamRequest } from "./types";
const j = async (r: Response) => { if (!r.ok) throw new Error(await r.text()); return r.json(); };
export const browserHost: Host = {
  kind: "browser",
  async pickFile() { return prompt("Path of a Markdown file (inside the dev workspace):", (await this.defaultWorkspace()) + "/sample.md"); },
  async pickFolder() { return prompt("Folder path:", (await this.defaultWorkspace()) ?? ""); },
  async pickSavePath(name = "untitled.md", _ext?: string) { return prompt("Save as:", (await this.defaultWorkspace()) + "/" + name); },
  async readFile(path) { return (await j(await fetch("/api/read?path=" + encodeURIComponent(path)))).text; },
  async writeFile(path, text) { await j(await fetch("/api/write", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, text }) })); },
  async listDir(path): Promise<DirEntry[]> { return (await j(await fetch("/api/list?path=" + encodeURIComponent(path)))).entries; },
  async listThemes() { return (await j(await fetch("/api/themes"))).themes; },
  themeUrl(file) { return "/themes/" + file; },
  fileUrl(abs) { return "/fs" + abs; },
  async cliFile() { return null; },
  async cliArgs() { return []; },
  async copyFile(src, dest, unique) { // dev server: only inside the sandboxed workspace
    const r = await fetch("/fs" + src); if (!r.ok) throw new Error("cannot read " + src);
    const b = new Uint8Array(await r.arrayBuffer()); let bin = ""; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return this.writeBinary(dest, btoa(bin), unique);
  },
  async writeBinary(path, data, unique) { return (await j(await fetch("/api/writeb", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, data, unique }) }))).path; },
  async mtime(path) { return (await j(await fetch("/api/mtime?path=" + encodeURIComponent(path)))).mtime; },
  async exportPdf() { throw new Error("unsupported"); },
  async quit() { window.close(); },
  async defaultWorkspace() { return (await j(await fetch("/api/workspace"))).path; },
  secrets: {
    async set(id, value) {
      await j(await fetch("/api/secret/set", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, value }) }));
    },
    async has(id) {
      return (await j(await fetch("/api/secret/has?id=" + encodeURIComponent(id)))).has;
    },
    async delete(id) {
      await j(await fetch("/api/secret/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }));
    },
    async backend() {
      return (await j(await fetch("/api/secret/backend"))).backend;
    },
  },
  net: {
    stream(req: StreamRequest, onEvent: (ev: StreamEvent) => void) {
      const id = streamId();
      const ac = new AbortController();
      let cancelled = false;
      const pump = (async () => {
        const res = await fetch("/api/net/stream", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, req }),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          const message = await res.text().catch(() => res.statusText);
          onEvent({ type: "error", status: res.status, message });
          onEvent({ type: "done" });
          return;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            onEvent(JSON.parse(line) as StreamEvent);
          }
        }
        const tail = buf.trim();
        if (tail) onEvent(JSON.parse(tail) as StreamEvent);
      })();
      pump.catch((e) => {
        if (cancelled || (e && (e as any).name === "AbortError")) {
          onEvent({ type: "done" });
          return;
        }
        onEvent({ type: "error", message: String((e as any)?.message ?? e) });
        onEvent({ type: "done" });
      });
      return {
        cancel() {
          if (cancelled) return;
          cancelled = true;
          ac.abort();
          void fetch("/api/net/cancel", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id }),
          });
        },
      };
    },
  },
};

function streamId(): string {
  const rnd = Math.random().toString(36).slice(2, 10);
  return `s${Date.now().toString(36)}${rnd}`;
}
