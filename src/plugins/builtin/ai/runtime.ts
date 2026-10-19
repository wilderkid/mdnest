// Loaded only after AI is enabled. Selection actions, /ai, and the chat panel.
import type { PluginContext, SuggestionHandle } from "../../api";
import { isExcluded, parseExclude } from "./exclude";
import {
  actionInstruction, stripFence, systemPrompt, userPrompt,
} from "./prompts";
import type { AiProvider, ChatMessage } from "./provider";

export function mountChat(el: HTMLElement, ctx: PluginContext, provider: AiProvider): () => void {
  // Second dynamic import so the chat UI is its own chunk, fetched only when the panel paints.
  let cleanup: (() => void) | void;
  let dead = false;
  void import("./panel").then((mod) => {
    if (dead) return;
    cleanup = mod.mountChat(el, ctx, provider);
  });
  return () => { dead = true; if (typeof cleanup === "function") cleanup(); };
}

type Kind = "rewrite" | "polish" | "translate" | "summarize" | "continue";

function excludedNotice(ctx: PluginContext): boolean {
  const path = ctx.editor.getFilePath();
  const patterns = parseExclude(String(ctx.settings.get("exclude") ?? ""));
  if (!isExcluded(path, patterns)) return false;
  ctx.ui.notify("This document is in an excluded folder — AI will not send it");
  return true;
}

function guard(ctx: PluginContext): boolean {
  if (ctx.settings.get("enabled") !== true) {
    ctx.ui.notify("AI is off");
    return false;
  }
  return !excludedNotice(ctx);
}

interface Job {
  mode: "replace" | "insert";
  range?: { from: number; to: number };
  label: string;
  messages: ChatMessage[];
}

function selectionRange(ctx: PluginContext): { from: number; to: number; empty: boolean } {
  return ctx.editor.getSelection();
}

function buildJob(ctx: PluginContext, kind: Kind, instruction?: string): Job | null {
  const sel = selectionRange(ctx);
  const selected = ctx.editor.getSelectionMarkdown();
  const translateTo = String(ctx.settings.get("translateTo") ?? "English");
  if (kind === "continue" && !selected) {
    const before = ctx.editor.getContext({ before: 6, after: 0 });
    if (!before.trim()) {
      ctx.ui.notify("Nothing to continue — write something first");
      return null;
    }
    return {
      mode: "insert",
      range: { from: sel.from, to: sel.to },
      label: "AI: Continue",
      messages: [
        { role: "system", content: systemPrompt() },
        { role: "user", content: userPrompt(actionInstruction("continue", translateTo), before) },
      ],
    };
  }
  if (!selected.trim() && kind !== "continue") {
    ctx.ui.notify("Select some text first");
    return null;
  }
  const text = kind === "rewrite" ? (instruction || "Rewrite the text.") : actionInstruction(kind as Exclude<Kind, "rewrite">, translateTo);
  const insert = kind === "summarize" || kind === "continue";
  return {
    mode: insert ? "insert" : "replace",
    range: { from: sel.from, to: sel.to },
    label: kind === "rewrite" ? "AI: Rewrite" : "AI: " + kind[0].toUpperCase() + kind.slice(1),
    messages: [
      { role: "system", content: systemPrompt() },
      { role: "user", content: userPrompt(text, selected) },
    ],
  };
}

export async function runRewrite(ctx: PluginContext, provider: AiProvider) {
  if (!guard(ctx)) return;
  const sel = selectionRange(ctx);
  if (sel.empty) {
    ctx.ui.notify("Select some text first");
    return;
  }
  const instruction = await ctx.ui.prompt({ placeholder: "How should this be rewritten?", anchor: sel.from });
  if (instruction == null) return;
  const job = buildJob(ctx, "rewrite", instruction.trim() || "Rewrite the text.");
  if (!job) return;
  await streamSuggestion(ctx, provider, job);
}

export async function runAction(ctx: PluginContext, provider: AiProvider, kind: Exclude<Kind, "rewrite">) {
  if (!guard(ctx)) return;
  const job = buildJob(ctx, kind);
  if (!job) return;
  await streamSuggestion(ctx, provider, job);
}

function startStream(ctx: PluginContext, provider: AiProvider, job: Job) {
  const ac = new AbortController();
  let acc = "";
  const handle: SuggestionHandle = ctx.editor.beginSuggestion({
    range: job.range,
    mode: job.mode,
    label: job.label,
    onRetry: () => {
      ac.abort();
      handle.cancel();
      startStream(ctx, provider, job);
    },
  });
  handle.onSettled((result) => {
    if (result === "rejected" || result === "invalidated") ac.abort();
  });
  void (async () => {
    try {
      for await (const token of provider.chatStream(job.messages, { signal: ac.signal })) {
        if (ac.signal.aborted) return;
        acc += token;
        handle.append(token);
      }
      if (ac.signal.aborted) return;
      const cleaned = stripFence(acc);
      if (cleaned !== acc) handle.setText(cleaned);
      handle.finish();
    } catch (e: any) {
      if (ac.signal.aborted) return;
      handle.fail(String(e?.message ?? e));
    }
  })();
  return { abort: () => ac.abort() };
}

async function streamSuggestion(ctx: PluginContext, provider: AiProvider, job: Job) {
  startStream(ctx, provider, job);
}

export function registerSlash(ctx: PluginContext, provider: AiProvider) {
  ctx.editor.registerSlashItem({
    id: "ai",
    title: "AI: generate here",
    hint: "/ai",
    run: ({ from }) => { void generateHere(ctx, provider, from); },
  });
}

async function generateHere(ctx: PluginContext, provider: AiProvider, at: number) {
  if (!guard(ctx)) return;
  const instruction = await ctx.ui.prompt({ placeholder: "Describe what to write…", anchor: at });
  if (instruction == null || !instruction.trim()) return;
  const outline = headingsOf(ctx);
  const nearby = ctx.editor.getContext({ before: 3, after: 1 });
  const context = [outline ? "Outline:\n" + outline : "", nearby].filter(Boolean).join("\n\n");
  const job: Job = {
    mode: "insert",
    range: { from: at, to: at },
    label: "AI: generate",
    messages: [
      { role: "system", content: systemPrompt() },
      { role: "user", content: userPrompt(instruction.trim(), nearby || "(empty)", context) },
    ],
  };
  startStream(ctx, provider, job);
}

function headingsOf(ctx: PluginContext): string {
  const state = ctx.editor.getState();
  const lines: string[] = [];
  state.doc.descendants((node) => {
    if (node.type.name === "heading") {
      const level = Number(node.attrs.level) || 1;
      lines.push("#".repeat(level) + " " + node.textContent);
    }
    return node.type.name !== "heading";
  });
  return lines.join("\n");
}

export function askAboutSelection(ctx: PluginContext) {
  if (ctx.settings.get("enabled") !== true) {
    ctx.ui.notify("AI is off");
    return;
  }
  ctx.ui.revealPanel("ai");
  const selected = excludedNotice(ctx) ? "" : ctx.editor.getSelectionMarkdown();
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent("mdn-ai-ask", { detail: { selection: selected } }));
  }, 0);
}

