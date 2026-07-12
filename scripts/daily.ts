import "./_env";

import fs from "node:fs";
import path from "node:path";

import { sources, REPORT_LOCALE } from "../lib/sources/registry";
import { fetchSource } from "../lib/sources/dispatch";
import { describeHttpError, probeHttpEndpoints, proxyLabel } from "../lib/sources/http";
import {
  generateDailyReport,
  type ArticleInput,
  type DailyReport,
} from "../lib/ai/pipeline";
import { getModelTag, validateBackendCredentials } from "../lib/ai/llm";
import {
  enrichFinanceNewsSummaries,
  enrichGithubTrendingSummaries,
  enrichPoliticsSummaries,
  enrichTrendingPapersSummaries,
  enrichTrendingSummaries,
  enrichXViralSummaries,
  enrichContentTags,
  consolidatedEnrich,
  aiReview,
  type EnrichInput,
  type ReviewResult,
} from "../lib/ai/enrich";
import {
  groupRaw,
  isSportsArticle,
  MERGED_SUBGROUP_LIMITS,
  renderHtml,
  renderMarkdown,
} from "../lib/output/render";
import { parseReportSidecar } from "../lib/output/sidecar";
import type { FilterProfile, RunStats } from "../lib/output/render";
import {
  BASE_FILTER_RULES_EN,
  BASE_FILTER_RULES_ZH,
  detectCoverageCountries,
  matchCustomKeywords,
  normalizeCustomKeywords,
} from "../lib/editorial/context";
import { analyzeWatchlist } from "../lib/trading/runner";
import { fetchCryptoFearGreed } from "../lib/trading/fear-greed";
import { fetchCryptoGlobal } from "../lib/trading/coingecko";
import { generateTradingCommentary } from "../lib/ai/trading-commentary";
import type { TradingSection } from "../lib/ai/pipeline";
import { todayKey } from "../lib/utils";

const OUTPUT_DIR = "daily_reports";
const CACHE_DIR = ".cache";
const LOG_DIR = "logs";

type FailedSource = { id: string; name: string; reason: string };

type SourceHealth = {
  id: string;
  name: string;
  category: string;
  provider: string;
  tier: string;
  success: boolean;
  hasItems: boolean;
  attempts: number;
  durationMs: number;
  itemCount: number;
  reason?: string;
};

type FetchResult = {
  source: (typeof sources)[number];
  items?: Awaited<ReturnType<typeof fetchSource>>;
  health: SourceHealth;
};

type NetworkProbe = { url: string; ok: boolean; reason?: string };

