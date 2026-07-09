import "./_env";

import fs from "node:fs";
import path from "node:path";

import { sources, REPORT_LOCALE } from "../lib/sources/registry";
import { fetchSource } from "../lib/sources/dispatch";
import {
  generateDailyReport,
  type ArticleInput,
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
  enrichCategorySummary,
  type EnrichInput,
} from "../lib/ai/enrich";
import {
  groupRaw,
  isSportsArticle,
  MERGED_SUBGROUP_LIMITS,
  renderHtml,
  renderMarkdown,
} from "../lib/output/render";
import { analyzeWatchlist } from "../lib/trading/runner";
import { fetchCryptoFearGreed } from "../lib/trading/fear-greed";
import { fetchCryptoGlobal } from "../lib/trading/coingecko";
import { generateTradingCommentary } from "../lib/ai/trading-commentary";
import type { TradingSection } from "../lib/ai/pipeline";
import { todayKey } from "../lib/utils";

const OUTPUT_DIR = "daily_reports";
const CACHE_DIR = ".cache";

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

/**
 * Fetch all enabled sources with concurrency control.
 * Serial fetching of 50+ sources means worst-case ~13 min (15s timeout × 54).
 * Parallel batches of 10 cut that to ~2 min worst-case.
 */
async function fetchAll(batchSize = 5): Promise<{ articles: ArticleInput[]; failedSources: Array<{ id: string; name: string; reason: string }> }> {
  const articles: ArticleInput[] = [];
  const failedSources: Array<{ id: string; name: string; reason: string }> = [];
  const enabled = sources.filter((s) => s.enabled !== false);
  for (let i = 0; i < enabled.length; i += batchSize) {
    const batch = enabled.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (source) => {
        const items = await fetchSource(source);
        return { source, items };
      }),
    );
    for (const res of results) {
      if (res.status === "fulfilled") {
        const { source, items } = res.value;
        console.log(`  ${source.id.padEnd(20)} ${items.length}`);
        articles.push(...items.map((it) => ({ ...it, source: source.name })));
      } else {
        const reason = res.reason instanceof Error ? res.reason.message : String(res.reason);
        const failedIdx = results.indexOf(res);
        const failedSource = batch[failedIdx];
        const id = failedSource?.id ?? "unknown";
        console.error(`  ${id.padEnd(20)} FAILED — ${reason}`);
        failedSources.push({ id, name: failedSource?.name ?? id, reason });
      }
    }
  }
  return { articles, failedSources };
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
  // Fail fast on misconfigured backend before we spend 30s fetching
  // 500+ articles only to discover the LLM has no credentials.
  validateBackendCredentials();

  const date = todayKey();
  console.log(`[daily] ${date} — fetching sources…\n`);
  const { articles, failedSources } = await fetchAll();
  console.log(`\n[daily] total articles: ${articles.length}, failed sources: ${failedSources.length}`);
  if (articles.length === 0) {
    throw new Error("no articles fetched — aborting");
  }

  // Enrich in two parallel batches to cut total wall-clock time.
  //
  // Batch 1 (independent, ~5 concurrent LLM calls):
  //   GH Trending, Papers, Finance, Politics, AI News
  // Batch 2 (depends on batch 1 for tag coverage):
  //   Trending (Google Trends + Reddit), X Viral, Tags
  //
  // Previously these ran serially (8 calls × up to 80s each = 640s worst-case).
  // Now batch 1 takes ~80s, batch 2 takes ~80s → ~160s total.
  console.log(`[daily] enriching batch 1 (GH + Papers + Finance + Politics + AI News)…`);
  const enrichT0 = Date.now();
  await Promise.allSettled([
    enrichGhTrending(articles, date),
    enrichTrendingPapers(articles, date),
    enrichFinanceNews(articles, date),
    enrichPolitics(articles, date),
    enrichAiNews(articles, date),
  ]);
  console.log(`[daily] batch 1 done in ${((Date.now() - enrichT0) / 1000).toFixed(1)}s`);

  console.log(`[daily] enriching batch 2 (Trending + XViral + Tags)…`);
  const enrichT1 = Date.now();
  await Promise.allSettled([
    enrichTrending(articles, date),
    enrichXViral(articles, date),
    enrichTags(articles, date),
  ]);
  console.log(`[daily] batch 2 done in ${((Date.now() - enrichT1) / 1000).toFixed(1)}s`);
  console.log(`[daily] all enrichment done in ${((Date.now() - enrichT0) / 1000).toFixed(1)}s`);

  // Category-level AI summaries: one concise overview per category section.
  // Runs after all article-level enrichment so summaries are available.
  console.log(`[daily] generating category-level summaries…`);
  const catSummaries: Record<string, string> = {};
  const catT0 = Date.now();
  const CATEGORIES: Array<{ key: string; name: string; filter: (a: ArticleInput) => boolean }> = [
    { key: "trending", name: "热搜趋势", filter: (a) => a.category === "trending" && !!a.summary },
    { key: "tech", name: "技术动态", filter: (a) => a.category === "tech" && !!a.summary },
    { key: "finance", name: "财经要点", filter: (a) => a.category === "finance" && !!a.summary },
    { key: "politics", name: "国际时政", filter: (a) => a.category === "politics" && !!a.summary },
  ];
  await Promise.allSettled(CATEGORIES.map(async (cat) => {
    const items = articles.filter(cat.filter).slice(0, 30);
    if (items.length === 0) return;
    const summary = await enrichCategorySummary(
      cat.name,
      items.map((a) => ({ url: a.url, title: a.title, excerpt: a.summary, source: a.source })),
    );
    if (summary) catSummaries[cat.key] = summary;
  }));
  const catMatched = CATEGORIES.filter((c) => catSummaries[c.key]).length;
  console.log(`[daily] category summaries done in ${((Date.now() - catT0) / 1000).toFixed(1)}s, ${catMatched}/${CATEGORIES.length} sections`);

  // Trading signals: Yahoo fetch + indicators + commentary. Non-fatal —
  // if it errors, we still ship the news digest.
  let trading: TradingSection | null = null;
  try {
    trading = await runTrading();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[daily] trading section failed: ${msg}`);
  }

  console.log(`[daily] generating digest with ${getModelTag()}…`);
  const t0 = Date.now();
  const { report } = await generateDailyReport(articles);
  if (trading) report.trading = trading;
  console.log(`[daily] digest ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const dateDir = path.join(OUTPUT_DIR, date);
  fs.mkdirSync(dateDir, { recursive: true });
  const base = path.join(dateDir, date);
  const raw = groupRaw(articles, sources);
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2), "utf8");
  // Sidecar with all fetched articles + LLM-attached summary, so
  // scripts/render.ts can rebuild HTML/MD for UI iteration without
  // re-fetching or re-calling the LLM.
  fs.writeFileSync(
    `${base}-articles.json`,
    JSON.stringify({ date, articles, failedSources }, null, 2),
    "utf8",
  );
  fs.writeFileSync(`${base}.html`, renderHtml(report, raw, date, failedSources, catSummaries), "utf8");
  if (process.env.OUTPUT_MARKDOWN === "true") {
    fs.writeFileSync(`${base}.md`, renderMarkdown(report, date), "utf8");
    console.log(`[daily] wrote ${base}.{json,html,md,articles.json}`);
  } else {
    console.log(`[daily] wrote ${base}.{json,html,articles.json}`);
  }

  console.log(`[daily] done.`);
}

main().catch((e) => {
  console.error(`[daily] FAILED:`, e);
  process.exit(1);
});
