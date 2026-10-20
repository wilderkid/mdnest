import { t } from "../../../i18n";
// Per-day usage counters (requests, tokens) and optional daily limits. Local only, no telemetry.
// Token counts come from the provider's `usage` field (OpenAI `stream_options.include_usage`);
// when a provider sends none, they are estimated (~4 chars per token) and flagged as estimates.

export interface DayUsage { requests: number; prompt: number; completion: number; estimated: boolean }
export type UsageLog = Record<string, DayUsage>;
export interface Usage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }

export interface UsageDeps {
  load(): UsageLog | undefined;
  save(log: UsageLog): void;
  requestLimit(): number;
  tokenLimit(): number;
  now?: () => Date;
}

export const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

/** usage object from one SSE data chunk (usually the final one), or null */
export function parseUsage(data: string): Usage | null {
  const raw = data.trim();
  if (!raw || raw[0] !== "{") return null;
  try {
    const u = JSON.parse(raw)?.usage;
    if (u && typeof u === "object" && (typeof u.prompt_tokens === "number" || typeof u.completion_tokens === "number" || typeof u.total_tokens === "number")) return u;
  } catch { /* not JSON */ }
  return null;
}

export function createUsage(deps: UsageDeps) {
  const today = () => dayKey(deps.now?.() ?? new Date());
  const read = (): UsageLog => ({ ...(deps.load() ?? {}) });
  const day = (log: UsageLog, k = today()): DayUsage => log[k] ?? { requests: 0, prompt: 0, completion: 0, estimated: false };
  const write = (log: UsageLog) => {
    const keys = Object.keys(log).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 30))) delete log[k]; // keep 30 days
    deps.save(log);
  };
  return {
    today: (): DayUsage => day(read()),
    /** Throws when a daily limit is reached. Call before sending. */
    check() {
      const d = day(read());
      const rl = deps.requestLimit(), tl = deps.tokenLimit();
      if (rl > 0 && d.requests >= rl) throw new Error(`Daily AI limit reached (${rl} requests). Change it in Settings → AI.`);
      if (tl > 0 && d.prompt + d.completion >= tl) throw new Error(`Daily AI limit reached (${tl} tokens). Change it in Settings → AI.`);
    },
    /** Record one finished (or failed) request. */
    record(u: Usage | null, promptChars: number, completionChars: number) {
      const log = read(), k = today(), d = { ...day(log, k) };
      d.requests++;
      if (u && (u.prompt_tokens != null || u.completion_tokens != null)) {
        d.prompt += u.prompt_tokens ?? 0;
        d.completion += u.completion_tokens ?? 0;
      } else if (u?.total_tokens != null) {
        d.prompt += u.total_tokens;
      } else {
        d.prompt += estimateTokens(promptChars);
        d.completion += estimateTokens(completionChars);
        d.estimated = true;
      }
      log[k] = d;
      write(log);
    },
    summary(): string {
      const d = day(read());
      const tokens = d.prompt + d.completion;
      const rl = deps.requestLimit(), tl = deps.tokenLimit();
      const lim = [rl > 0 ? t("{n} req", { n: rl }) : "", tl > 0 ? t("{n} tok", { n: tl }) : ""].filter(Boolean).join(", ");
      return t(d.requests === 1 ? "Today: {n} request · {approx}{tokens} tokens" : "Today: {n} requests · {approx}{tokens} tokens", { n: d.requests, approx: d.estimated ? "≈" : "", tokens })
        + (lim ? t(" (limit {limit})", { limit: lim }) : "");
    },
  };
}
export type UsageTracker = ReturnType<typeof createUsage>;