function appendRunLog(date: string, message: string): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, `daily-${date}.log`), `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

const REUSE_WINDOW_MS = 5 * 60 * 60 * 1000;

function requestedCustomKeywords(): string[] {
  const raw = process.env.DAILY_CUSTOM_KEYWORDS_JSON;
  if (!raw) return normalizeCustomKeywords(process.env.DAILY_CUSTOM_KEYWORDS);
  try {
    return normalizeCustomKeywords(JSON.parse(raw) as string[]);
  } catch {
    return normalizeCustomKeywords(raw);
  }
}

function loadRecentRun(date: string): ReturnType<typeof parseReportSidecar> | null {
  const sidecarPath = path.join(OUTPUT_DIR, date, `${date}-articles.json`);
  if (!fs.existsSync(sidecarPath)) return null;
  try {
    const parsed = parseReportSidecar(JSON.parse(fs.readFileSync(sidecarPath, "utf8")));
    const generatedAt = parsed.runStats?.generatedAt;
    if (!generatedAt) return null;
    const age = Date.now() - Date.parse(generatedAt);
    if (!Number.isFinite(age) || age < 0 || age >= REUSE_WINDOW_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function loadCachedReport(date: string): DailyReport | null {
  const reportPath = path.join(OUTPUT_DIR, date, `${date}.json`);
  try {
    return JSON.parse(fs.readFileSync(reportPath, "utf8")) as DailyReport;
  } catch {
    return null;
  }
}

function hydrateArticleContext(articles: ArticleInput[], customKeywords: string[]): void {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  for (const article of articles) {
    const source = sourceById.get(article.sourceId);
    article.sourceCountry ??= source?.originCountry;
    const detected = detectCoverageCountries(`${article.title} ${article.excerpt ?? ""} ${article.summary ?? ""}`);
    article.coverageCountries = detected.slice(0, 8);
    article.interestMatches = matchCustomKeywords(article, customKeywords);
  }
}

function writeSourceHealth(
  dateDir: string,
  date: string,
  sourceSuccessRate: number,
  sources: SourceHealth[],
  network: NetworkProbe[],
): void {
  const summarize = (keyOf: (source: SourceHealth) => string) => {
    const stats = new Map<string, { total: number; succeeded: number; nonEmpty: number }>();
    for (const source of sources) {
      const key = keyOf(source);
      const current = stats.get(key) ?? { total: 0, succeeded: 0, nonEmpty: 0 };
      current.total += 1;
      if (source.success) current.succeeded += 1;
      if (source.hasItems) current.nonEmpty += 1;
      stats.set(key, current);
    }
    return [...stats.entries()].map(([key, stat]) => ({
      key,
      ...stat,
      successRate: stat.succeeded / stat.total,
      contentRate: stat.nonEmpty / stat.total,
    }));
  };
  const providers = summarize((source) => source.provider)
    .map(({ key, ...stats }) => ({ provider: key, ...stats }));
  const categories = summarize((source) => source.category)
    .map(({ key, ...stats }) => ({ category: key, ...stats }));
  fs.mkdirSync(dateDir, { recursive: true });
  fs.writeFileSync(
    path.join(dateDir, "source-health.json"),
    JSON.stringify({ date, generatedAt: new Date().toISOString(), sourceSuccessRate, network, providers, categories, sources }, null, 2),
    "utf8",
  );
}

function readPositiveInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readFraction(name: string, fallback: number): number {
  const value = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
}

function sourceHost(source: (typeof sources)[number]): string {
  const providerUrl = source.provider === "freshrss"
    ? process.env.FRESHRSS_API_URL
    : source.provider === "miniflux"
      ? process.env.MINIFLUX_API_URL
      : undefined;
  try {
    return new URL(providerUrl ?? source.url).host;
  } catch {
    return source.id;
  }
}

/**
 * Enrichment cache: after each enrich step succeeds, its results are saved
 * to .cache/<date>/<scope>.json. On re-runs the same day, cached results are
 * loaded instead of calling the LLM again. This turns a 3-minute re-run into
 * ~5 seconds when only a few sources changed.
 */

function cachePath(scope: string, date: string): string {
  return path.join(CACHE_DIR, date, `${scope}.json`);
}

function readEnrichCache(scope: string, date: string): Map<string, string> | null {
  const p = cachePath(scope, date);
  try {
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, "utf8")) as Array<[string, string]>;
      return new Map(data);
    }
  } catch {
    // corrupted cache — skip
  }
  return null;
}

function writeEnrichCache(scope: string, date: string, map: Map<string, string>): void {
  try {
    const dir = path.dirname(cachePath(scope, date));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath(scope, date), JSON.stringify([...map.entries()]), "utf8");
  } catch {
    // can't write cache (read-only fs?) — non-fatal
  }
}

function readTagCache(date: string): Map<string, string[]> | null {
  const p = cachePath("tags", date);
  try {
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, "utf8")) as Array<[string, string[]]>;
      return new Map(data);
    }
  } catch {
    // corrupted cache — skip
  }
  return null;
}

function writeTagCache(date: string, map: Map<string, string[]>): void {
  try {
    const dir = path.dirname(cachePath("tags", date));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath("tags", date), JSON.stringify([...map.entries()]), "utf8");
  } catch {
    // can't write cache — non-fatal
  }
}

async function fetchWithRetry(
  source: (typeof sources)[number],
  maxAttempts: number,
  baseDelayMs: number,
): Promise<{ source: (typeof sources)[number]; items?: Awaited<ReturnType<typeof fetchSource>>; health: SourceHealth }> {
  const startedAt = Date.now();
  let reason = "unknown fetch error";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const items = await fetchSource(source);
      return {
        source,
        items,
        health: {
          id: source.id,
          name: source.name,
          category: source.category,
          provider: source.provider ?? "direct",
          tier: source.tier ?? "standard",
          success: true,
          hasItems: items.length > 0,
          attempts: attempt,
          durationMs: Date.now() - startedAt,
          itemCount: items.length,
        },
      };
    } catch (error) {
      reason = describeHttpError(error);
      if (attempt < maxAttempts) {
        const delayMs = baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * baseDelayMs);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  return {
    source,
    health: {
      id: source.id,
      name: source.name,
      category: source.category,
      provider: source.provider ?? "direct",
      tier: source.tier ?? "standard",
      success: false,
      hasItems: false,
      attempts: maxAttempts,
      durationMs: Date.now() - startedAt,
      itemCount: 0,
      reason,
    },
  };
}

/** Fetch enabled sources in bounded concurrent batches with per-source retry. */
async function fetchAll(): Promise<{ articles: ArticleInput[]; failedSources: FailedSource[]; health: SourceHealth[] }> {
  const articles: ArticleInput[] = [];
  const failedSources: FailedSource[] = [];
  const health: SourceHealth[] = [];
  const batchSize = readPositiveInt("SOURCE_FETCH_CONCURRENCY", 6);
  const maxAttempts = readPositiveInt("SOURCE_FETCH_ATTEMPTS", 3);
  const retryBaseMs = readPositiveInt("SOURCE_FETCH_RETRY_BASE_MS", 1_000);
  const hostFailureThreshold = readPositiveInt("SOURCE_HOST_FAILURE_THRESHOLD", 3);
  const hostFailures = new Map<string, number>();
  const enabled = sources
    .filter((s) => s.enabled !== false)
    .sort((a, b) => (b.priority ?? 3) - (a.priority ?? 3));

  for (let i = 0; i < enabled.length; i += batchSize) {
    const batch = enabled.slice(i, i + batchSize);
    const results: FetchResult[] = await Promise.all(batch.map(async (source): Promise<FetchResult> => {
      const host = sourceHost(source);
      const failures = hostFailures.get(host) ?? 0;
      if (failures >= hostFailureThreshold) {
        return Promise.resolve({
          source,
          health: {
            id: source.id,
            name: source.name,
            category: source.category,
            provider: source.provider ?? "direct",
            tier: source.tier ?? "standard",
            success: false,
            hasItems: false,
            attempts: 0,
            durationMs: 0,
            itemCount: 0,
            reason: `host circuit open after ${failures} failures: ${host}`,
          },
        });
      }
      return fetchWithRetry(source, maxAttempts, retryBaseMs);
    }));
    for (const res of results) {
      health.push(res.health);
      if (res.health.success && res.items) {
        console.log(`  ${res.source.id.padEnd(20)} ${res.items.length} (${res.health.attempts} attempt${res.health.attempts === 1 ? "" : "s"})`);
        articles.push(...res.items.map((it) => ({
          ...it,
          source: res.source.name,
          sourceCountry: res.source.originCountry,
          coverageCountries: detectCoverageCountries(`${it.title} ${it.excerpt ?? ""}`),
        })));
      } else {
        const reason = res.health.reason ?? "unknown fetch error";
        console.error(`  ${res.source.id.padEnd(20)} FAILED after ${res.health.attempts} attempts — ${reason}`);
        failedSources.push({ id: res.source.id, name: res.source.name, reason });
        const host = sourceHost(res.source);
        if (res.health.attempts > 0) {
          hostFailures.set(host, (hostFailures.get(host) ?? 0) + 1);
        }
      }
    }
  }

  return { articles, failedSources, health };
}

async function enrichGhTrending(articles: ArticleInput[], date: string): Promise<void> {
  const gh = articles.filter((a) => a.sourceId === "github-trending");
  if (gh.length === 0) return;
  // Check cache first
  const cached = readEnrichCache("gh-trending", date);
  if (cached) {
    let hit = 0;
    for (const a of gh) { const s = cached.get(a.url); if (s) { a.summary = s; hit++; } }
    console.log(`[daily] GH Trending: cache hit ${hit}/${gh.length}`);
    return;
  }
  console.log(
    `[daily] enriching ${gh.length} GitHub Trending repos with ${REPORT_LOCALE} summaries…`,
  );
  const t0 = Date.now();
  const summaries = await enrichGithubTrendingSummaries(gh);
  for (const a of gh) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${gh.length}`,
  );
  if (summaries.size > 0) writeEnrichCache("gh-trending", date, summaries);
}

