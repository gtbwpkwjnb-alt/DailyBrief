import OpenAI from "openai";
import { classifyError, logLlmCall, type LlmTokenUsage } from "../log";
import type { LlmRunOptions, LlmRunResult } from "../llm";

/**
 * OpenAI-compatible backend. Reused for any provider that exposes the
 * standard `/chat/completions` endpoint: OpenAI itself, DeepSeek, MiniMax,
 * Groq, Together, OpenRouter, local LM Studio / Ollama, etc.
 */
export interface OpenAICompatConfig {
  /** Stable backend id, used in logs and error messages */
  backend: "openai" | "deepseek" | "minimax";
  defaultBaseUrl: string;
  defaultModel: string;
  apiKeyEnv: string;
  baseUrlEnv: string;
}

export const PRESETS: Record<OpenAICompatConfig["backend"], OpenAICompatConfig> = {
  openai: {
    backend: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
  },
  deepseek: {
    backend: "deepseek",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    // deepseek-chat alias retires 2026-07-24 — point new users at the
    // current production model instead.
    defaultModel: "deepseek-v4-flash",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
  },
  minimax: {
    backend: "minimax",
    defaultBaseUrl: "https://api.minimax.io/v1",
    defaultModel: "MiniMax-M2.7",
    apiKeyEnv: "MINIMAX_API_KEY",
    baseUrlEnv: "MINIMAX_BASE_URL",
  },
};

const clientCache = new Map<string, OpenAI>();

type OpenAICompletionLike = {
  choices: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null };
  }>;
  usage?: {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    total_tokens?: number | null;
  } | null;
};

export interface OpenAICompletionMetadata {
  text: string;
  finishReason: string;
  outputLimited: boolean;
  visibleOutputChars: number;
  usage: LlmTokenUsage | null;
}

/** Testable response inspection that deliberately excludes all response text from logs. */
export function inspectOpenAICompletion(resp: OpenAICompletionLike): OpenAICompletionMetadata {
  const text = (resp.choices[0]?.message?.content ?? "").trim();
  const finishReason = resp.choices[0]?.finish_reason ?? "missing";
  const usage = resp.usage
    ? {
        promptTokens: resp.usage.prompt_tokens ?? null,
        completionTokens: resp.usage.completion_tokens ?? null,
        totalTokens: resp.usage.total_tokens ?? null,
      }
    : null;
  return {
    text,
    finishReason,
    outputLimited: finishReason.toLowerCase() === "length",
    visibleOutputChars: text.length,
    usage,
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function getClient(cfg: OpenAICompatConfig): { client: OpenAI; model: string } {
  // Provider-specific env wins; LLM_API_KEY / LLM_BASE_URL are generic
  // aliases so users pointing at a non-preset OpenAI-compatible service
  // (Moonshot, SiliconFlow, OpenRouter, self-hosted vLLM, ...) don't have
  // to misuse the OPENAI_* variable names just to reach a custom endpoint.
  const apiKey = process.env[cfg.apiKeyEnv] || process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error(
      `${cfg.apiKeyEnv} (or generic LLM_API_KEY) is required for LLM_BACKEND=${cfg.backend}. Set it in .env.local.`,
    );
  }
  const baseURL = process.env[cfg.baseUrlEnv]?.trim()
    || process.env.LLM_BASE_URL?.trim()
    || cfg.defaultBaseUrl;
  const model = process.env.LLM_MODEL?.trim() || cfg.defaultModel;

  const cacheKey = `${baseURL}::${apiKey.slice(-6)}`;
  let client = clientCache.get(cacheKey);
  if (!client) {
    client = new OpenAI({ apiKey, baseURL });
    clientCache.set(cacheKey, client);
  }
  return { client, model };
}

export function openaiCompatModel(cfg: OpenAICompatConfig): string {
  return process.env.LLM_MODEL?.trim() || cfg.defaultModel;
}

export async function runOpenAICompat(
  opts: LlmRunOptions,
  cfg: OpenAICompatConfig,
): Promise<LlmRunResult> {
  const { client, model } = getClient(cfg);
  const started = Date.now();
  const inputChars = opts.systemPrompt.length + opts.userPrompt.length;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  let finishReason: string | null = null;
  let usage: LlmTokenUsage | null = null;
  let visibleOutputChars = 0;

  try {
    const resp = await client.chat.completions.create(
      {
        model,
        messages: [
          { role: "system", content: opts.systemPrompt },
          { role: "user", content: opts.userPrompt },
        ],
        // Keep an explicit, configurable output ceiling. Batch planning keeps
        // normal calls well below it; the finish reason still acts as the
        // authoritative signal when a provider reaches the ceiling.
        max_tokens: positiveInteger(process.env.LLM_MAX_OUTPUT_TOKENS, 8192),
        // Don't force JSON mode — not all OpenAI-compat providers support
        // response_format=json_object, and our prompts + jsonrepair already
        // handle the slop.
      },
      { timeout: timeoutMs },
    );
    const completion = inspectOpenAICompletion(resp);
    const { text } = completion;
    finishReason = completion.finishReason;
    usage = completion.usage;
    visibleOutputChars = completion.visibleOutputChars;
    if (completion.outputLimited) {
      throw new Error(
        `LLM_OUTPUT_LIMIT backend=${cfg.backend} model=${model} finish_reason=${finishReason} visible_chars=${visibleOutputChars}`,
      );
    }
    if (!text) {
      throw new Error(
        `LLM_EMPTY_RESPONSE backend=${cfg.backend} model=${model} finish_reason=${finishReason}`,
      );
    }
    const durationMs = Date.now() - started;
    logLlmCall({
      ts: new Date(started).toISOString(),
      backend: cfg.backend,
      model,
      durationMs,
      success: true,
      inputChars,
      outputChars: text.length,
      finishReason,
      usage,
      visibleOutputChars,
      errorCategory: null,
      errorSnippet: null,
    });
    return { text, durationMs };
  } catch (err) {
    const durationMs = Date.now() - started;
    const msg = err instanceof Error ? err.message : String(err);
    logLlmCall({
      ts: new Date(started).toISOString(),
      backend: cfg.backend,
      model,
      durationMs,
      success: false,
      inputChars,
      outputChars: visibleOutputChars,
      finishReason,
      usage,
      visibleOutputChars,
      errorCategory: classifyError(msg),
      errorSnippet: msg.slice(0, 200),
    });
    throw err;
  }
}
