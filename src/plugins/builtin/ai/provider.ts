import { parseUsage, type Usage } from "./usage";
// OpenAI-compatible chat provider. Talks only through the plugin net/secrets API.
// The API key is named by secretRef and never appears in a request body or an error string.
import type { PluginContext } from "../../api";
import type { StreamEvent } from "../../../host/types";

export type PresetId = "relay" | "openai" | "ollama" | "custom";

export interface PresetDefaults {
  baseUrl: string;
  model: string;
  /** Ollama's local endpoint does not need a key. */
  needsKey: boolean;
}

export const PRESETS: Record<Exclude<PresetId, "custom">, PresetDefaults> = {
  relay: { baseUrl: "https://your-relay.example.com/v1", model: "grok-4.7", needsKey: true },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", needsKey: true },
  ollama: { baseUrl: "http://localhost:11434/v1", model: "llama3.1", needsKey: false },
};

export const PRESET_IDS: PresetId[] = ["relay", "openai", "ollama", "custom"];

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOpts {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ProviderInfo {
  preset: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
}

export interface AiProvider {
  chatStream(messages: ChatMessage[], opts?: ChatOpts): AsyncIterable<string>;
  complete(messages: ChatMessage[], opts?: ChatOpts): Promise<string>;
  info(): ProviderInfo;
  /** "Today: N requests · M tokens (limit …)" */
  usageSummary(): string;
}

export function presetOf(raw: unknown): PresetId {
  return PRESET_IDS.includes(raw as PresetId) ? (raw as PresetId) : "relay";
}

export function defaultsFor(preset: PresetId): PresetDefaults | null {
  if (preset === "custom") return null;
  return PRESETS[preset];
}

/** Fill baseUrl/model from a preset when they are empty or still the previous preset's defaults. */
export function applyPresetChange(
  next: PresetId,
  prev: PresetId,
  baseUrl: string,
  model: string,
): { baseUrl?: string; model?: string } {
  const d = defaultsFor(next);
  if (!d) return {};
  const prevD = defaultsFor(prev);
  const out: { baseUrl?: string; model?: string } = {};
  const url = baseUrl.trim();
  const m = model.trim();
  if (!url || (prevD && url === prevD.baseUrl)) out.baseUrl = d.baseUrl;
  if (!m || (prevD && m === prevD.model)) out.model = d.model;
  return out;
}

function hostOf(url: string): string {
  try { return new URL(url).host || url; } catch { return url; }
}

function hostnameOf(url: string): string | null {
  try { return new URL(url).hostname; } catch { return null; }
}

/** True for localhost, ::1, and RFC1918 / link-local IPv4. Hostnames other than localhost are remote. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [+m[1], +m[2]];
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

export function localOnlyAllows(url: string): boolean {
  const host = hostnameOf(url);
  if (!host) return false;
  return isLocalHost(host);
}

/** Map an HTTP status or a transport failure to a short message. Never includes a secret. */
export function mapStreamError(status: number | undefined, message: string, url: string): string {
  if (status === 401 || status === 403) return "API key rejected";
  if (status === 404) return "model or URL not found";
  const host = hostOf(url);
  const lower = message.toLowerCase();
  const network =
    status == null ||
    /failed to fetch|network|econnrefused|enotfound|econnreset|etimedout|timed out|timeout|connection refused|dns|unable to connect|socket|abort/.test(lower);
  if (network && status == null) return `cannot reach ${host}`;
  if (status != null && status >= 400) {
    const brief = message.replace(/\s+/g, " ").trim().slice(0, 180);
    return brief ? `HTTP ${status}: ${brief}` : `HTTP ${status}`;
  }
  return message.replace(/\s+/g, " ").trim().slice(0, 180) || "request failed";
}

/** Pull assistant text from one SSE `data` payload. Role-only deltas and [DONE] yield "". */
export function parseDelta(data: string): string {
  const raw = data.trim();
  if (!raw || raw === "[DONE]") return "";
  let json: any;
  try { json = JSON.parse(raw); } catch { return ""; }
  const choice = json?.choices?.[0];
  if (!choice) return "";
  const delta = choice.delta;
  if (delta && typeof delta === "object") {
    if (typeof delta.content === "string") return delta.content;
    return "";
  }
  if (typeof choice.text === "string") return choice.text;
  if (typeof choice.message?.content === "string") return choice.message.content;
  return "";
}

type StreamFn = PluginContext["net"]["stream"];

export interface ProviderDeps {
  stream: StreamFn;
  hasSecret: () => Promise<boolean>;
  enabled: () => boolean;
  preset: () => PresetId;
  baseUrl: () => string;
  model: () => string;
  temperature: () => number;
  maxTokens: () => number;
  localOnly: () => boolean;
  /** usage counters / daily limits (optional so tests can omit it) */
  usage?: import("./usage").UsageTracker;
  /** secretRef passed to ctx.net. Omitted when there is no stored key and the preset is ollama. */
  secretKey: string;
}

function chatUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  return trimmed + "/chat/completions";
}