/**
 * finance:news is rendered as a merged time-sorted list (see
 * MERGED_SUBGROUP_LIMITS in render.ts). Enrich exactly the items that
 * will be displayed: take all enabled finance:news articles, sort by
 * publishedAt desc, slice to the merge limit, ask Sonnet for Chinese
 * factual summaries.
 */
async function enrichFinanceNews(articles: ArticleInput[], date: string): Promise<void> {
  await enrichMergedSubgroup(articles, "finance", "news", undefined, date);
}

async function enrichPolitics(articles: ArticleInput[], date: string): Promise<void> {
  // Collect articles from all politics subcategories, do round-robin per subcat,
  // then send them ALL to a single LLM call instead of 7 separate calls.
  const POLITICS_SUBS = ["uk", "us", "france", "japan", "india", "east-asia", "other"];
  const toEnrich: ArticleInput[] = [];
  for (const sub of POLITICS_SUBS) {
    const subSources = sources.filter(
      (s) => s.category === "politics" && s.subcategory === sub && s.enabled !== false,
    );
    const enabledIds = new Set(subSources.map((s) => s.id));
    const sameLocaleIds = new Set(
      subSources.filter((s) => (s.lang ?? "en") === REPORT_LOCALE).map((s) => s.id),
    );
    const limit = MERGED_SUBGROUP_LIMITS[`politics:${sub}`] ?? 15;
    const candidates = articles
      .filter((a) => enabledIds.has(a.sourceId))
      .filter((a) => !isSportsArticle(a.title));
    const bySource = new Map<string, ArticleInput[]>();
    for (const a of candidates) {
      const arr = bySource.get(a.sourceId) ?? [];
      arr.push(a);
      bySource.set(a.sourceId, arr);
    }
    const buckets = Array.from(bySource.values());
    const top: ArticleInput[] = [];
    let madeProgress = true;
    while (top.length < limit && madeProgress) {
      madeProgress = false;
      for (const b of buckets) {
        if (b.length === 0) continue;
        top.push(b.shift()!);
        madeProgress = true;
        if (top.length >= limit) break;
      }
    }
    toEnrich.push(...top.filter((a) => !sameLocaleIds.has(a.sourceId)));
  }
  if (toEnrich.length === 0) return;
  // Check cache first
  const cachedPolitics = readEnrichCache("politics", date);
  if (cachedPolitics) {
    let hit = 0;
    for (const a of toEnrich) { const s = cachedPolitics.get(a.url); if (s) { a.summary = s; hit++; } }
    console.log(`[daily] Politics: cache hit ${hit}/${toEnrich.length}`);
    return;
  }
  console.log(`[daily] enriching ${toEnrich.length} politics items with ${REPORT_LOCALE} summaries…`);
  const t0 = Date.now();
  const summaries = await enrichPoliticsSummaries(toEnrich);
  let matched = 0;
  for (const a of toEnrich) {
    const s = summaries.get(a.url);
    if (s) { a.summary = s; matched++; }
  }
  console.log(`[daily] politics enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${matched}/${toEnrich.length}`);
  if (summaries.size > 0) writeEnrichCache("politics", date, summaries);
}

async function enrichAiNews(articles: ArticleInput[], date: string): Promise<void> {
  await enrichMergedSubgroup(articles, "tech", "ai-news", undefined, date);
}

