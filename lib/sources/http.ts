import { fetch, ProxyAgent, type Dispatcher, type RequestInit } from "undici";

const DEFAULT_TIMEOUT_MS = 12_000;

let proxyUrl: string | undefined;
let dispatcher: Dispatcher | undefined;

function configuredProxyUrl(): string | undefined {
  return process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? process.env.ALL_PROXY;
}

function getDispatcher(): Dispatcher | undefined {
  const nextProxyUrl = configuredProxyUrl();
  if (nextProxyUrl === proxyUrl) return dispatcher;

  if (nextProxyUrl) {
    new URL(nextProxyUrl);
    dispatcher = new ProxyAgent(nextProxyUrl);
  } else {
    dispatcher = undefined;
  }
  proxyUrl = nextProxyUrl;
  return dispatcher;
}

export function proxyLabel(): string | null {
  const value = configuredProxyUrl();
  if (!value) return null;
  const url = new URL(value);
  return `${url.protocol}//${url.host}`;
}

export async function httpFetch(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(input, { ...init, signal, dispatcher: getDispatcher() });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response;
}

/** Preserve network-layer error codes (for example ENOTFOUND and ETIMEDOUT) in health snapshots. */
export function describeHttpError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  const code = typeof cause?.code === "string" ? cause.code : undefined;
  const causeMessage = typeof cause?.message === "string" ? cause.message : undefined;
  return [error.message, code, causeMessage].filter(Boolean).join(" | ");
}

export async function probeHttpEndpoints(): Promise<Array<{ url: string; ok: boolean; reason?: string }>> {
  const urls = ["https://github.com", "https://hacker-news.firebaseio.com/v0/topstories.json"];
  return Promise.all(urls.map(async (url) => {
    try {
      await httpFetch(url, {}, 5_000);
      return { url, ok: true };
    } catch (error) {
      return { url, ok: false, reason: describeHttpError(error) };
    }
  }));
}
