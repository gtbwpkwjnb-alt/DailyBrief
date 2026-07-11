import { httpFetch } from "./http";
import type { RawArticle, SourceDef } from "./types";

type FreshRssItem = {
  title?: string;
  alternate?: Array<{ href?: string }>;
  canonical?: Array<{ href?: string }>;
  summary?: { content?: string };
  content?: { content?: string };
  published?: number;
  crawlTimeMsec?: string;
};

type MinifluxEntry = {
  title?: string;
  url?: string;
  content?: string;
  published_at?: string;
};

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for this reader provider`);
  return value;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function toDate(value: string | number | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function limit(): number {
  const parsed = Number.parseInt(process.env.READER_FETCH_LIMIT ?? "30", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 200 ? parsed : 30;
}

export function parseFreshRssItems(source: SourceDef, items: FreshRssItem[]): RawArticle[] {
  return items.map((item) => ({
    sourceId: source.id,
    title: item.title?.trim() ?? "",
    url: item.canonical?.[0]?.href?.trim() ?? item.alternate?.[0]?.href?.trim() ?? "",
    excerpt: stripHtml(item.summary?.content ?? item.content?.content ?? "").slice(0, 300),
    publishedAt: toDate(item.published ?? item.crawlTimeMsec),
    category: source.category,
  })).filter((item) => item.title && item.url);
}

async function fetchFreshRss(source: SourceDef): Promise<RawArticle[]> {
  const apiUrl = requireEnv("FRESHRSS_API_URL");
  const token = requireEnv("FRESHRSS_API_TOKEN");
  const stream = source.providerSourceId ?? "user/-/state/com.google/reading-list";
  const endpoint = new URL(`stream/contents/${stream}`, `${apiUrl.replace(/\/$/, "")}/`);
  endpoint.searchParams.set("n", String(limit()));
  endpoint.searchParams.set("ot", String(Math.floor(Date.now() / 1000) - 30 * 60 * 60));

  const response = await httpFetch(endpoint, {
    headers: { Authorization: `GoogleLogin auth=${token}`, Accept: "application/json" },
  });
  const payload = await response.json() as { items?: FreshRssItem[] };
  if (!Array.isArray(payload.items)) throw new Error("FreshRSS response has no items array");

  return parseFreshRssItems(source, payload.items);
}

export function parseMinifluxEntries(source: SourceDef, entries: MinifluxEntry[]): RawArticle[] {
  return entries.map((item) => ({
    sourceId: source.id,
    title: item.title?.trim() ?? "",
    url: item.url?.trim() ?? "",
    excerpt: stripHtml(item.content ?? "").slice(0, 300),
    publishedAt: toDate(item.published_at),
    category: source.category,
  })).filter((item) => item.title && item.url);
}

async function fetchMiniflux(source: SourceDef): Promise<RawArticle[]> {
  const apiUrl = requireEnv("MINIFLUX_API_URL");
  const token = requireEnv("MINIFLUX_API_TOKEN");
  const endpoint = new URL("entries", `${apiUrl.replace(/\/$/, "")}/`);
  endpoint.searchParams.set("status", "unread");
  endpoint.searchParams.set("limit", String(limit()));
  endpoint.searchParams.set("order", "published_at");
  endpoint.searchParams.set("direction", "desc");
  if (source.providerSourceId) endpoint.searchParams.set("feed_id", source.providerSourceId);

  const response = await httpFetch(endpoint, {
    headers: { "X-Auth-Token": token, Accept: "application/json" },
  });
  const payload = await response.json() as { entries?: MinifluxEntry[] };
  if (!Array.isArray(payload.entries)) throw new Error("Miniflux response has no entries array");

  return parseMinifluxEntries(source, payload.entries);
}

export async function fetchReader(source: SourceDef): Promise<RawArticle[]> {
  if (source.provider === "freshrss") return fetchFreshRss(source);
  if (source.provider === "miniflux") return fetchMiniflux(source);
  throw new Error(`unsupported reader provider: ${source.provider ?? "missing"}`);
}