/**
 * Enrich trending content (Google Trends keywords, Reddit popular posts)
 * with Chinese translations/summaries. Uses the merged-subgroup pattern
 * for google-trends and reddit-trending, plus cn-trending sources are
 * already in Chinese and skipped.
 */
async function enrichTrending(articles: ArticleInput[], date: string): Promise<void> {
  // Google Trends: dedup by title across all regions, then enrich top 10
  // (round-robin across 6 regions produces near-identical keywords)
  const gtSources = sources.filter(
    (s) => s.category === "trending" && s.subcategory === "google-trends" && s.enabled !== false,
  );
  const gtEnabledIds = new Set(gtSources.map((s) => s.id));
  const gtCandidates = articles.filter((a) => gtEnabledIds.has(a.sourceId));
  const gtSeen = new Set<string>();
  const gtDeduped: ArticleInput[] = [];
  for (const a of gtCandidates) {
    const key = a.title.toLowerCase().replace(/\s+/g, " ").trim();
    if (!gtSeen.has(key)) { gtSeen.add(key); gtDeduped.push(a); }
  }
  const gtLimit = MERGED_SUBGROUP_LIMITS["trending:google-trends"] ?? 10;
  const gtTop = gtDeduped.slice(0, gtLimit);
  if (gtTop.length > 0) {
    const t0 = Date.now();
    console.log(`[daily] enriching ${gtTop.length} Google Trends (deduped from ${gtCandidates.length})…`);
    const summaries = await enrichTrendingSummaries(gtTop);
    let matched = 0;
    for (const a of gtTop) { const s = summaries.get(a.url); if (s) { a.summary = s; matched++; } }
    console.log(`[daily] Trending (google) done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${matched}/${gtTop.length}`);
  }

  // Enrich Reddit popular (English titles → Chinese)
  await enrichMergedSubgroup(articles, "trending", "reddit-trending", enrichTrendingSummaries, date);
  // cn-trending sources (微博热搜, 知乎热榜) are already in Chinese — no enrichment needed
}

/**
 * X 热帖 enrichment is different from merged subgroups — we preserve the
 * AttentionVC API's heat-rank order (do NOT sort by date) and cap to the
 * displayed limit (matches SOURCE_DISPLAY_LIMITS["tech:x-viral"]).
 *
 * The Sonnet prompt also differs (XVIRAL_SYSTEM_PROMPT in enrich.ts) — X
 * tweet titles are clickbait, the previewText holds the actual claim.
 */
async function enrichXViral(articles: ArticleInput[], date: string): Promise<void> {
  const xPosts = articles
    .filter((a) => a.sourceId === "attentionvc-ai")
    .slice(0, 20);
  if (xPosts.length === 0) return;
  // Check cache first
  const cachedX = readEnrichCache("x-viral", date);
  if (cachedX) {
    let hit = 0;
    for (const a of xPosts) { const s = cachedX.get(a.url); if (s) { a.summary = s; hit++; } }
    console.log(`[daily] X Viral: cache hit ${hit}/${xPosts.length}`);
    return;
  }
  console.log(`[daily] enriching ${xPosts.length} X posts with ${REPORT_LOCALE} summaries…`);
  const t0 = Date.now();
  // Author handle is encoded in the URL (https://x.com/{handle}/status/{id})
  // — extract it to help the model identify whose claim it is.
  const summaries = await enrichXViralSummaries(
    xPosts.map((a) => ({
      url: a.url,
      title: a.title,
      excerpt: a.excerpt,
      author: a.url.match(/x\.com\/([^/]+)\//)?.[1] ?? "",
    })),
  );
  for (const a of xPosts) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${xPosts.length}`,
  );
  if (summaries.size > 0) writeEnrichCache("x-viral", date, summaries);
}

/**
 * Trending papers enrichment — preserves the fetcher's upvote-desc order
 * (huggingface-papers is in PRESERVE_FETCH_ORDER_SOURCES) and caps to the
 * displayed limit (matches SOURCE_DISPLAY_LIMITS["tech:trending-papers"]).
 */
async function enrichTrendingPapers(articles: ArticleInput[], date: string): Promise<void> {
  const papers = articles
    .filter((a) => a.sourceId === "huggingface-papers")
    .slice(0, 20);
  if (papers.length === 0) return;
  const cached = readEnrichCache("trending-papers", date);
  if (cached) {
    let hit = 0;
    for (const a of papers) { const s = cached.get(a.url); if (s) { a.summary = s; hit++; } }
    console.log(`[daily] Trending Papers: cache hit ${hit}/${papers.length}`);
    return;
  }
  console.log(
    `[daily] enriching ${papers.length} trending papers with ${REPORT_LOCALE} summaries…`,
  );
  const t0 = Date.now();
  const summaries = await enrichTrendingPapersSummaries(
    papers.map((a) => ({ url: a.url, title: a.title, excerpt: a.excerpt })),
  );
  for (const a of papers) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${papers.length}`,
  );
  if (summaries.size > 0) writeEnrichCache("trending-papers", date, summaries);
}

/**
 * Generate content attribute tags for all enriched articles.
 * Runs once after all summary enrichments complete, sending every article
 * that has a summary in a single batch LLM call.
 */