export function createProvider(deps: ProviderDeps): AiProvider {
  function assertEnabled() {
    if (!deps.enabled()) throw new Error("AI is disabled");
  }
  function assertLocal(url: string) {
    if (deps.localOnly() && !localOnlyAllows(url)) {
      throw new Error("local-only mode refuses " + hostOf(url));
    }
  }

  function chatStream(messages: ChatMessage[], opts: ChatOpts = {}): AsyncIterable<string> {
    assertEnabled();
    const base = deps.baseUrl().trim();
    if (!base) throw new Error("model or URL not found");
    assertLocal(base);
    const url = chatUrl(base);
    return {
      async *[Symbol.asyncIterator]() {
        const hasKey = await deps.hasSecret();
        const body = JSON.stringify({
          model: opts.model || deps.model() || "gpt-4o-mini",
          messages,
          temperature: opts.temperature ?? deps.temperature(),
          max_tokens: opts.maxTokens ?? deps.maxTokens(),
          stream: true,
          stream_options: { include_usage: true },
        });
        deps.usage?.check();
        const promptChars = messages.reduce((n, m) => n + String(m.content ?? "").length, 0);
        let outChars = 0;
        let usage: Usage | null = null;
        let recorded = false;
        const record = () => { if (!recorded) { recorded = true; deps.usage?.record(usage, promptChars, outChars); } };
        const req: Parameters<StreamFn>[0] = {
          url,
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/event-stream" },
          body,
        };
        // A stored key is attached by the host via secretRef. Ollama with no key sends none,
        // so the host does not fail on an unknown ref. Other presets without a key still omit
        // it; the provider answers 401 and that maps to "API key rejected".
        if (hasKey) req.secretRef = deps.secretKey;

        const queue: string[] = [];
        let wake: (() => void) | null = null;
        let finished = false;
        let failure: Error | null = null;
        const signal = opts.signal;
        const kick = () => { const w = wake; wake = null; w?.(); };

        const handle = deps.stream(req, (ev: StreamEvent) => {
          if (signal?.aborted) return;
          if (ev.type === "data") {
            const text = parseDelta(ev.data);
            if (text) { outChars += text.length; queue.push(text); kick(); }
            usage = parseUsage(ev.data) ?? usage;
            return;
          }
          if (ev.type === "error") {
            failure = new Error(mapStreamError(ev.status, ev.message, url));
            finished = true;
            kick();
            return;
          }
          if (ev.type === "done") {
            finished = true;
            kick();
          }
        });

        const onAbort = () => {
          handle.cancel();
          failure = new Error("cancelled");
          finished = true;
          kick();
        };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }

        try {
          for (;;) {
            if (queue.length) { yield queue.shift()!; continue; }
            if (failure) throw failure;
            if (finished) return;
            await new Promise<void>((resolve) => { wake = resolve; });
          }
        } finally {
          record();
          signal?.removeEventListener("abort", onAbort);
          // The iterator always ends here, including a normal finish. Cancelling then
          // aborts the host request and makes a completed call look like a client cancel.
          if (signal?.aborted || failure) handle.cancel();
        }
      },
    };
  }

  return {
    chatStream,
    async complete(messages, opts) {
      let out = "";
      for await (const part of chatStream(messages, opts)) out += part;
      return out;
    },
    usageSummary: () => deps.usage?.summary() ?? "",
    info() {
      return {
        preset: deps.preset(),
        baseUrl: deps.baseUrl().trim(),
        model: deps.model().trim(),
        enabled: deps.enabled(),
      };
    },
  };
}