async function enrichTags(articles: ArticleInput[], date: string): Promise<void> {
  // Only tag articles that have a summary (skips zh-only sources)
  const toTag = articles.filter((a) => a.summary);
  if (toTag.length === 0) return;
  // Check tag cache first
  const cached = readTagCache(date);
  if (cached) {
    let hit = 0;
    for (const a of toTag) {
      const t = cached.get(a.url);
      if (t && t.length > 0) { a.tags = t; hit++; }
    }
    console.log(`[daily] tags: cache hit ${hit}/${toTag.length}`);
    return;
  }
  console.log(
    `[daily] tagging ${toTag.length} articles with content attributes…`,
  );
  const t0 = Date.now();
  const tags = await enrichContentTags(
    toTag.map((a) => ({
      url: a.url,
      title: a.title,
      excerpt: a.summary, // pass the AI summary as "excerpt" for classification
      source: a.source,
    })),
  );
  let matched = 0;
  for (const a of toTag) {
    const t = tags.get(a.url);
    if (t && t.length > 0) {
      a.tags = t;
      matched++;
    }
  }
  console.log(
    `[daily] tagging done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${matched}/${toTag.length}`,
  );
  if (tags.size > 0) writeTagCache(date, tags);
}

/**
 * Shared implementation for "merged subgroup" enrichment: collect all
 * enabled articles in (category, subcategory), sort by date desc, take
 * the display cap (from MERGED_SUBGROUP_LIMITS), and ask the LLM to
 * summarize them into REPORT_LOCALE in a single batch. Symmetric to the
 * merge logic in render.ts groupRaw, so display and enrichment stay aligned.
 *
 * Sources whose `lang` already matches REPORT_LOCALE are skipped — no
 * point translating English to English (en mode) or Chinese to Chinese
 * (zh mode).
 */
async function enrichMergedSubgroup(
  articles: ArticleInput[],
  category: "tech" | "finance" | "politics" | "trending",
  subcategory: string,
  summarizer?: (items: EnrichInput[]) => Promise<Map<string, string>>,
  date?: string,
): Promise<void> {
  const subSources = sources.filter(
    (s) =>
      s.category === category &&
      s.subcategory === subcategory &&
      s.enabled !== false,
  );
  const enabledIds = new Set(subSources.map((s) => s.id));
  const sameLocaleIds = new Set(
    subSources.filter((s) => (s.lang ?? "en") === REPORT_LOCALE).map((s) => s.id),
  );
  const limit = MERGED_SUBGROUP_LIMITS[`${category}:${subcategory}`] ?? 12;
  // Round-robin selection preserving each source's feed order (heat),
  // matching the display logic in render.ts groupRaw. This ensures the
  // items that get enriched are the same ones that appear in the panel.
  const candidates = articles
    .filter((a) => enabledIds.has(a.sourceId))
    .filter((a) => category !== "politics" || !isSportsArticle(a.title));
  // Group by sourceId preserving per-source order
  const bySource = new Map<string, ArticleInput[]>();
  for (const a of candidates) {
    const arr = bySource.get(a.sourceId) ?? [];
    arr.push(a);
    bySource.set(a.sourceId, arr);
  }
  const buckets = Array.from(bySource.values());
  const top: ArticleInput[] = [];
  let madeProgress = true;
  while (top.length < limit && madeProgress) {
    madeProgress = false;
    for (const b of buckets) {
      if (b.length === 0) continue;
      top.push(b.shift()!);
      madeProgress = true;
      if (top.length >= limit) break;
    }
  }
  const toEnrich = top.filter((a) => !sameLocaleIds.has(a.sourceId));
  if (toEnrich.length === 0) return;
  // Check cache if date provided
  const cacheScope = `${category}-${subcategory}`;
  if (date) {
    const cached = readEnrichCache(cacheScope, date);
    if (cached) {
      let hit = 0;
      for (const a of toEnrich) { const s = cached.get(a.url); if (s) { a.summary = s; hit++; } }
      console.log(`[daily] ${cacheScope}: cache hit ${hit}/${toEnrich.length}`);
      return;
    }
  }
  console.log(
    `[daily] enriching ${toEnrich.length}/${top.length} ${category}:${subcategory} items with ${REPORT_LOCALE} summaries…`,
  );
  const t0 = Date.now();
  const enrichFn = summarizer ?? enrichFinanceNewsSummaries;
  const summaries = await enrichFn(toEnrich);
  for (const a of toEnrich) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${toEnrich.length}`,
  );
  if (summaries.size > 0 && date) writeEnrichCache(cacheScope, date, summaries);
}

/**
 * Pull daily OHLCV from Yahoo for every ticker in the watchlist, compute
 * indicators + signals, then ask Sonnet for a market overview + a
 * picks-to-watch list. Returns null if no ticker came back.
 */
async function runTrading(): Promise<TradingSection | null> {
  console.log(`[daily] analyzing watchlist + crypto context (Yahoo / alt.me / CoinGecko)…`);
  const t0 = Date.now();
  const [tickers, cryptoFearGreed, cryptoGlobal] = await Promise.all([
    analyzeWatchlist(),
    fetchCryptoFearGreed(),
    fetchCryptoGlobal(),
  ]);
  console.log(
    `[daily] indicators ready in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${tickers.length} tickers` +
      (cryptoFearGreed ? `, F&G ${cryptoFearGreed.value}` : ", F&G ✗") +
      (cryptoGlobal
        ? `, BTC dom ${cryptoGlobal.btcDominance.toFixed(1)}%`
        : ", CG ✗"),
  );
  if (tickers.length === 0) return null;
  console.log(`[daily] generating trading commentary with ${getModelTag()}…`);
  const t1 = Date.now();
  const commentary = await generateTradingCommentary({
    tickers,
    cryptoFearGreed: cryptoFearGreed ?? undefined,
    cryptoGlobal: cryptoGlobal ?? undefined,
  });
  console.log(
    `[daily] trading commentary ready in ${((Date.now() - t1) / 1000).toFixed(1)}s`,
  );
  return {
    ...commentary,
    tickers,
    crypto_fear_greed: cryptoFearGreed ?? undefined,
    crypto_global: cryptoGlobal ?? undefined,
    generated_at: new Date().toISOString(),
  };
}

async function main() {
  const date = todayKey();
  const dateDir = path.join(OUTPUT_DIR, date);
  const proxy = proxyLabel();
  const customKeywords = requestedCustomKeywords();
  const cachedRun = loadRecentRun(date);
  const completeCachedReport = cachedRun
    && customKeywords.length === 0
    && fs.existsSync(path.join(dateDir, `${date}.json`))
    && fs.existsSync(path.join(dateDir, `${date}.html`));
  if (completeCachedReport) {
    appendRunLog(date, "reused complete report within 5-hour window; no LLM calls");
    console.log(`[daily] reusing complete ${date} report from the last 5 hours; no LLM calls`);
    return;
  }

  // Validate credentials only when this run needs an LLM call.
  validateBackendCredentials();

  const filterProfile: FilterProfile = {
    baseRules: REPORT_LOCALE === "en" ? BASE_FILTER_RULES_EN : BASE_FILTER_RULES_ZH,
    customKeywords,
    mode: customKeywords.length > 0 ? "incremental" : "base",
  };
  let articles: ArticleInput[];
  let failedSources: FailedSource[];
  let health: SourceHealth[];
  let sourceSuccessRate: number;
  let fetchedArticleCount: number;
  let fetchedSources: number;
  let successfulSources: number;

  appendRunLog(date, `started${proxy ? ` with proxy ${proxy}` : " without proxy"}`);
  if (cachedRun) {
    articles = cachedRun.articles;
    failedSources = cachedRun.failedSources;
    health = [];
    fetchedArticleCount = cachedRun.runStats?.fetchedArticles ?? articles.length;
    fetchedSources = cachedRun.runStats?.fetchedSources ?? sources.filter((source) => source.enabled !== false).length;
    successfulSources = cachedRun.runStats?.successfulSources ?? fetchedSources;
    sourceSuccessRate = cachedRun.runStats?.sourceSuccessRate ?? 1;
    console.log(`[daily] reusing ${date} cache from the last 5 hours; skipping source fetch`);
    appendRunLog(date, `reusing cached deduped articles; custom keywords=${JSON.stringify(customKeywords)}`);
  } else {
    const network = await probeHttpEndpoints();
    const availableProbes = network.filter((probe) => probe.ok).length;
    console.log(`[daily] network preflight: ${availableProbes}/${network.length} endpoints reachable${proxy ? ` via ${proxy}` : ""}`);
    appendRunLog(date, `network preflight ${availableProbes}/${network.length}: ${JSON.stringify(network)}`);

    // Phase 1+2+3: Fetch all sources (with priority-based ordering),
    // then globally dedup by URL + title.
    console.log(`[daily] ${date} — fetching sources (priority order)…\n`);
    const fetched = await fetchAll();
    articles = fetched.articles;
    failedSources = fetched.failedSources;
    health = fetched.health;
    fetchedArticleCount = articles.length;
    fetchedSources = health.length;
    successfulSources = health.filter((source) => source.success).length;
    sourceSuccessRate = successfulSources / Math.max(1, fetchedSources);
    writeSourceHealth(dateDir, date, sourceSuccessRate, health, network);
  }

  const minSourceSuccessRate = readFraction("SOURCE_MIN_SUCCESS_RATE", 0.6);
  appendRunLog(date, `source health ${(sourceSuccessRate * 100).toFixed(1)}% (${successfulSources}/${fetchedSources})`);
  console.log(`[daily] source health: ${(sourceSuccessRate * 100).toFixed(1)}% success (${successfulSources}/${fetchedSources})`);
  if (sourceSuccessRate < minSourceSuccessRate) {
    appendRunLog(date, `blocked by SOURCE_MIN_SUCCESS_RATE ${(minSourceSuccessRate * 100).toFixed(1)}%`);
    throw new Error(`source success rate ${(sourceSuccessRate * 100).toFixed(1)}% is below SOURCE_MIN_SUCCESS_RATE ${(minSourceSuccessRate * 100).toFixed(1)}%`);
  }
  console.log(`\n[daily] total articles: ${articles.length}, failed sources: ${failedSources.length}`);
  if (articles.length === 0) throw new Error("no articles fetched — aborting");

  hydrateArticleContext(articles, customKeywords);

  // Global dedup: URL exact match + title normalized match
  {
    const seenUrl = new Set<string>();
    const seenTitle = new Set<string>();
    const deduped: typeof articles = [];
    for (const a of articles) {
      const urlKey = a.url.toLowerCase().trim();
      if (seenUrl.has(urlKey)) continue;
      seenUrl.add(urlKey);
      const titleKey = a.title.toLowerCase().replace(/[^\w\u4e00-\u9fff]/g, "").trim();
      if (titleKey.length > 10 && seenTitle.has(titleKey)) continue;
      if (titleKey.length > 10) seenTitle.add(titleKey);
      deduped.push(a);
    }
    const removed = articles.length - deduped.length;
    if (removed > 0) console.log(`[daily] global dedup removed ${removed} (${articles.length} → ${deduped.length})`);
    articles.length = 0;
    articles.push(...deduped);
  }

  // Phase 4: Consolidated AI optimization — one LLM call per category.
  // Replaces 8 separate enrich calls (GH, Papers, Finance, Politics,
  // Trends, Reddit, X Viral, Tags) with 4 category-level calls.
  // Each call handles: translation (en→zh), refinement, tagging, importance.
  console.log(`[daily] consolidated AI enrichment (4 categories)…`);
  const enrichT0 = Date.now();
  const CATEGORY_CONFIG = [
    { key: "trending", label: "热搜趋势", filter: (a: ArticleInput) => a.category === "trending" },
    { key: "tech",     label: "技术动态", filter: (a: ArticleInput) => a.category === "tech" },
    { key: "finance",  label: "财经要点", filter: (a: ArticleInput) => a.category === "finance" },
    { key: "politics", label: "国际时政", filter: (a: ArticleInput) => a.category === "politics" },
  ];
  // Enrich the exact articles that groupRaw will render. This avoids spending
  // the budget on fetch-order items while visible cards remain untranslated.
  const visibleRaw = groupRaw(articles, sources, { customKeywords });
  const visibleByCategory = new Map<string, ArticleInput[]>();
  for (const category of Object.keys(visibleRaw) as Array<keyof typeof visibleRaw>) {
    const seen = new Set<string>();
    const visible = visibleRaw[category]
      .flatMap((subgroup) => subgroup.sources)
      .flatMap((source) => source.items)
      .filter((article) => {
        if (seen.has(article.url)) return false;
        seen.add(article.url);
        return true;
      });
    visibleByCategory.set(category, visible);
  }

  const dedupedArticleCount = articles.length;
  const runStats: RunStats = {
    fetchedSources,
    successfulSources,
    sourceSuccessRate,
    fetchedArticles: fetchedArticleCount,
    dedupedArticles: dedupedArticleCount,
    generatedAt: new Date().toISOString(),
    mode: cachedRun ? "reuse" : "fresh",
  };
  const enrichmentHealth = cachedRun && customKeywords.length === 0
    ? CATEGORY_CONFIG.map((cfg) => {
        const items = visibleByCategory.get(cfg.key) ?? [];
        const enriched = items.filter((article) => article.displayTitle && article.summary).length;
        console.log(`[daily]  ${cfg.key.padEnd(12)} cache reuse ${enriched}/${items.length}`);
        return { key: cfg.key, requested: items.length, enriched };
      })
    : await Promise.all(CATEGORY_CONFIG.map(async (cfg) => {
    const items = visibleByCategory.get(cfg.key) ?? [];
    if (items.length === 0) return { key: cfg.key, requested: 0, enriched: 0 };
    const targets = cachedRun && customKeywords.length > 0
      ? items.filter((article) => (article.interestMatches?.length ?? 0) > 0 || !article.displayTitle || !article.summary)
      : items;
    if (targets.length === 0) {
      const enriched = items.filter((article) => article.displayTitle && article.summary).length;
      console.log(`[daily]  ${cfg.key.padEnd(12)} no new interest matches; cache coverage ${enriched}/${items.length}`);
      return { key: cfg.key, requested: items.length, enriched };
    }
    const t1 = Date.now();
    const results = await consolidatedEnrich(
      cfg.label,
      targets.map((a) => ({
        url: a.url,
        title: a.title,
        excerpt: a.summary ?? a.excerpt,
        source: a.source,
        sourceCountry: a.sourceCountry,
        customKeywords,
      })),
      { customKeywords },
    );
    let matched = 0;
    for (const a of targets) {
      const r = results.get(a.url);
      if (r?.displayTitle) {
        a.displayTitle = r.displayTitle;
        a.summary = r.summary;
        a.tags = r.tags;
        a.importance = r.importance;
        const explicitCountries = detectCoverageCountries(`${a.title} ${a.excerpt ?? ""} ${a.summary ?? ""}`);
        const aiCountries = (r.coverageCountries ?? []).filter((country) => explicitCountries.includes(country));
        a.coverageCountries = [...new Set([...explicitCountries, ...aiCountries])].slice(0, 8);
        a.interestMatches = [...new Set([...(a.interestMatches ?? []), ...(r.interestMatches ?? [])])].filter((keyword) => customKeywords.includes(keyword));
        matched++;
      }
    }
    const enriched = items.filter((article) => article.displayTitle && article.summary).length;
    console.log(`[daily]  ${cfg.key.padEnd(12)} ${matched}/${targets.length} targeted, coverage ${enriched}/${items.length} in ${((Date.now()-t1)/1000).toFixed(1)}s`);
    return { key: cfg.key, requested: items.length, enriched };
  }));
  const minEnrichmentCoverage = readFraction("MIN_ENRICHMENT_COVERAGE", 1);
  for (const category of enrichmentHealth) {
    if (category.requested === 0) continue;
    const coverage = category.enriched / category.requested;
    if (coverage < minEnrichmentCoverage) {
      appendRunLog(date, `blocked by ${category.key} enrichment coverage ${(coverage * 100).toFixed(1)}%`);
      throw new Error(`${category.key} enrichment coverage ${(coverage * 100).toFixed(1)}% is below MIN_ENRICHMENT_COVERAGE ${(minEnrichmentCoverage * 100).toFixed(1)}%`);
    }
  }
  console.log(`[daily] consolidated enrichment done in ${((Date.now() - enrichT0) / 1000).toFixed(1)}s`);

  // Phase 5: Trading signals (optional, non-fatal)
  let trading: TradingSection | null = null;
  try {
    trading = cachedRun && customKeywords.length > 0
      ? loadCachedReport(date)?.trading ?? null
      : await runTrading();
  } catch (e) {
    console.warn(`[daily] trading section failed: ${e instanceof Error ? e.message : e}`);
  }

  // Phase 6: Generate digest (hero headlines + briefs + keywords)
  console.log(`[daily] generating digest with ${getModelTag()}…`);
  const digestT0 = Date.now();
  const { report } = await generateDailyReport(articles);
  if (trading) report.trading = trading;
  console.log(`[daily] digest ready in ${((Date.now() - digestT0) / 1000).toFixed(1)}s`);

  const base = path.join(dateDir, date);
  const raw = groupRaw(articles, sources, { customKeywords });

  // Phase 7: Deterministic category summaries from already-enriched visible
  // items. This avoids five additional LLM calls and keeps the overview tied
  // to exactly what the reader can inspect below.
  console.log(`[daily] composing category summaries…`);
  const catSummaries: Record<string, string> = {};
  const catT0 = Date.now();
  // Build a lookup map for source subcategories
  const sourceSubcat = new Map(sources.map((s) => [s.id, s.subcategory]));
  const SUMMARY_CONFIG = [
    ...CATEGORY_CONFIG,
    { key: "community", label: "社区讨论", filter: (a: ArticleInput) =>
      ["cn-community", "overseas-community", "blog-weekly"].includes(sourceSubcat.get(a.sourceId) ?? "") },
  ];
  for (const cfg of SUMMARY_CONFIG) {
    const items = articles
      .filter((a) => cfg.filter(a) && !!a.summary)
      .sort((a, b) => (b.importance ?? 5) - (a.importance ?? 5))
      .slice(0, 3);
    if (items.length === 0) continue;
    catSummaries[cfg.key] = items
      .map((article) => `${article.displayTitle ?? article.title}：${article.summary}`)
      .join("；")
      .slice(0, 320);
  }
  const catMatched = SUMMARY_CONFIG.filter((c) => catSummaries[c.key]).length;
  console.log(`[daily] category summaries done in ${((Date.now() - catT0) / 1000).toFixed(1)}s, ${catMatched}/${SUMMARY_CONFIG.length}`);

  // Phase 8: AI Review — final quality check before publishing
  console.log(`[daily] running AI quality review…`);
  const reviewT0 = Date.now();
  const reviewInput = CATEGORY_CONFIG.map((cfg) => {
    const items = (visibleByCategory.get(cfg.key) ?? []).filter((a) => !!a.summary).slice(0, 8);
    const lines = items.map((a) => `  - [${a.source}] [媒体所属国 ${a.sourceCountry ?? "未知"}] [涉及国家 ${(a.coverageCountries ?? []).join("、") || "未明确"}] [重要度 ${a.importance ?? 0}/10] 展示标题：${a.displayTitle ?? a.title}；原始标题：${a.title}；原文摘录：${(a.excerpt ?? "").slice(0, 260)}；AI摘要：${a.summary}`);
    return `【${cfg.label}】(${items.length}条)\n${lines.join("\n")}`;
  }).join("\n\n");
  const review: ReviewResult = await aiReview(reviewInput);
  console.log(`[daily] AI review done in ${((Date.now() - reviewT0) / 1000).toFixed(1)}s — ${review.passed ? "✅ PASSED" : "⚠️ ISSUES FOUND"}`);
  if (review.issues.length > 0) {
    for (const issue of review.issues) console.warn(`  [review] ${issue}`);
  }
  if (!review.passed) {
    appendRunLog(date, `blocked by AI quality review: ${review.issues.join("; ")}`);
    throw new Error(`AI quality review did not pass: ${review.summary}`);
  }

  // Write output files
  runStats.generatedAt = new Date().toISOString();
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(
    `${base}-articles.json`,
    JSON.stringify({ date, articles, failedSources, runStats, filterProfile }, null, 2),
    "utf8",
  );
  fs.writeFileSync(`${base}.html`, renderHtml(report, raw, date, failedSources, catSummaries, review, runStats, filterProfile), "utf8");
  if (process.env.OUTPUT_MARKDOWN === "true") {
    fs.writeFileSync(`${base}.md`, renderMarkdown(report, date), "utf8");
    console.log(`[daily] wrote ${base}.{json,html,md,articles.json}`);
  } else {
    console.log(`[daily] wrote ${base}.{json,html,articles.json}`);
  }

  console.log(`[daily] done.`);
  appendRunLog(date, "completed successfully");
}

main()
  .then(() => {
    // Some HTTP clients retain keep-alive handles after all output is written.
    // A scheduled run must terminate so later publish steps can start.
    process.exit(0);
  })
  .catch((e) => {
    const date = todayKey();
    appendRunLog(date, `FAILED: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    console.error(`[daily] FAILED:`, e);
    process.exit(1);
  });
