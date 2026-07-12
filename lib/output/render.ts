import type {
  ArticleInput,
  BriefItem,
  DailyReport,
  TradingSection,
} from "../ai/pipeline";
import type { WatchlistPick } from "../ai/trading-commentary";
import { REPORT_LOCALE, sources } from "../sources/registry";
import { getReportTz } from "../utils";
import type { Category, SourceDef } from "../sources/types";
import { V2EX_OFF_TOPIC_RE } from "../sources/v2ex";
import {
  BASE_FILTER_RULES_EN,
  BASE_FILTER_RULES_ZH,
  detectCoverageCountries,
  matchCustomKeywords,
  normalizeCustomKeywords,
  politicsAttribution,
} from "../editorial/context";
import type { TickerAnalysis } from "../trading/signals";
import {
  getAssetGroupLabels,
  ASSET_GROUP_ORDER,
  type AssetGroup,
} from "../trading/watchlist";

// ----- i18n -----

/**
 * Localized UI strings. `t` resolves to TEXTS_ZH or TEXTS_EN at module
 * init based on REPORT_LOCALE. All hardcoded display text routes through
 * this object so adding a third locale = adding one more table.
 */
const TEXTS_ZH = {
  siteTitle: "每日简报",
  catTrending: "🔥 热搜趋势",
  catTech: "🧑‍💻 技术动态",
  catFinance: "💰 财经要点",
  catPolitics: "🌍 国际时政",
  catTrading: "📈 市场行情",
  catCommunity: "💬 社区讨论",
  subAiNews: "AI 媒体",
  subTrendingPapers: "热门论文",
  subXViral: "X 推文",
  subBlogWeekly: "博客周刊",
  subCnCommunity: "中文社区",
  subOverseasCommunity: "海外社区",
  subFinanceNews: "财经新闻",
  subFinanceCommunity: "社区讨论",
  subWorld: "国际要闻",
  subOverseasNews: "海外科技",
  subOverseas: "海外",
  emptySource: "该源今日无内容。",
  emptyCategory: "该分类今日无内容。",
  emptyGroup: "该组今日无数据。",
  footer: "内容均来自原媒体，本站仅作摘要整理与回链。",
  summaryLabelNews: "中文摘要",
  summaryLabelIntro: "中文摘要",
  tradingMarketOverview: "市场总览",
  tradingTodayFocus: "今日关注",
  tradingAllAssets: "全部资产",
  tradingRiskCaveat: "风险提示",
  widgetCryptoFearGreed: "加密恐慌贪婪",
  widgetCryptoCap: "加密总市值",
  widgetBtcDom: "BTC 主导率",
  widgetVolume24h: "24h 成交量",
  widgetActiveCoins: "活跃币",
  ticker5d: "5 日",
  tickerVs52wHigh: "距 52w 高",
  tickerTrend: "趋势",
  tickerMacd: "MACD / 信号",
  signalToday: "今天",
  signalDaysAgoSuffix: "天前",
  trendBullish: "多头",
  trendBearish: "空头",
  trendNeutral: "中性",
  mdTodayOverview: "今日总览",
  mdEditorNote: "编辑短评",
  mdTodayKeywords: "今日关键词",
  mdImportance: "重要度",
  archiveLink: "← 历史归档",
};

const TEXTS_EN: typeof TEXTS_ZH = {
  siteTitle: "Daily Brief",
  catTrending: "🔥 Trending",
  catTech: "💻 Tech",
  catFinance: "💰 Finance",
  catPolitics: "🌍 World",
  catTrading: "📈 Markets",
  catCommunity: "💬 Community",
  subAiNews: "AI Media",
  subTrendingPapers: "Trending Papers",
  subXViral: "X Viral",
  subBlogWeekly: "Blog Weekly",
  subCnCommunity: "Chinese Community",
  subOverseasCommunity: "Overseas Community",
  subFinanceNews: "Finance News",
  subFinanceCommunity: "Community",
  subWorld: "World News",
  subOverseasNews: "Overseas Tech",
  subOverseas: "Overseas",
  emptySource: "No content from this source today.",
  emptyCategory: "No content in this category today.",
  emptyGroup: "No data for this group today.",
  footer:
    "Content sourced from original publishers; this site provides summary and backlinks only.",
  summaryLabelNews: "Summary",
  summaryLabelIntro: "Summary",
  tradingMarketOverview: "Market Overview",
  tradingTodayFocus: "Today's Focus",
  tradingAllAssets: "All Assets",
  tradingRiskCaveat: "Risk Disclaimer",
  widgetCryptoFearGreed: "Crypto Fear/Greed",
  widgetCryptoCap: "Crypto Market Cap",
  widgetBtcDom: "BTC Dominance",
  widgetVolume24h: "24h Volume",
  widgetActiveCoins: "Active coins",
  ticker5d: "5d",
  tickerVs52wHigh: "vs 52w High",
  tickerTrend: "Trend",
  tickerMacd: "MACD / Signal",
  signalToday: "today",
  signalDaysAgoSuffix: "d ago",
  trendBullish: "Bullish",
  trendBearish: "Bearish",
  trendNeutral: "Neutral",
  mdTodayOverview: "Today's Overview",
  mdEditorNote: "Editor's Note",
  mdTodayKeywords: "Keywords",
  mdImportance: "Importance",
  archiveLink: "← Archive",
};

const STR = REPORT_LOCALE === "en" ? TEXTS_EN : TEXTS_ZH;
const ASSET_GROUP_LABELS_LOCALIZED = getAssetGroupLabels(REPORT_LOCALE);

// ----- types -----

export type SourceGroup = {
  sourceId: string;
  sourceName: string;
  items: ArticleInput[];
  /**
   * When true, items come from multiple merged sources and the renderer
   * should label each article with `a.source` since the source-tab row
   * is suppressed (only one synthetic group).
   */
  merged?: boolean;
};

export type SubGroup = {
  id: string;
  name: string;
  sources: SourceGroup[];
};

export type RawByCategory = Record<Category, SubGroup[]>;

export type RunStats = {
  fetchedSources: number;
  successfulSources: number;
  sourceSuccessRate: number;
  fetchedArticles: number;
  dedupedArticles: number;
  generatedAt: string;
  mode: "fresh" | "reuse";
};

export type FilterProfile = {
  baseRules: string;
  customKeywords: string[];
  mode: "base" | "incremental";
};

// ----- labels & ordering -----

const CATEGORY_LABELS: Record<Category, string> = {
  trending: STR.catTrending,
  tech: STR.catTech,
  finance: STR.catFinance,
  politics: STR.catPolitics,
};

const CATEGORY_DIGEST_LABELS: Record<Category, string> = {
  trending: STR.catTrending,
  tech: STR.catTech,
  finance: STR.catFinance,
  politics: STR.catPolitics,
};

/**
 * L2 ordering per category. Categories not listed render flat (no L2 tabs).
 */
const SUBCATEGORY_ORDER: Partial<Record<Category, string[]>> = {
  // cn-community + overseas-community are listed last so the L1 "community"
  // panel (rendered separately via TECH_COMMUNITY_SUBS) can extract them.
  // Within the "tech" L1 panel itself, COMMUNITY_SUBS is filtered out.
  // Locale filtering at registry level decides which actually appears:
  // zh mode keeps cn-community (V2EX / LinuxDo); en mode keeps
  // overseas-community (Hacker News / r/stocks).
	  trending: ["google-trends", "cn-trending", "reddit-trending"],
  tech: ["github-trending", "trending-papers", "x-viral", "ai-news", "overseas-news", "overseas", "blog-weekly", "cn-community", "overseas-community"],
  finance: ["news"],
  politics: ["uk", "us", "france", "japan", "india", "east-asia", "other"],
};

const TECH_MAIN_SUBS = new Set(["github-trending", "trending-papers", "x-viral", "ai-news", "overseas-news", "overseas", "blog-weekly"]);
const TECH_COMMUNITY_SUBS = new Set(["cn-community", "overseas-community"]);

const SUBCATEGORY_LABELS: Record<string, string> = {
	  "google-trends": "Google 热搜",
	  "cn-trending": "🔥 中文热搜",
	  "reddit-trending": "Reddit 热门",
  "github-trending": "GitHub Trending",
  "trending-papers": STR.subTrendingPapers,
  "cn-community": STR.subCnCommunity,
  "overseas-community": STR.subOverseasCommunity,
  "ai-news": STR.subAiNews,
  "x-viral": STR.subXViral,
  "overseas-news": REPORT_LOCALE === "en" ? "Technology News" : "海外科技",
  overseas: REPORT_LOCALE === "en" ? "Industry Media" : "产业媒体",
  "blog-weekly": STR.subBlogWeekly,
  news: STR.subFinanceNews,
  uk: "🇬🇧 英国",
  us: "🇺🇸 美国",
  france: "🇫🇷 法国",
  japan: "🇯🇵 日本",
  india: "🇮🇳 印度",
  "east-asia": "🌏 东亚",
  other: "🌐 其他",
  world: STR.subWorld,
};

/**
 * Per-source item caps in the raw display, keyed by "category:subcategory".
 * Each source inside the subcategory shows up to N items. Missing keys = no cap.
 *
 * Default 20 across all L3-tabbed subcategories keeps each tab a single
 * comfortable scroll instead of 25-30 items. Merged subgroups (blog-weekly,
 * finance:news, politics:world) ignore this — they use MERGED_SUBGROUP_LIMITS.
 */
const SOURCE_DISPLAY_LIMITS: Record<string, number> = {
  "tech:github-trending": 10,
  "tech:cn-community": 10,
  "tech:overseas-community": 10,
  "tech:x-viral": 8,
  "tech:trending-papers": 10,
};

/**
 * Sources whose fetcher returns items already sorted by an engagement/heat
 * algorithm we want to preserve. groupRaw skips its default date-desc sort
 * for these so the final render reflects the source's own ranking.
 */
const PRESERVE_FETCH_ORDER_SOURCES = new Set([
  "attentionvc-ai",
  "huggingface-papers",
]);

function displayLimitFor(
  category: Category,
  subId: string | undefined,
): number | undefined {
  if (!subId) return undefined;
  return SOURCE_DISPLAY_LIMITS[`${category}:${subId}`];
}

/**
 * Subcategories that should collapse their sources into a single flat
 * time-sorted list (no L3 source tabs), keyed by "category:subcategory".
 * Value = number of items kept after merging. Each rendered article
 * will display its `source` label inline since the per-source tab row
 * is suppressed.
 *
 * Used when:
 *  - sources are heterogeneous but each publishes few items (blog-weekly)
 *  - the user explicitly wants a curated time-sorted feed rather than
 *    per-source browsing (finance:news, only authoritative sources)
 *
 * Exported so daily.ts can read the cap to keep enrichment in sync.
 */
export const MERGED_SUBGROUP_LIMITS: Record<string, number> = {
	  "trending:google-trends": 10,
	  "trending:cn-trending": 10,
	  "trending:reddit-trending": 10,
	  "tech:ai-news": 12,
	  "tech:overseas-news": 10,
	  "tech:overseas": 10,
	  "tech:blog-weekly": 6,
	  "finance:news": 12,
	  "politics:uk": 6,
	  "politics:us": 6,
	  "politics:france": 6,
	  "politics:japan": 6,
	  "politics:india": 6,
	  "politics:east-asia": 6,
	  "politics:other": 6,
};

/**
 * Politics sources (especially Al Jazeera / BBC / The Diplomat) regularly
 * mix in World Cup / Olympic / football coverage. Filter at the title level
 * so the merged "国际要闻" stream stays politics-only.
 *
 * Pattern is intentionally specific — avoid generic words like "team" or
 * "match" that overlap with diplomacy headlines.
 */
const POLITICS_SPORTS_RE =
  /\b(World\s*Cup|Olympics?|UEFA|FIFA|NBA|NFL|NHL|MLB|ATP|WTA|Premier\s*League|Bundesliga|La\s*Liga|Serie\s*A|Champions\s*League|Eurovision|Wimbledon|Grand\s*Slam|F1|Formula\s*1|Ronaldo|Messi|Mbappe|Beckham|Lukaku|Mitoma|sportsman|footballer|squad)\b|世界杯|奥运|残奥|冬奥|欧冠|英超|西甲|意甲|德甲|网球|足球|篮球|高尔夫|棒球|板球|橄榄球/i;

export function isSportsArticle(title: string): boolean {
  return POLITICS_SPORTS_RE.test(title);
}

function mergedLimitFor(
  category: Category,
  subId: string,
): number | undefined {
  return MERGED_SUBGROUP_LIMITS[`${category}:${subId}`];
}

// ----- grouping -----

export function groupRaw(
  articles: ArticleInput[],
  registry: SourceDef[],
  options: { customKeywords?: string[] } = {},
): RawByCategory {
  const customKeywords = normalizeCustomKeywords(options.customKeywords);
  const subcatOf = new Map<string, string | undefined>();
  for (const s of registry) subcatOf.set(s.id, s.subcategory);
  // Drop articles from sources that have since been disabled — important
  // when scripts/render.ts re-renders against a stale sidecar that still
  // contains the disabled sources' fetched data.
  const enabledIds = new Set(
    registry.filter((s) => s.enabled !== false).map((s) => s.id),
  );

  type Bucket = { sourceName: string; items: ArticleInput[] };
  const buckets: Record<Category, Map<string, Bucket>> = {
    trending: new Map(),
    tech: new Map(),
    finance: new Map(),
    politics: new Map(),
  };
  // Pre-seed empty buckets for every enabled source so per-source-tabbed
  // subcategories (e.g. cn-community) still render a tab for sources that
  // returned 0 items today. Without this, a transient LinuxDo Cloudflare
  // block would silently collapse the L3 tab nav, making users wonder
  // whether the other forum even exists.
  for (const s of registry) {
    if (s.enabled === false) continue;
    if (!buckets[s.category].has(s.id)) {
      buckets[s.category].set(s.id, { sourceName: s.name, items: [] });
    }
  }

  for (const a of articles) {
    if (!enabledIds.has(a.sourceId)) continue;
    if (a.category === "politics" && isSportsArticle(a.title)) continue;
    if (
      (a.sourceId === "v2ex-hot" || a.sourceId === "linuxdo") &&
      V2EX_OFF_TOPIC_RE.test(a.title)
    )
      continue;
    const map = buckets[a.category];
    let b = map.get(a.sourceId);
    if (!b) {
      b = { sourceName: a.source, items: [] };
      map.set(a.sourceId, b);
    }
    b.items.push(a);
  }

  for (const cat of Object.keys(buckets) as Category[]) {
    for (const [id, b] of buckets[cat].entries()) {
      if (PRESERVE_FETCH_ORDER_SOURCES.has(id) && customKeywords.length === 0) continue;
      b.items.sort((a, b) => {
        const interestDelta = matchCustomKeywords(b, customKeywords).length - matchCustomKeywords(a, customKeywords).length;
        if (interestDelta !== 0) return interestDelta;
        return (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0);
      });
    }
  }

  function toSourceGroup(
    sourceId: string,
    b: Bucket,
    limit: number | undefined,
  ): SourceGroup {
    return {
      sourceId,
      sourceName: b.sourceName,
      items: limit ? b.items.slice(0, limit) : b.items,
    };
  }

  function sortByRegistry(list: SourceGroup[]): SourceGroup[] {
    return [...list].sort((a, b) => {
      const ia = registry.findIndex((s) => s.id === a.sourceId);
      const ib = registry.findIndex((s) => s.id === b.sourceId);
      return ia - ib;
    });
  }

  const out: RawByCategory = { trending: [], tech: [], finance: [], politics: [] };

  for (const cat of Object.keys(buckets) as Category[]) {
    const order = SUBCATEGORY_ORDER[cat];
    if (!order) {
      // Flat: one synthetic subgroup with every source.
      const sources: SourceGroup[] = [];
      for (const [id, b] of buckets[cat].entries()) {
        sources.push(toSourceGroup(id, b, undefined));
      }
      out[cat] = sources.length
        ? [{ id: "all", name: CATEGORY_LABELS[cat], sources: sortByRegistry(sources) }]
        : [];
      continue;
    }
    // Subcategory split: bucket each source under its registered subcategory.
    const subs: SubGroup[] = [];
    for (const subId of order) {
      const mergeLimit = mergedLimitFor(cat, subId);
      if (mergeLimit !== undefined) {
        // Merge: round-robin across sources preserving each source's
        // natural feed order (which reflects editorial priority / heat),
        // rather than flattening by date. This ensures top stories from
        // each source get equal opportunity regardless of publish time.
	        const sourceBuckets: ArticleInput[][] = [];
		        for (const [id, b] of buckets[cat].entries()) {
	          if (subcatOf.get(id) === subId) sourceBuckets.push(b.items);
	        }
	        if (sourceBuckets.length === 0) continue;
	        const merged: ArticleInput[] = [];
	        let madeProgress = true;
	        while (merged.length < mergeLimit && madeProgress) {
	          madeProgress = false;
	          for (const b of sourceBuckets) {
	            if (b.length === 0) continue;
	            merged.push(b.shift()!);
	            madeProgress = true;
	            if (merged.length >= mergeLimit) break;
	          }
	        }
        subs.push({
          id: subId,
          name: SUBCATEGORY_LABELS[subId] ?? subId,
          sources: [
            {
              sourceId: "_merged",
              sourceName: SUBCATEGORY_LABELS[subId] ?? subId,
	              items: merged.slice(0, mergeLimit),
              merged: true,
            },
          ],
        });
        continue;
      }

      const limit = displayLimitFor(cat, subId);
      const sources: SourceGroup[] = [];
      for (const [id, b] of buckets[cat].entries()) {
        if (subcatOf.get(id) === subId) sources.push(toSourceGroup(id, b, limit));
      }
      if (sources.length === 0) continue;
      subs.push({
        id: subId,
        name: SUBCATEGORY_LABELS[subId] ?? subId,
        sources: sortByRegistry(sources),
      });
    }
    out[cat] = subs;
  }

  return out;
}

// ----- HTML helpers -----

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function formatDate(d: Date | undefined): string {
  if (!d) return "";
  try {
    // zh: "05/20 16:00"  · en: "May 20, 4:00 PM" → keep 24h en-GB style "20/05 16:00"
    const localeTag = REPORT_LOCALE === "en" ? "en-GB" : "zh-CN";
    return d.toLocaleString(localeTag, {
      timeZone: getReportTz(),
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "";
  }
}

// ----- raw article renderers -----

function renderArticleHtml(a: ArticleInput, showSource = false): string {
  const title = escapeHtml(a.displayTitle ?? a.title);
  const externalUrl = safeExternalUrl(a.url);
  const url = externalUrl ? escapeHtml(externalUrl) : "";
  const excerpt = a.excerpt ? escapeHtml(a.excerpt) : "";
  // Backwards-compat: old sidecar JSON files may carry `cnSummary` instead.
  const summaryText = a.summary ?? (a as unknown as { cnSummary?: string }).cnSummary;
  const summary = summaryText ? escapeHtml(summaryText) : "";
  const importance = Number.isFinite(a.importance) ? Math.max(1, Math.min(10, Math.round(a.importance!))) : null;
  const stats = a.meta ? escapeHtml(a.meta) : "";
  const time = formatDate(a.publishedAt);
  const sourceLabel = showSource && a.source ? escapeHtml(a.source) : "";
  const sourceDef = sources.find((source) => source.id === a.sourceId);
  const sourceCountry = a.sourceCountry ?? sourceDef?.originCountry;
  const coverageCountries = a.coverageCountries?.length
    ? a.coverageCountries
    : detectCoverageCountries(`${a.title} ${a.excerpt ?? ""} ${a.summary ?? ""}`);
  const attribution = a.category === "politics"
    ? politicsAttribution(sourceCountry, coverageCountries)
    : "";
  const attributionHtml = attribution
    ? `<span class="article-attribution">${escapeHtml(attribution)}</span>`
    : "";
  // For merged subgroups (politics/finance/trending), the source name + time
  // identifies the article → no need for the full English headline.
  // For per-source tabs (GH Trending, Papers, X), show a brief title.
  // When showSource is true, we're inside a merged group → hide the title.
  const showTitle = !showSource;
  // Build meta line: source name (clickable link) + rest of meta
  let metaHtml = "";
  if (sourceLabel && url) {
    const sourceLink = `<a href="${url}" target="_blank" rel="noopener noreferrer" class="article-source-link">${sourceLabel}</a>`;
    metaHtml = [attributionHtml, sourceLink, time].filter(Boolean).join(" · ");
  } else if (sourceLabel) {
    metaHtml = [attributionHtml, sourceLabel, time].filter(Boolean).join(" · ");
  } else if (time) {
    metaHtml = [attributionHtml, time].filter(Boolean).join(" · ");
  } else {
    metaHtml = attributionHtml;
  }
  // News-style summary label for finance/politics, project-intro style for GH/tech.
  const newsy = a.category === "trending" || a.category === "finance" || a.category === "politics";
  const summaryLabel = newsy ? STR.summaryLabelNews : STR.summaryLabelIntro;
  // Content attribute tags
  const interestMatches = a.interestMatches ?? [];
  const tags = a.tags && a.tags.length > 0 ? a.tags : null;
  const tagAttr = tags ? ` data-tags="${escapeHtml(tags.join(","))}"` : "";

  return `<article class="article"${tagAttr}>
    ${metaHtml || importance ? `<p class="article-meta">${metaHtml}${metaHtml && importance ? " · " : ""}${importance ? `<span class="article-importance importance-${importance >= 8 ? "high" : importance >= 5 ? "mid" : "low"}">${REPORT_LOCALE === "en" ? "Importance" : "重要度"} ${importance}/10</span>` : ""}</p>` : ""}
    ${showTitle ? `<h3 class="article-title">${url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${title}</a>` : title}</h3>` : ""}
    ${stats ? `<p class="article-stats">${stats}</p>` : ""}
    ${summary ? `<p class="article-summary">${summaryLabel ? `<span class="summary-label">${summaryLabel}</span> ` : ""}${summary}</p>` : ""}
    ${tags || interestMatches.length > 0 ? `<p class="article-tags">${(tags ?? []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}${interestMatches.map((keyword) => `<span class="tag interest-tag">兴趣：${escapeHtml(keyword)}</span>`).join("")}</p>` : ""}
    ${excerpt && !(REPORT_LOCALE === "zh" && summary) ? `<p class="article-excerpt">📎 ${excerpt}</p>` : ""}
    ${url && (metaHtml || showTitle) ? `<a href="${url}" target="_blank" rel="noopener noreferrer" class="article-permalink" title="${escapeHtml(a.title)}">🔗</a>` : ""}
  </article>`;
}

function renderSourceContent(
  category: Category,
  subId: string,
  source: SourceGroup,
  isActive: boolean,
): string {
  const showSource = source.merged === true;
  // Filter out articles that have no meaningful content:
  // must have either a summary, or an excerpt longer than 30 chars, or a title.
  // This prevents "empty" article cards from occupying space.
  const visibleItems = source.items.filter(
    (a) => a.summary || (a.excerpt && a.excerpt.length > 30) || a.title,
  );
  if (visibleItems.length === 0) return "";
  return `<div class="source-content${isActive ? " active" : ""}" data-source-content="${escapeHtml(source.sourceId)}" data-sub="${escapeHtml(subId)}" data-cat="${category}">
    ${visibleItems.map((a) => renderArticleHtml(a, showSource)).join("\n")}
  </div>`;
}

function renderSourceTabs(
  category: Category,
  subId: string,
  sources: SourceGroup[],
): string {
  // Single-source L2s (X 推文 / GitHub Trending) skip the L3 row — the L2 tab
  // label already identifies the dataset. L3 only earns its row when there
  // are ≥2 sources to switch between (e.g. 社区讨论 V2EX vs LinuxDo).
  if (sources.length < 2) return "";
  return `<nav class="source-tabs"><button class="source-tab" data-source="__all__" data-sub="${escapeHtml(subId)}" data-cat="${category}">${REPORT_LOCALE === "en" ? "All" : "全部"}<span class="count">${sources.reduce((n, s) => n + s.items.length, 0)}</span></button>${sources
    .map(
      (s, i) =>
        `<button class="source-tab${i === 0 ? " active" : ""}" data-source="${escapeHtml(s.sourceId)}" data-sub="${escapeHtml(subId)}" data-cat="${category}">${escapeHtml(s.sourceName)}<span class="count">${s.items.length}</span></button>`,
    )
    .join("")}</nav>`;
}

function renderSubContent(category: Category, sub: SubGroup, isActive: boolean): string {
  return `<div class="sub-content${isActive ? " active" : ""}" data-sub-content="${escapeHtml(sub.id)}" data-cat="${category}">
    ${renderSourceTabs(category, sub.id, sub.sources)}
    <div class="source-contents">
      ${sub.sources.map((s, i) => renderSourceContent(category, sub.id, s, i === 0)).join("\n")}
    </div>
  </div>`;
}

function renderRawCategoryPanel(
  category: Category,
  subs: SubGroup[],
  categoryKey?: string,
  categorySummaries?: Record<string, string>,
): string {
  const summaryHtml = categoryKey ? renderCategorySummary(categoryKey, categorySummaries) : "";
  // Filter out completely empty sub-groups (all sources returned 0 items)
  const nonEmpty = subs.filter(s => s.sources.some(src => src.items.length > 0));
  if (nonEmpty.length === 0) {
    return summaryHtml + `<p class="empty">${STR.emptyCategory}</p>`;
  }
  if (nonEmpty.length === 1) {
    return summaryHtml + renderSubContent(category, nonEmpty[0], true);
  }
  const subTabs = nonEmpty
    .map((s, i) => {
      const count = s.sources.reduce((n, src) => n + src.items.length, 0);
      return `<button class="sub-tab${i === 0 ? " active" : ""}" data-sub="${escapeHtml(s.id)}" data-cat="${category}">${escapeHtml(s.name)}<span class="count">${count}</span></button>`;
    })
    .join("");
  const panels = nonEmpty
    .map((s, i) => renderSubContent(category, s, i === 0))
    .join("\n");
  return `<nav class="sub-tabs">${subTabs}</nav>\n<div class="sub-contents">${panels}</div>`;
}

// ----- tag cloud -----

interface TagEntry {
  tag: string;
  count: number;
}

/**
 * Collect all tags across every article in the raw data, count frequency,
 * and return sorted by count descending. Takes at most topN tags.
 */
function buildTagCloud(raw: RawByCategory, topN = 50): TagEntry[] {
  const freq = new Map<string, number>();
  for (const cat of Object.keys(raw) as Category[]) {
    for (const sub of raw[cat]) {
      for (const sg of sub.sources) {
        for (const a of sg.items) {
          if (a.tags && a.tags.length > 0) {
            for (const t of a.tags) {
              freq.set(t, (freq.get(t) ?? 0) + 1);
            }
          }
        }
      }
    }
  }
  return Array.from(freq.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}

/**
 * Heat-level for a tag's popularity within the cloud.
 * Top 10% → 3 (hottest), 10-25% → 2, 25-50% → 1, bottom 50% → 0 (cool).
 */
function heatLevel(index: number, total: number): number {
  const pct = total > 1 ? index / (total - 1) : 0;
  if (pct < 0.1) return 3;
  if (pct < 0.25) return 2;
  if (pct < 0.5) return 1;
  return 0;
}

function renderTagCloud(tags: TagEntry[]): string {
  if (tags.length === 0) return "";
  const heading = REPORT_LOCALE === "en" ? "Hot Tags" : "热点标签";
  const heatColors = ["tag-heat-0", "tag-heat-1", "tag-heat-2", "tag-heat-3"];
  const allChips = tags.map((t, i) => {
    const cls = heatColors[heatLevel(i, tags.length)];
    return `<span class="tag-cloud-chip ${cls}" data-tag="${escapeHtml(t.tag)}">${escapeHtml(t.tag)}<sup class="tag-count">${t.count}</sup></span>`;
  }).join("");
  // Only show expand button when tags won't fit in one row (~10+ tags)
  const expandBtn = tags.length > 8
    ? `<button class="tag-cloud-expand" data-expanded="false">${REPORT_LOCALE === "en" ? `+${tags.length - 8} more` : `展开全部`}</button>`
    : "";
  return `<section class="tag-cloud">
    <p class="tag-cloud-heading">${heading}</p>
    <div class="tag-cloud-body${tags.length > 8 ? "" : " expanded"}">
      <div class="tag-cloud-fade"></div>
      ${allChips}
    </div>
    ${expandBtn}
  </section>`;
}

// ----- category summary -----

function renderCategorySummary(key: string, summaries?: Record<string, string>): string {
  const text = summaries?.[key];
  if (!text) return "";
  const label = REPORT_LOCALE === "en" ? "AI Summary" : "📋 AI 分析";
  return `<div class="category-summary">
    <span class="category-summary-eyebrow">${label}</span>
    <p>${escapeHtml(text)}</p>
  </div>`;
}

// ----- AI review panel -----

function reviewHtml(
  review?: { passed: boolean; summary: string; issues: string[]; suggestions: string[] },
): string {
  if (!review || !review.summary) return "";
  const cls = review.passed ? "passed" : "has-issues";
  const label = REPORT_LOCALE === "en" ? "AI Quality Review" : "📋 质量审核";
  const issueItems = (review.issues ?? []).map(
    (i) => `<p class="review-issue">⚠ ${escapeHtml(i)}</p>`,
  ).join("");
  return `<section class="review-panel ${cls}">
    <span class="review-eyebrow">${label}</span>
    <p class="review-text">${escapeHtml(review.summary)}</p>
    ${issueItems}
  </section>`;
}

function runStatsText(stats?: RunStats): string {
  if (!stats) return "";
  const success = `${(stats.sourceSuccessRate * 100).toFixed(1)}%`;
  const mode = stats.mode === "reuse"
    ? (REPORT_LOCALE === "en" ? "cache reuse" : "5小时内复用缓存")
    : (REPORT_LOCALE === "en" ? "fresh fetch" : "本次重新抓取");
  return REPORT_LOCALE === "en"
    ? `Sources ${stats.fetchedSources} · Articles ${stats.fetchedArticles} → ${stats.dedupedArticles} after dedup · Success ${success} · ${mode}`
    : `抓取信息源 ${stats.fetchedSources} · 信息 ${stats.fetchedArticles} → 去重后 ${stats.dedupedArticles} · 成功率 ${success} · ${mode}`;
}

function filterProfileText(profile: FilterProfile): { rules: string; keywords: string } {
  return {
    rules: profile.baseRules,
    keywords: profile.customKeywords.length > 0
      ? profile.customKeywords.join("、")
      : (REPORT_LOCALE === "en" ? "None" : "无（使用基础规则）"),
  };
}

// ----- top-level renderer -----

export function renderHtml(
  report: DailyReport,
  raw: RawByCategory,
  date: string,
  failedSources?: Array<{ id: string; name: string; reason: string }>,
  categorySummaries?: Record<string, string>,
  review?: { passed: boolean; summary: string; issues: string[]; suggestions: string[] },
  runStats?: RunStats,
  filterProfile?: FilterProfile,
): string {
  const trading = report.trading;
  const effectiveFilterProfile = filterProfile ?? {
    baseRules: REPORT_LOCALE === "en" ? BASE_FILTER_RULES_EN : BASE_FILTER_RULES_ZH,
    customKeywords: [],
    mode: "base" as const,
  };
  const filterText = filterProfileText(effectiveFilterProfile);
  const runEndpoint = process.env.DAILY_RUN_ENDPOINT || "/api/run";

  // Split tech raw subgroups: "tech" L1 panel (github-trending + ai-news)
  // vs. "community" L1 panel (cn-community). Keeps the registry simple
  // (V2EX/LinuxDo still live under category=tech) while exposing the
  // forums as their own top-level tab per UX preference.
  const techMainSubs = raw.tech.filter((s) => TECH_MAIN_SUBS.has(s.id));
  const techCommunitySubs = raw.tech.filter((s) => TECH_COMMUNITY_SUBS.has(s.id));

  const sumItems = (subs: SubGroup[]) =>
    subs.reduce(
      (n, sg) => n + sg.sources.reduce((m, s) => m + s.items.length, 0),
      0,
    );
	  const counts = {
	    trending: sumItems(raw.trending),
	    tech: sumItems(techMainSubs),
	    finance: sumItems(raw.finance),
	    politics: sumItems(raw.politics),
	    community: sumItems(techCommunitySubs),
	  };
  const tagCloudHtml = renderTagCloud(buildTagCloud(raw));
  const failedHtml = failedSources && failedSources.length > 0
    ? `<details class="failed-sources">
    <summary class="failed-sources-heading">${REPORT_LOCALE === "en" ? "Failed Sources" : "抓取失败源"}<span>${failedSources.length}</span></summary>
    ${failedSources.map((f) => `<div class="failed-source-item">
      <span class="failed-source-name">${escapeHtml(f.name)}</span>
      <span class="failed-source-reason" title="${escapeHtml(f.reason)}">${escapeHtml(f.reason.length > 60 ? f.reason.slice(0, 60) + "..." : f.reason)}</span>
      <button class="refetch-btn" data-source-id="${escapeHtml(f.id)}">${REPORT_LOCALE === "en" ? "Refetch" : "重新抓取"}</button>
    </div>`).join("")}
  </details>`
    : "";
  const githubRepository = process.env.GITHUB_REPOSITORY ?? "";
  const actionsUrl = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepository)
    ? `https://github.com/${githubRepository}/actions/workflows/daily.yml`
    : "";

  return `<!doctype html>
<html lang="${REPORT_LOCALE === "en" ? "en" : "zh-CN"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${STR.siteTitle} · ${date}</title>
<meta name="description" content="AI 智能每日简报 · 全球优质信息聚合·AI 分类精炼·深度分析">
<style>
  :root {
    --bg: #fafaf9;
    --bg-elevated: #ffffff;
    --fg: #0c0c0c;
    --fg-soft: #3f3f46;
    --muted: #71717a;
    --rule: #e4e4e7;
    --card: #f0f0f2;
    --link: #2563eb;
    --accent: #0c0c0c;
    --accent-fg: #fafaf9;
    --rank-high-bg: #fee2e2;
    --rank-high-fg: #991b1b;
    --rank-mid-bg: #fef3c7;
    --rank-mid-fg: #92400e;
    --rank-low-bg: #e0e7ff;
    --rank-low-fg: #3730a3;
    --cat-trending: #f59e0b;
    --cat-tech: #3b82f6;
    --cat-finance: #10b981;
    --cat-politics: #8b5cf6;
    --cat-trading: #f97316;
    --cat-community: #ec4899;
    --hero-grad-from: #fafaf9;
    --hero-grad-to: #f0f0f2;
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.04);
    --shadow-md: 0 2px 8px rgba(0,0,0,0.06);
    --shadow-lg: 0 4px 16px rgba(0,0,0,0.08);
    --radius: 0.625rem;
    --radius-sm: 0.375rem;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #09090b;
      --bg-elevated: #141418;
      --fg: #fafafa;
      --fg-soft: #d4d4d8;
      --muted: #a1a1aa;
      --rule: #27272a;
      --card: #1a1a1f;
      --link: #60a5fa;
      --accent: #fafafa;
      --accent-fg: #09090b;
      --rank-high-bg: rgba(239,68,68,0.15);
      --rank-high-fg: #fca5a5;
      --rank-mid-bg: rgba(245,158,11,0.15);
      --rank-mid-fg: #fcd34d;
      --rank-low-bg: rgba(99,102,241,0.15);
      --rank-low-fg: #a5b4fc;
      --cat-trending: #fbbf24;
      --cat-tech: #60a5fa;
      --cat-finance: #34d399;
      --cat-politics: #a78bfa;
      --cat-trading: #fb923c;
      --cat-community: #f472b6;
      --hero-grad-from: #141418;
      --hero-grad-to: #09090b;
      --shadow-sm: 0 1px 2px rgba(0,0,0,0.2);
      --shadow-md: 0 2px 8px rgba(0,0,0,0.3);
      --shadow-lg: 0 4px 16px rgba(0,0,0,0.4);
    }
  }
  *, *::before, *::after { box-sizing: border-box; }
  html { scroll-behavior: smooth; font-size: 17px; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
      "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    line-height: 1.7;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  main {
    max-width: 1000px;
    margin: 0 auto;
    padding: 2rem 1.5rem 4rem;
  }
  @media (min-width: 640px) { main { padding: 3rem 2rem 5rem; } }

  /* ===== header ===== */
  header.report-header { margin-bottom: 1.5rem; }
  .eyebrow {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.25em;
    color: var(--muted);
    font-weight: 600;
  }
  h1.report-title {
    font-size: 2.5rem;
    font-weight: 800;
    margin: 0.3rem 0 1rem;
    letter-spacing: -0.03em;
    line-height: 1.05;
    color: var(--fg);
  }
  @media (max-width: 640px) {
    h1.report-title { font-size: 1.75rem; }
  }
  .archive-link {
    display: inline-block;
    margin-bottom: 0.75rem;
    font-size: 0.82rem;
    color: var(--muted);
    text-decoration: none;
    border-bottom: 1px dashed var(--rule);
    padding-bottom: 1px;
    transition: color 0.2s;
  }
  .archive-link:hover { color: var(--link); border-bottom-style: solid; }

  .update-time {
    display: block;
    font-size: 0.72rem;
    color: var(--muted);
    margin-bottom: 0.5rem;
    font-variant-numeric: tabular-nums;
  }

  .hero-card {
    background: linear-gradient(135deg, var(--hero-grad-from) 0%, var(--hero-grad-to) 100%);
    border: 1px solid var(--rule);
    border-left: 4px solid var(--accent);
    padding: 1.1rem 1.5rem;
    border-radius: var(--radius);
    box-shadow: var(--shadow-sm);
  }
  .hero-eyebrow {
    font-size: 0.68rem;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--muted);
    font-weight: 600;
  }
  .hero-headline {
    font-size: 1.2rem;
    font-weight: 600;
    margin: 0.3rem 0 0;
    line-height: 1.5;
    color: var(--fg);
  }
  .overview-card {
    margin: 0.75rem 0 0;
    padding: 0.75rem 1.1rem;
    background: var(--card);
    border-radius: var(--radius-sm);
    border-left: 3px solid var(--muted);
  }
  .overview-card .eyebrow { display: block; margin-bottom: 0.25rem; }
  .overview-text {
    margin: 0;
    font-size: 0.88rem;
    line-height: 1.7;
    color: var(--fg-soft);
  }

  /* ===== primary tabs ===== */
  .tabs {
    display: flex;
    gap: 0;
    margin: 1.5rem 0 1rem;
    border-bottom: 2px solid var(--rule);
    overflow-x: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  .tabs::-webkit-scrollbar { display: none; }
  .tab {
    position: relative;
    background: none;
    border: none;
    padding: 0.65rem 1rem;
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--muted);
    cursor: pointer;
    margin-bottom: -2px;
    font-family: inherit;
    transition: color 0.2s;
    white-space: nowrap;
    -webkit-tap-highlight-color: transparent;
  }
  .tab::after {
    content: '';
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: var(--accent);
    border-radius: 1px 1px 0 0;
    transform: scaleX(0);
    transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .tab:hover { color: var(--fg); }
  .tab.active {
    color: var(--fg);
    font-weight: 600;
  }
  .tab.active::after { transform: scaleX(1); }
  .tab .count {
    display: inline-block;
    font-size: 0.65rem;
    color: var(--muted);
    margin-left: 0.35rem;
    font-weight: 400;
    background: var(--card);
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    vertical-align: middle;
    line-height: 1.5;
  }
  .panel { display: none; animation: fadeIn 0.2s ease; }
  .panel.active { display: block; }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* ===== digest (AI 简报) — compact ===== */
  .digest-category { margin-bottom: 1.25rem; }
  .category-header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin: 0 0 0.6rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--rule);
  }
  .category-title {
    font-size: 0.88rem;
    font-weight: 700;
    color: var(--fg);
    margin: 0;
    letter-spacing: 0.03em;
  }
  .category-count {
    font-size: 0.68rem;
    color: var(--muted);
    background: var(--card);
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    font-weight: 500;
  }
  .brief-list {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.45rem;
  }
  @media (min-width: 720px) {
    .brief-list { grid-template-columns: 1fr 1fr; }
  }
  .brief {
    background: var(--bg-elevated);
    border: 1px solid var(--rule);
    border-radius: var(--radius-sm);
    padding: 0.75rem 1rem;
    transition: border-color 0.2s, box-shadow 0.2s, transform 0.2s;
  }
  .brief:hover {
    border-color: var(--muted);
    box-shadow: var(--shadow-md);
    transform: translateY(-1px);
  }
  .brief-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    margin-bottom: 0.25rem;
  }
  .brief-source {
    font-size: 0.68rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  .brief-rank {
    font-size: 0.65rem;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    font-weight: 700;
    flex-shrink: 0;
    letter-spacing: 0.02em;
  }
  .brief-rank.high { background: var(--rank-high-bg); color: var(--rank-high-fg); }
  .brief-rank.mid  { background: var(--rank-mid-bg);  color: var(--rank-mid-fg); }
  .brief-rank.low  { background: var(--rank-low-bg);  color: var(--rank-low-fg); }
  .brief-title {
    font-size: 0.9rem;
    font-weight: 600;
    margin: 0 0 0.25rem;
    line-height: 1.4;
  }
  .brief-title a { color: var(--fg); text-decoration: none; transition: color 0.15s; }
  .brief-title a:hover { color: var(--link); text-decoration: underline; }
  .brief-summary {
    margin: 0;
    color: var(--fg-soft);
    font-size: 0.9rem;
    line-height: 1.7;
  }

  .editor-card {
    background: var(--card);
    border-left: 3px solid var(--muted);
    border-radius: var(--radius-sm);
    padding: 1rem 1.25rem;
    margin: 1.5rem 0 1rem;
  }
  .editor-card .eyebrow { display: block; margin-bottom: 0.35rem; }
  .editor-text {
    margin: 0;
    font-size: 0.92rem;
    line-height: 1.75;
    color: var(--fg);
  }
  .keywords { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0 0 1.5rem; }
  .keyword {
    background: var(--card);
    color: var(--fg-soft);
    padding: 0.2rem 0.65rem;
    border-radius: 999px;
    font-size: 0.78rem;
    font-weight: 500;
    transition: background 0.15s;
  }
  .keyword:hover { background: var(--rule); }

  /* ===== L2 sub-tabs ===== */
  .sub-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin: 1rem 0 0.75rem;
  }
  .sub-tab {
    background: var(--card);
    border: 1px solid transparent;
    padding: 0.45rem 1rem;
    border-radius: 999px;
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--fg-soft);
    cursor: pointer;
    font-family: inherit;
    transition: all 0.2s;
    -webkit-tap-highlight-color: transparent;
  }
  .sub-tab:hover { border-color: var(--muted); color: var(--fg); }
  .sub-tab.active {
    background: var(--accent);
    color: var(--accent-fg);
    border-color: transparent;
    box-shadow: var(--shadow-sm);
  }
  .sub-tab .count {
    font-size: 0.65rem;
    opacity: 0.7;
    margin-left: 0.35rem;
    font-weight: 400;
  }
  .sub-content { display: none; animation: fadeIn 0.15s ease; }
  .sub-content.active { display: block; }

  /* ===== L3 source-tabs ===== */
  .source-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin: 0.75rem 0 1rem;
    padding-bottom: 0.6rem;
    border-bottom: 1px solid var(--rule);
  }
  .source-tab {
    background: none;
    border: 1px solid var(--rule);
    padding: 0.3rem 0.8rem;
    border-radius: 999px;
    font-size: 0.8rem;
    color: var(--fg-soft);
    cursor: pointer;
    font-family: inherit;
    transition: all 0.2s;
    -webkit-tap-highlight-color: transparent;
  }
  .source-tab:hover { border-color: var(--muted); color: var(--fg); }
  .source-tab.active {
    background: var(--fg);
    color: var(--bg);
    border-color: var(--fg);
    box-shadow: var(--shadow-sm);
  }
  .source-tab .count {
    font-size: 0.65rem;
    opacity: 0.7;
    margin-left: 0.3rem;
  }
  .source-content { display: none; animation: fadeIn 0.15s ease; }
  .source-content.active { display: block; }

  /* ===== article cards in raw panels ===== */
  .article {
    padding: 0.9rem 0;
    border-bottom: 1px solid var(--rule);
    transition: background 0.15s;
  }
  .article:first-child { padding-top: 0; }
  .article:last-child { border-bottom: none; }
  .article:hover { background: var(--card); margin: 0 -0.5rem; padding-left: 0.5rem; padding-right: 0.5rem; border-radius: var(--radius-sm); }
  .article-title {
    font-size: 0.92rem;
    margin: 0 0 0.25rem;
    font-weight: 600;
    line-height: 1.45;
  }
  .article-title a { color: var(--fg); text-decoration: none; transition: color 0.15s; }
  .article-title a:hover { color: var(--link); }
  .article-meta { color: var(--muted); font-size: 0.74rem; margin: 0 0 0.3rem; }
  .article-importance {
    display: inline-flex;
    align-items: center;
    min-height: 1.25rem;
    padding: 0.05rem 0.42rem;
    border-radius: 0.3rem;
    font-size: 0.66rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .run-console {
    margin: 0.85rem 0 1.25rem;
    padding: 0.8rem 0;
    border-top: 1px solid var(--rule);
    border-bottom: 1px solid var(--rule);
  }
  .run-console-head {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.75rem;
  }
  .run-button {
    width: 2.35rem;
    height: 2.35rem;
    border: 0;
    border-radius: 0.35rem;
    background: var(--accent);
    color: var(--accent-fg);
    font: inherit;
    font-size: 0.9rem;
    cursor: pointer;
  }
  .run-button:disabled { opacity: 0.55; cursor: wait; }
  .run-status-copy { min-width: 0; }
  .run-status-label { margin: 0; font-size: 0.78rem; font-weight: 700; color: var(--fg); }
  .run-status-detail { margin: 0.1rem 0 0; font-size: 0.7rem; color: var(--muted); }
  .run-progress-value { font-size: 0.72rem; color: var(--muted); font-variant-numeric: tabular-nums; }
  .run-progress-track {
    height: 0.3rem;
    margin-top: 0.6rem;
    overflow: hidden;
    background: var(--card);
    border-radius: 0.2rem;
  }
  .run-progress-bar {
    width: 0;
    height: 100%;
    background: var(--link);
    transition: width 0.35s ease;
  }
  .run-stats { margin: 0.45rem 0 0; color: var(--muted); font-size: 0.68rem; }
  .run-log {
    display: none;
    max-height: 8rem;
    overflow: auto;
    margin: 0.65rem 0 0;
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--rule);
    border-radius: 0.35rem;
    background: var(--bg-elevated);
    color: var(--fg-soft);
    font: 0.68rem/1.55 ui-monospace, SFMono-Regular, Consolas, monospace;
    white-space: pre-wrap;
  }
  .run-log.visible { display: block; }
  .filter-console {
    margin: 0.85rem 0 1.25rem;
    padding: 0.75rem 0;
    border-bottom: 1px solid var(--rule);
  }
  .filter-console-head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
  .filter-console-title { font-size: 0.78rem; font-weight: 700; color: var(--fg); }
  .filter-console-line { margin: 0.35rem 0 0; color: var(--muted); font-size: 0.7rem; line-height: 1.55; }
  .filter-console-line strong { color: var(--fg-soft); }
  .filter-custom-button, .filter-custom-actions button {
    border: 1px solid var(--rule);
    border-radius: 0.35rem;
    background: var(--bg-elevated);
    color: var(--fg-soft);
    font: inherit;
    font-size: 0.7rem;
    padding: 0.35rem 0.55rem;
    cursor: pointer;
  }
  .filter-custom-button:hover, .filter-custom-actions button:hover { border-color: var(--link); color: var(--link); }
  .filter-custom-form { margin-top: 0.65rem; }
  .filter-custom-form label { display: block; color: var(--fg-soft); font-size: 0.68rem; margin-bottom: 0.3rem; }
  .filter-custom-form input { width: 100%; box-sizing: border-box; border: 1px solid var(--rule); border-radius: 0.35rem; padding: 0.48rem 0.55rem; background: var(--bg-elevated); color: var(--fg); font: inherit; font-size: 0.72rem; }
  .filter-custom-actions { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; margin-top: 0.45rem; }
  .filter-custom-actions span { color: var(--muted); font-size: 0.65rem; }
  .filter-custom-actions button { flex: 0 0 auto; background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
  .article-importance.importance-high { background: var(--rank-high-bg); color: var(--rank-high-fg); }
  .article-importance.importance-mid { background: var(--rank-mid-bg); color: var(--rank-mid-fg); }
  .article-importance.importance-low { background: var(--rank-low-bg); color: var(--rank-low-fg); }
  .article-attribution { color: var(--muted); font-weight: 600; }
  .interest-tag { border-color: #f59e0b; background: #fff7ed; color: #9a3412; }
  .article-stats {
    color: var(--muted);
    font-size: 0.78rem;
    margin: 0 0 0.35rem;
    font-feature-settings: "tnum";
  }
  .article-excerpt {
    margin: 0.3rem 0 0;
    color: var(--muted);
    font-size: 0.72rem;
    line-height: 1.5;
    font-style: italic;
  }
  .article-summary {
    margin: 0.4rem 0 0;
    padding: 0.55rem 0.85rem;
    background: var(--card);
    border-left: 2px solid var(--link);
    border-radius: var(--radius-sm);
    font-size: 0.92rem;
    line-height: 1.7;
    color: var(--fg);
  }
  .summary-label {
    display: inline-block;
    font-size: 0.65rem;
    color: var(--link);
    margin-right: 0.4rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  /* ===== tag chips ===== */
  .article-tags {
    margin: 0.3rem 0 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .tag {
    display: inline-block;
    font-size: 0.6rem;
    padding: 0.08rem 0.4rem;
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    border: 1px solid var(--rule);
    color: var(--muted);
    font-weight: 600;
    letter-spacing: 0.02em;
    line-height: 1.6;
  }

  /* ===== source link style ===== */
  .article-source-link {
    color: var(--muted);
    text-decoration: none;
    font-weight: 600;
    transition: color 0.15s;
  }
  .article-source-link:hover {
    color: var(--link);
  }

  /* ===== permalink icon ===== */
  .article-permalink {
    display: inline-block;
    margin-top: 0.2rem;
    font-size: 0.72rem;
    text-decoration: none;
    opacity: 0;
    color: var(--muted);
    transition: opacity 0.15s, color 0.15s;
  }
  .article:hover .article-permalink { opacity: 0.5; }
  .article-permalink:hover {
    opacity: 1;
    color: var(--link);
  }
  .article.tag-highlight {
    background: var(--card);
    margin: 0 -0.5rem;
    padding-left: 0.5rem;
    padding-right: 0.5rem;
    border-radius: var(--radius-sm);
    border-left: 3px solid var(--link);
  }
  .article.tag-dimmed {
    opacity: 0.25;
  }

  .empty {
    color: var(--muted);
    text-align: center;
    padding: 3rem 0;
    font-size: 0.88rem;
    font-style: italic;
  }

  /* ===== category-level AI summary ===== */
  .category-summary {
    margin: 0.75rem 0 1rem;
    padding: 0.85rem 1.1rem;
    background: var(--card);
    border-left: 4px solid var(--link);
    border-radius: var(--radius-sm);
    font-size: 0.9rem;
    line-height: 1.7;
    color: var(--fg-soft);
  }
  .category-summary-eyebrow {
    display: block;
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--link);
    margin-bottom: 0.25rem;
  }
  .category-summary p { margin: 0; }

  /* ===== tag cloud ===== */
  .tag-cloud {
    margin: 0.5rem 0 1rem;
    padding: 1rem 1.1rem;
    background: var(--bg-elevated);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
  }
  .tag-cloud-heading {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    margin: 0 0 0.65rem;
  }
  .tag-cloud-body {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    align-items: center;
    max-height: 2.4em;
    overflow: hidden;
    transition: max-height 0.3s ease;
    position: relative;
  }
  .tag-cloud-body.expanded {
    max-height: none;
  }
  .tag-cloud-fade {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 1.2em;
    background: linear-gradient(transparent, var(--bg-elevated));
    pointer-events: none;
    transition: opacity 0.3s ease;
  }
  .tag-cloud-body.expanded .tag-cloud-fade {
    opacity: 0;
  }
  .tag-cloud-chip {
    display: inline-flex;
    align-items: baseline;
    font-size: 0.72rem;
    padding: 0.18rem 0.6rem;
    border-radius: 999px;
    font-weight: 500;
    letter-spacing: 0.01em;
    line-height: 1.55;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
    cursor: default;
  }
  .tag-cloud-chip:hover {
    transform: translateY(-2px);
    box-shadow: 0 3px 8px rgba(0,0,0,0.1);
    cursor: pointer;
  }
  .tag-cloud-chip.active-tag {
    outline: 2px solid var(--link);
    outline-offset: 1px;
    background: rgba(37,99,235,0.12);
  }
  .tag-count {
    font-size: 0.58rem;
    margin-left: 0.2rem;
    opacity: 0.65;
    font-weight: 400;
  }
  .tag-heat-0 {
    background: rgba(99,102,241,0.08);
    color: var(--muted);
    border: 1px solid var(--rule);
  }
  .tag-heat-1 {
    background: rgba(16,185,129,0.10);
    color: #059669;
    border: 1px solid rgba(16,185,129,0.2);
  }
  .tag-heat-2 {
    background: rgba(245,158,11,0.12);
    color: #d97706;
    border: 1px solid rgba(245,158,11,0.25);
  }
  .tag-heat-3 {
    background: rgba(239,68,68,0.12);
    color: #dc2626;
    border: 1px solid rgba(239,68,68,0.25);
    font-weight: 700;
  }
  @media (prefers-color-scheme: dark) {
    .tag-heat-0 { color: var(--muted); border-color: var(--rule); }
    .tag-heat-1 { color: #6ee7b7; border-color: rgba(16,185,129,0.35); }
    .tag-heat-2 { color: #fcd34d; border-color: rgba(245,158,11,0.35); }
    .tag-heat-3 { color: #fca5a5; border-color: rgba(239,68,68,0.35); }
    .tag-cloud-chip:hover { box-shadow: 0 3px 8px rgba(0,0,0,0.3); }
  }
  .tag-cloud-hidden {
    display: none;
  }
  .tag-cloud-hidden.expanded {
    display: inline;
  }
  .tag-cloud-expand {
    background: var(--card);
    border: 1px solid var(--rule);
    padding: 0.15rem 0.55rem;
    border-radius: 999px;
    font-size: 0.7rem;
    color: var(--muted);
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
    margin-left: 0.2rem;
  }
  .tag-cloud-expand:hover { border-color: var(--muted); color: var(--fg); }

  /* ===== failed sources panel ===== */
  .failed-sources {
    margin: 0.5rem 0 1rem;
    padding: 0.85rem 1rem;
    background: var(--bg-elevated);
    border: 1px solid var(--rule);
    border-left: 4px solid #d97706;
    border-radius: var(--radius);
  }
  .failed-sources-heading {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #d97706;
    margin: 0 0 0.5rem;
  }
  summary.failed-sources-heading { cursor: pointer; list-style: none; }
  summary.failed-sources-heading::-webkit-details-marker { display: none; }
  summary.failed-sources-heading span {
    margin-left: 0.45rem;
    color: var(--muted);
    font-size: 0.68rem;
    font-variant-numeric: tabular-nums;
  }
  .failed-source-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.35rem 0;
    border-bottom: 1px dashed var(--rule);
    font-size: 0.82rem;
  }
  .failed-source-item:last-child { border-bottom: none; }
  .failed-source-name {
    font-weight: 600;
    color: var(--fg);
  }
  .failed-source-reason {
    color: var(--muted);
    font-size: 0.75rem;
    flex: 1;
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 300px;
  }
  .refetch-btn {
    background: var(--card);
    border: 1px solid var(--rule);
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--fg-soft);
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .refetch-btn:hover { border-color: var(--link); color: var(--link); }
  .refetch-btn.fetching {
    background: rgba(217,119,6,0.15);
    border-color: #d97706;
    color: #d97706;
    animation: pulse 1.2s ease-in-out infinite;
  }
  .refetch-btn.success {
    background: rgba(22,163,74,0.15);
    border-color: #16a34a;
    color: #16a34a;
  }
  .refetch-btn.error {
    background: rgba(220,38,38,0.15);
    border-color: #dc2626;
    color: #dc2626;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  /* ===== trading panel ===== */
  .crypto-widgets {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.5rem;
    margin: 0.5rem 0 1.5rem;
  }
  @media (min-width: 720px) {
    .crypto-widgets { grid-template-columns: repeat(4, 1fr); }
  }
  .crypto-widget {
    background: var(--bg-elevated);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    padding: 0.75rem 0.9rem;
    text-align: center;
    box-shadow: var(--shadow-sm);
  }
  .widget-label {
    font-size: 0.65rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 0.3rem;
    font-weight: 600;
  }
  .widget-value {
    font-size: 1.6rem;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    color: var(--fg);
    line-height: 1.1;
  }
  .widget-sub {
    font-size: 0.76rem;
    color: var(--muted);
    margin-top: 0.2rem;
    font-weight: 500;
  }
  .widget-sub.positive { color: #16a34a; }
  .widget-sub.negative { color: #dc2626; }
  @media (prefers-color-scheme: dark) {
    .widget-sub.positive { color: #4ade80; }
    .widget-sub.negative { color: #fca5a5; }
  }
  .crypto-widget.fg-fear-extreme { border-left: 4px solid #b91c1c; }
  .crypto-widget.fg-fear-extreme .widget-value { color: #b91c1c; }
  .crypto-widget.fg-fear { border-left: 4px solid #d97706; }
  .crypto-widget.fg-fear .widget-value { color: #d97706; }
  .crypto-widget.fg-neutral { border-left: 4px solid var(--muted); }
  .crypto-widget.fg-greed { border-left: 4px solid #65a30d; }
  .crypto-widget.fg-greed .widget-value { color: #65a30d; }
  .crypto-widget.fg-greed-extreme { border-left: 4px solid #16a34a; }
  .crypto-widget.fg-greed-extreme .widget-value { color: #16a34a; }
  @media (prefers-color-scheme: dark) {
    .crypto-widget.fg-fear-extreme .widget-value,
    .crypto-widget.fg-fear .widget-value { color: #fca5a5; }
    .crypto-widget.fg-greed .widget-value,
    .crypto-widget.fg-greed-extreme .widget-value { color: #4ade80; }
  }

  .trading-overview-card {
    margin: 0 0 1.5rem;
    padding: 1rem 1.25rem;
    background: var(--card);
    border-radius: var(--radius);
    border-left: 4px solid var(--accent);
    box-shadow: var(--shadow-sm);
  }
  .trading-overview-card .eyebrow { display: block; margin-bottom: 0.35rem; }
  .trading-overview-text { font-size: 0.9rem; line-height: 1.8; color: var(--fg-soft); margin: 0; }

  .trading-section-title {
    font-size: 0.9rem;
    font-weight: 700;
    margin: 1.5rem 0 0.75rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--rule);
    color: var(--fg);
    letter-spacing: 0.03em;
  }

  /* picks (Sonnet's watchlist) */
  .trading-picks {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.5rem;
  }
  @media (min-width: 720px) {
    .trading-picks { grid-template-columns: 1fr 1fr; }
  }
  .trading-pick {
    background: var(--bg-elevated);
    border: 1px solid var(--rule);
    border-left: 4px solid var(--muted);
    border-radius: var(--radius);
    padding: 0.85rem 1rem;
    box-shadow: var(--shadow-sm);
    transition: box-shadow 0.2s;
  }
  .trading-pick:hover { box-shadow: var(--shadow-md); }
  .trading-pick.stance-bull { border-left-color: #16a34a; }
  .trading-pick.stance-bear { border-left-color: #dc2626; }
  .trading-pick.stance-neutral { border-left-color: var(--muted); }
  .pick-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.4rem;
  }
  .pick-symbol-block {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .pick-symbol { font-weight: 800; font-size: 1rem; color: var(--fg); }
  .pick-name { color: var(--muted); font-size: 0.8rem; }
  .pick-stance {
    font-size: 0.72rem;
    font-weight: 700;
    padding: 0.18rem 0.6rem;
    border-radius: 999px;
    white-space: nowrap;
  }
  .pick-stance-bull { background: rgba(22,163,74,0.12); color: #16a34a; }
  .pick-stance-bear { background: rgba(220,38,38,0.12); color: #dc2626; }
  .pick-stance-neutral { background: var(--card); color: var(--muted); }
  .pick-rationale { margin: 0; font-size: 0.86rem; line-height: 1.7; color: var(--fg-soft); }

  /* asset-group tabs */
  .trading-group-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin: 0.5rem 0 1rem;
  }
  .trading-group-tab {
    background: var(--card);
    border: 1px solid transparent;
    padding: 0.45rem 0.9rem;
    border-radius: 999px;
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--fg-soft);
    cursor: pointer;
    font-family: inherit;
    transition: all 0.2s;
    -webkit-tap-highlight-color: transparent;
  }
  .trading-group-tab:hover { border-color: var(--muted); color: var(--fg); }
  .trading-group-tab.active {
    background: var(--accent);
    color: var(--accent-fg);
    border-color: transparent;
  }
  .trading-group-tab .count {
    font-size: 0.65rem;
    opacity: 0.7;
    margin-left: 0.35rem;
    font-weight: 400;
  }
  .trading-group-content { display: none; animation: fadeIn 0.15s ease; }
  .trading-group-content.active { display: block; }

  /* ticker cards */
  .ticker-card {
    background: var(--bg-elevated);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    padding: 0.9rem 1.1rem;
    margin-bottom: 0.6rem;
    box-shadow: var(--shadow-sm);
    transition: box-shadow 0.2s;
  }
  .ticker-card:hover { box-shadow: var(--shadow-md); }
  .ticker-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.6rem;
  }
  .ticker-id { min-width: 0; }
  .ticker-symbol { margin: 0; font-size: 1.05rem; font-weight: 800; font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; }
  .ticker-name { margin: 0.1rem 0 0; font-size: 0.8rem; color: var(--muted); }
  .ticker-price-block { text-align: right; flex-shrink: 0; }
  .ticker-price { display: block; font-size: 1.1rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .ticker-pct { display: inline-block; font-size: 0.82rem; font-weight: 600; margin-top: 0.1rem; font-variant-numeric: tabular-nums; }
  .ticker-pct.positive, .positive { color: #16a34a; }
  .ticker-pct.negative, .negative { color: #dc2626; }

  .ticker-indicators {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.3rem 0.9rem;
    margin: 0;
    font-size: 0.8rem;
    color: var(--fg-soft);
  }
  @media (min-width: 720px) {
    .ticker-indicators { grid-template-columns: repeat(3, 1fr); }
  }
  .ticker-indicators > div { display: flex; gap: 0.4rem; align-items: baseline; min-width: 0; }
  .ticker-indicators dt { color: var(--muted); font-size: 0.72rem; margin: 0; white-space: nowrap; }
  .ticker-indicators dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: 600; color: var(--fg); }
  .trend-bullish { color: #16a34a; }
  .trend-bearish { color: #dc2626; }
  .trend-neutral { color: var(--muted); }
  .rsi-overbought { color: #d97706; }
  .rsi-oversold { color: #2563eb; }

  .ticker-signals {
    margin-top: 0.6rem;
    padding-top: 0.5rem;
    border-top: 1px dashed var(--rule);
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .signal-pill {
    font-size: 0.7rem;
    padding: 0.15rem 0.55rem;
    border-radius: 999px;
    font-weight: 600;
  }
  .signal-pill.tone-bull { background: rgba(22,163,74,0.12); color: #166534; }
  .signal-pill.tone-bear { background: rgba(220,38,38,0.12); color: #991b1b; }
  .signal-pill.tone-caution { background: rgba(217,119,6,0.12); color: #92400e; }
  @media (prefers-color-scheme: dark) {
    .signal-pill.tone-bull { color: #4ade80; }
    .signal-pill.tone-bear { color: #fca5a5; }
    .signal-pill.tone-caution { color: #fcd34d; }
    .trend-bullish, .positive, .ticker-pct.positive { color: #4ade80; }
    .trend-bearish, .negative, .ticker-pct.negative { color: #fca5a5; }
    .rsi-overbought { color: #fcd34d; }
    .rsi-oversold { color: #93c5fd; }
    .trading-pick.stance-bull { border-left-color: #4ade80; }
    .trading-pick.stance-bear { border-left-color: #fca5a5; }
    .pick-stance-bull { background: rgba(74,222,128,0.15); color: #4ade80; }
    .pick-stance-bear { background: rgba(252,165,165,0.15); color: #fca5a5; }
  }
  .signal-age { opacity: 0.7; font-weight: 400; }

  .trading-risk {
    margin: 1.5rem 0 0;
    padding: 0.85rem 1.1rem;
    background: var(--card);
    border-radius: var(--radius-sm);
    border-left: 3px solid #d97706;
  }
  .trading-risk .eyebrow { display: block; margin-bottom: 0.3rem; }
  .trading-risk p { margin: 0; font-size: 0.82rem; line-height: 1.7; color: var(--fg-soft); }

  .review-panel {
    margin: 0.75rem 0 1rem;
    padding: 0.85rem 1.1rem;
    background: var(--bg-elevated);
    border: 1px solid var(--rule);
    border-left: 4px solid var(--muted);
    border-radius: var(--radius);
  }
  .review-panel.passed { border-left-color: #16a34a; }
  .review-panel.has-issues { border-left-color: #d97706; }
  .review-eyebrow {
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    margin-bottom: 0.3rem;
  }
  .review-text { margin: 0; font-size: 0.85rem; line-height: 1.7; color: var(--fg-soft); }
  .review-issue {
    font-size: 0.82rem;
    color: #d97706;
    margin: 0.2rem 0;
    padding-left: 0.5rem;
    border-left: 2px solid #d97706;
  }

	  footer {
	    margin-top: 3rem;
	    border-top: 1px solid var(--rule);
	    padding-top: 1rem;
	    color: var(--muted);
	    font-size: 0.8rem;
	  }

	  /* ===== visual polish: glass + glow ===== */
	  .hero-card {
	    background: linear-gradient(135deg, color-mix(in srgb, var(--hero-grad-from) 85%, transparent), color-mix(in srgb, var(--hero-grad-to) 85%, transparent));
	    backdrop-filter: blur(8px);
	    -webkit-backdrop-filter: blur(8px);
	  }
	  .brief {
	    transition: border-color 0.2s, box-shadow 0.2s, transform 0.2s, background 0.3s;
	  }
	  .brief:hover {
	    background: color-mix(in srgb, var(--bg-elevated) 95%, var(--link));
	    border-color: var(--link);
	    box-shadow: 0 4px 20px rgba(37,99,235,0.08);
	    transform: translateY(-2px);
	  }
	  @media (prefers-color-scheme: dark) {
	    .brief:hover {
	      background: color-mix(in srgb, var(--bg-elevated) 90%, var(--link));
	      box-shadow: 0 4px 20px rgba(96,165,250,0.1);
	    }
	  }
	  .category-summary {
	    backdrop-filter: blur(4px);
	    -webkit-backdrop-filter: blur(4px);
	  }
	  .trading-overview-card {
	    backdrop-filter: blur(4px);
	    -webkit-backdrop-filter: blur(4px);
	  }
	  .review-panel.passed {
	    background: linear-gradient(135deg, color-mix(in srgb, var(--bg-elevated) 95%, #16a34a), var(--bg-elevated));
	  }
	  .review-panel.has-issues {
	    background: linear-gradient(135deg, color-mix(in srgb, var(--bg-elevated) 95%, #d97706), var(--bg-elevated));
	  }

	  /* ===== source count badge animation ===== */
	  .source-tab .count, .sub-tab .count {
	    transition: transform 0.2s;
	  }
	  .source-tab:hover .count, .sub-tab:hover .count {
	    transform: scale(1.15);
	  }
	</style>
</head>
<body>
<main>
  <header class="report-header">
      <span class="eyebrow">${STR.siteTitle}</span>
      <h1 class="report-title">${date}</h1>
      <span class="update-time">${REPORT_LOCALE === "en" ? "Updated" : "更新时间"}: ${new Date().toLocaleString(REPORT_LOCALE === "en" ? "en-GB" : "zh-CN", { timeZone: getReportTz(), hour12: false, hour: "2-digit", minute: "2-digit", month: "2-digit", day: "2-digit" })}</span>
      ${process.env.WEB_MODE === "true" ? `<a class="archive-link" href="../archive.html">${STR.archiveLink}</a>` : ""}
  </header>

  <section class="run-console" data-actions-url="${escapeHtml(actionsUrl)}" data-github-repository="${escapeHtml(githubRepository)}" data-run-endpoint="${escapeHtml(runEndpoint)}">
    <div class="run-console-head">
      <button class="run-button" id="runDailyButton" type="button" title="${REPORT_LOCALE === "en" ? "Run daily brief" : "运行日报"}" aria-label="${REPORT_LOCALE === "en" ? "Run daily brief" : "运行日报"}">▶</button>
      <div class="run-status-copy">
        <p class="run-status-label" id="runStatusLabel">${REPORT_LOCALE === "en" ? "Ready" : "等待运行"}</p>
        <p class="run-status-detail" id="runStatusDetail">${REPORT_LOCALE === "en" ? "Local service runs directly; Pages uses a secure remote endpoint" : "本地服务直接运行；Pages 使用安全远程启动端点"}</p>
      </div>
      <span class="run-progress-value" id="runProgressValue">0%</span>
    </div>
    <div class="run-progress-track" role="progressbar" aria-label="${REPORT_LOCALE === "en" ? "Run progress" : "运行进度"}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <div class="run-progress-bar" id="runProgressBar"></div>
    </div>
    <p class="run-stats" id="runStats">${escapeHtml(runStatsText(runStats))}</p>
    <pre class="run-log" id="runLog" aria-live="polite"></pre>
  </section>

  <section class="filter-console" id="filterConsole">
    <div class="filter-console-head">
      <span class="filter-console-title">${REPORT_LOCALE === "en" ? "AI selection profile" : "本次 AI 筛选标准"}</span>
      <button class="filter-custom-button" id="customFilterToggle" type="button">${REPORT_LOCALE === "en" ? "Customize" : "自定义筛选"}</button>
    </div>
    <p class="filter-console-line"><strong>${REPORT_LOCALE === "en" ? "Base rules" : "基础规则"}：</strong><span id="filterBaseRules">${escapeHtml(filterText.rules)}</span></p>
    <p class="filter-console-line"><strong>${REPORT_LOCALE === "en" ? "Incremental keywords" : "增量关键词"}：</strong><span id="filterKeywords">${escapeHtml(filterText.keywords)}</span></p>
    <form class="filter-custom-form" id="customFilterForm" hidden>
      <label for="customKeywordsInput">${REPORT_LOCALE === "en" ? "Add up to 8 keywords" : "增加兴趣关键词（最多 8 个，合计不超过 120 字）"}</label>
      <input id="customKeywordsInput" name="keywords" maxlength="120" autocomplete="off" placeholder="${REPORT_LOCALE === "en" ? "e.g. AI agents, Iran, NVIDIA" : "例如：AI Agent、伊朗、英伟达"}">
      <div class="filter-custom-actions"><span id="customKeywordHint">${REPORT_LOCALE === "en" ? "Keywords are additive and affect the next run only." : "关键词只做增量筛选，不会替换基础规则。"}</span><button type="submit">${REPORT_LOCALE === "en" ? "Apply and run" : "应用并运行"}</button></div>
    </form>
  </section>

  ${tagCloudHtml}

  ${failedHtml}

  ${reviewHtml(review)}

  <nav class="tabs" role="tablist">
    ${raw.trending.length > 0 ? `<button class="tab active" data-tab="trending">${STR.catTrending}<span class="count">${counts.trending}</span></button>` : ""}
    <button class="tab${raw.trending.length > 0 ? "" : " active"}" data-tab="tech">${CATEGORY_LABELS.tech}<span class="count">${counts.tech}</span></button>
    ${trading ? `<button class="tab" data-tab="trading">${STR.catTrading}<span class="count">${trading.tickers.length}</span></button>` : ""}
    <button class="tab" data-tab="politics">${CATEGORY_LABELS.politics}<span class="count">${counts.politics}</span></button>
    <button class="tab" data-tab="finance">${CATEGORY_LABELS.finance}<span class="count">${counts.finance}</span></button>
    ${techCommunitySubs.length > 0 ? `<button class="tab" data-tab="community">${STR.catCommunity}<span class="count">${counts.community}</span></button>` : ""}
  </nav>

  <section class="panel${raw.trending.length > 0 ? " active" : ""}" data-panel="trending">
    ${renderRawCategoryPanel("trending", raw.trending, "trending", categorySummaries)}
  </section>
  <section class="panel${raw.trending.length > 0 ? "" : " active"}" data-panel="tech">
    ${renderRawCategoryPanel("tech", techMainSubs, "tech", categorySummaries)}
  </section>
  ${trading ? `<section class="panel" data-panel="trading">${renderTradingPanel(trading)}</section>` : ""}
  <section class="panel" data-panel="politics">
    ${renderRawCategoryPanel("politics", raw.politics, "politics", categorySummaries)}
  </section>
  <section class="panel" data-panel="finance">
    ${renderRawCategoryPanel("finance", raw.finance, "finance", categorySummaries)}
  </section>
  ${techCommunitySubs.length > 0 ? `<section class="panel" data-panel="community">
    ${renderRawCategoryPanel("tech", techCommunitySubs, "community", categorySummaries)}
  </section>` : ""}

  <footer>
    ${STR.footer}
  </footer>
</main>
<script>
  (function () {
    var consoleEl = document.querySelector('.run-console');
    var button = document.getElementById('runDailyButton');
    var label = document.getElementById('runStatusLabel');
    var detail = document.getElementById('runStatusDetail');
    var value = document.getElementById('runProgressValue');
    var bar = document.getElementById('runProgressBar');
    var stats = document.getElementById('runStats');
    var log = document.getElementById('runLog');
    var customToggle = document.getElementById('customFilterToggle');
    var customForm = document.getElementById('customFilterForm');
    var keywordInput = document.getElementById('customKeywordsInput');
    var keywordHint = document.getElementById('customKeywordHint');
    var filterKeywords = document.getElementById('filterKeywords');
    var progressTrack = consoleEl ? consoleEl.querySelector('[role="progressbar"]') : null;
    if (!consoleEl || !button || !label || !detail || !value || !bar || !stats || !log || !customToggle || !customForm || !keywordInput || !keywordHint || !filterKeywords) return;
    var repository = consoleEl.dataset.githubRepository || '';
    var runEndpoint = consoleEl.dataset.runEndpoint || '/api/run';
    var isPages = /\.github\.io$/i.test(location.hostname);
    var timer = null;
    var remoteRequestedAt = 0;

    function scheduleGithubPoll() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(pollGithub, 5000);
    }

    function normalizeKeywords(raw) {
      var values = String(raw || '').split(/[\\n,，、;；|]+/);
      var result = [];
      var total = 0;
      values.forEach(function (value) {
        var cleaned = value.replace(/\\s+/g, ' ').trim().slice(0, 24);
        var key = cleaned.toLocaleLowerCase();
        if (!cleaned || result.some(function (item) { return item.toLocaleLowerCase() === key; })) return;
        if (total + cleaned.length > 120 || result.length >= 8) return;
        result.push(cleaned);
        total += cleaned.length;
      });
      return result;
    }

    function keywordText(keywords) {
      return keywords.length ? keywords.join('、') : '${REPORT_LOCALE === "en" ? "None" : "无（使用基础规则）"}';
    }

    function statsText(runStats) {
      if (!runStats) return '';
      var rate = (Number(runStats.sourceSuccessRate || 0) * 100).toFixed(1) + '%';
      return '${REPORT_LOCALE === "en" ? "Sources" : "抓取信息源"} ' + (runStats.fetchedSources || 0) + ' · ${REPORT_LOCALE === "en" ? "Articles" : "信息"} ' + (runStats.fetchedArticles || 0) + ' → ${REPORT_LOCALE === "en" ? "deduped" : "去重后"} ' + (runStats.dedupedArticles || 0) + ' · ${REPORT_LOCALE === "en" ? "Success" : "成功率"} ' + rate;
    }

    function renderStatus(state) {
      var progress = Math.max(0, Math.min(100, Number(state.progress || 0)));
      label.textContent = state.stage || (state.status === 'running' ? '\u8fd0\u884c\u4e2d' : '\u7b49\u5f85\u8fd0\u884c');
      detail.textContent = state.status === 'running'
        ? '\u6b63\u5728\u6536\u96c6\u3001\u6574\u7406\u3001\u7ffb\u8bd1\u548c\u5ba1\u6838\u4fe1\u606f'
        : state.status === 'success' ? '\u65e5\u62a5\u5df2\u751f\u6210\uff0c\u5237\u65b0\u9875\u9762\u67e5\u770b'
        : state.status === 'error' ? '\u8fd0\u884c\u5931\u8d25\uff0c\u8bf7\u67e5\u770b\u65e5\u5fd7'
        : detail.textContent;
      value.textContent = progress + '%';
      bar.style.width = progress + '%';
      if (progressTrack) progressTrack.setAttribute('aria-valuenow', String(progress));
      button.disabled = state.status === 'running';
      if (state.stats) stats.textContent = statsText(state.stats);
      if (state.filterProfile && Array.isArray(state.filterProfile.customKeywords)) {
        filterKeywords.textContent = keywordText(state.filterProfile.customKeywords);
      }
      if (Array.isArray(state.logs) && state.logs.length) {
        log.textContent = state.logs.slice(-12).join('\\n');
        log.classList.add('visible');
        log.scrollTop = log.scrollHeight;
      }
    }

    function pollLocal() {
      fetch('/api/run/status', { cache: 'no-store' })
        .then(function (response) { if (!response.ok) throw new Error('status unavailable'); return response.json(); })
        .then(function (state) {
          renderStatus(state);
          if (state.status === 'running') timer = setTimeout(pollLocal, 1200);
        })
        .catch(function () {});
    }

    function githubStepProgress(name) {
      if (!name) return 55;
      if (name.indexOf('Generate') >= 0) return 45;
      if (name.indexOf('Build') >= 0) return 78;
      if (name.indexOf('Publish') >= 0) return 91;
      if (name.indexOf('Upload') >= 0) return 97;
      return 55;
    }

    function pollGithub() {
      if (!repository) return;
      fetch('https://api.github.com/repos/' + repository + '/actions/workflows/daily.yml/runs?per_page=1&t=' + Date.now(), { cache: 'no-store' })
        .then(function (response) { if (!response.ok) throw new Error('GitHub status unavailable'); return response.json(); })
        .then(function (payload) {
          var runs = payload.workflow_runs || [];
          var run = runs.find(function (item) {
            if (!remoteRequestedAt) return true;
            var createdAt = Date.parse(item.created_at || item.run_started_at || '');
            return Number.isFinite(createdAt) && createdAt >= remoteRequestedAt - 90000;
          });
          if (!run) {
            renderStatus({ status: 'running', stage: '已提交，等待远程任务创建', progress: 8, logs: ['GitHub Actions workflow_dispatch 已提交，等待新任务出现'] });
            scheduleGithubPoll();
            return;
          }
          var running = run.status !== 'completed';
          renderStatus({
            status: running ? 'running' : run.conclusion === 'success' ? 'success' : 'error',
            stage: running ? '\u8fdc\u7a0b\u4efb\u52a1\u8fd0\u884c\u4e2d' : run.conclusion === 'success' ? '\u8fdc\u7a0b\u4efb\u52a1\u5b8c\u6210' : '\u8fdc\u7a0b\u4efb\u52a1\u5931\u8d25',
            progress: running ? 55 : 100,
            logs: [run.name + ' · ' + run.status + (run.conclusion ? ' · ' + run.conclusion : '')],
          });
          if (running) {
            fetch('https://api.github.com/repos/' + repository + '/actions/runs/' + run.id + '/jobs?per_page=20&t=' + Date.now(), { cache: 'no-store' })
              .then(function (jobsResponse) { return jobsResponse.ok ? jobsResponse.json() : { jobs: [] }; })
              .then(function (jobsPayload) {
                var job = (jobsPayload.jobs || []).find(function (item) { return item.status === 'in_progress'; });
                var step = job && (job.steps || []).find(function (item) { return item.status === 'in_progress'; });
                var stepName = step ? step.name : (job ? job.name : '远程任务运行中');
                renderStatus({ status: 'running', stage: stepName, progress: githubStepProgress(stepName), logs: [run.name + ' · ' + run.status, stepName] });
              })
              .catch(function () {})
            .finally(scheduleGithubPoll);
          }
        })
        .catch(function (error) {
          button.disabled = false;
          renderStatus({ status: 'error', stage: '远程状态获取失败', progress: 0, logs: [error.message] });
        });
    }

    function startRun() {
      var keywords = normalizeKeywords(keywordInput.value);
      keywordInput.value = keywords.join('、');
      filterKeywords.textContent = keywordText(keywords);
      try { localStorage.setItem('dailybrief.customKeywords', keywordInput.value); } catch (_) {}
      button.disabled = true;
      if (isPages) remoteRequestedAt = Date.now();
      renderStatus({ status: 'running', stage: '正在启动任务', progress: 2, logs: [] });
      fetch(runEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keywords: keywords }) })
        .then(function (response) { return response.json().catch(function () { return {}; }).then(function (body) { if (!response.ok) throw new Error(body.error || (isPages ? '当前 GitHub Pages 未配置安全远程启动端点' : '启动接口不可用')); return body; }); })
        .then(function (state) { renderStatus(state); if (isPages) pollGithub(); else pollLocal(); })
        .catch(function (error) {
          button.disabled = false;
          renderStatus({ status: 'error', stage: '启动失败', progress: 0, logs: [error.message] });
        });
    }

    customToggle.addEventListener('click', function () { customForm.hidden = !customForm.hidden; if (!customForm.hidden) keywordInput.focus(); });
    customForm.addEventListener('submit', function (event) { event.preventDefault(); startRun(); });
    button.addEventListener('click', startRun);
    try { var savedKeywords = localStorage.getItem('dailybrief.customKeywords'); if (savedKeywords && !keywordInput.value) keywordInput.value = savedKeywords; } catch (_) {}
    if (isPages) pollGithub(); else pollLocal();
  })();

  document.querySelectorAll('.tabs > .tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = btn.dataset.tab;
      document.querySelectorAll('.tabs > .tab').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      document.querySelectorAll('.panel').forEach(function (p) {
        p.classList.toggle('active', p.dataset.panel === target);
      });
    });
  });
  document.querySelectorAll('.sub-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var panel = btn.closest('.panel');
      if (!panel) return;
      var sub = btn.dataset.sub;
      panel.querySelectorAll('.sub-tab').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      panel.querySelectorAll('.sub-content').forEach(function (p) {
        p.classList.toggle('active', p.dataset.subContent === sub);
      });
    });
  });
  document.querySelectorAll('.source-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      // __all__ has its own dedicated handler below — skip here to avoid double-toggle
      if (btn.dataset.source === '__all__') return;
      var subContent = btn.closest('.sub-content');
      if (!subContent) return;
      var src = btn.dataset.source;
      subContent.querySelectorAll('.source-tab').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      subContent.querySelectorAll('.source-content').forEach(function (p) {
        p.classList.toggle('active', p.dataset.sourceContent === src);
      });
    });
  });
  // Smart "All" button: toggles show-all mode. First click shows every
  // source-content; second click reverts to first source only.
  document.querySelectorAll('.source-tab[data-source="__all__"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var subContent = btn.closest('.sub-content');
      if (!subContent) return;
      var wasActive = btn.classList.contains('active');
      subContent.querySelectorAll('.source-tab').forEach(function (b) {
        b.classList.toggle('active', b === btn ? !wasActive : false);
      });
      var contents = subContent.querySelectorAll('.source-content');
      if (wasActive) {
        // Revert to first source only
        var firstReal = subContent.querySelector('.source-tab:not([data-source="__all__"])');
        var firstSrc = firstReal ? firstReal.dataset.source : null;
        contents.forEach(function (p) {
          p.classList.toggle('active', p.dataset.sourceContent === firstSrc);
        });
        if (firstReal) firstReal.classList.add('active');
      } else {
        // Show all
        contents.forEach(function (p) { p.classList.add('active'); });
      }
    });
  });
  document.querySelectorAll('.trading-group-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var grp = btn.dataset.group;
      document.querySelectorAll('.trading-group-tab').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      document.querySelectorAll('.trading-group-content').forEach(function (p) {
        p.classList.toggle('active', p.dataset.group === grp);
      });
    });
  });
  // Tag cloud: expand/collapse — show only one row, click to reveal all
  document.querySelectorAll('.tag-cloud-expand').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var section = btn.closest('.tag-cloud');
      if (!section) return;
      var body = section.querySelector('.tag-cloud-body');
      if (!body) return;
      var expanded = btn.dataset.expanded === 'true';
      btn.dataset.expanded = expanded ? 'false' : 'true';
      body.classList.toggle('expanded', !expanded);
      btn.textContent = expanded
        ? ('\\u5c55\\u5f00\\u5168\\u90e8')
        : ('\\u2212 \\u6536\\u8d77');
    });
  });
  // Tag cloud: click a tag to highlight matching articles (aggregate mode).
  // Matching articles get a blue left-border highlight; others dim to 25% opacity.
  // Click again to clear.
  var activeTag = null;
  document.querySelectorAll('.tag-cloud-chip[data-tag]').forEach(function (chip) {
    chip.addEventListener('click', function () {
      var tag = chip.dataset.tag;
      if (activeTag === tag) {
        activeTag = null;
        document.querySelectorAll('.tag-cloud-chip').forEach(function (c) {
          c.classList.remove('active-tag');
        });
        document.querySelectorAll('.article').forEach(function (a) {
          a.classList.remove('tag-highlight', 'tag-dimmed');
        });
        return;
      }
      activeTag = tag;
      document.querySelectorAll('.tag-cloud-chip').forEach(function (c) {
        c.classList.toggle('active-tag', c.dataset.tag === tag);
      });
      document.querySelectorAll('.article').forEach(function (a) {
        var tags = (a.dataset.tags || '').split(',');
        if (tags.indexOf(tag) !== -1) {
          a.classList.add('tag-highlight');
          a.classList.remove('tag-dimmed');
        } else {
          a.classList.remove('tag-highlight');
          a.classList.add('tag-dimmed');
        }
      });
      // Scroll to the first highlighted article in the active panel
      var first = document.querySelector('.article.tag-highlight');
      if (first) first.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });
  // Failed source refetch buttons
  document.querySelectorAll('.refetch-btn').forEach(function (btn) {
    var fetching = false;
    btn.addEventListener('click', function () {
      if (fetching) {
        // Stop: abort any in-flight request
        fetching = false;
        btn.classList.remove('fetching');
        btn.textContent = btn.dataset.i18n || '\\u91cd\\u65b0\\u6293\\u53d6';
        return;
      }
      fetching = true;
      btn.dataset.i18n = btn.textContent;
      btn.classList.remove('success', 'error');
      btn.classList.add('fetching');
      btn.textContent = '\\u6293\\u53d6\\u4e2d...';
      var sourceId = btn.dataset.sourceId;
      fetch('/api/refetch/' + encodeURIComponent(sourceId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        fetching = false;
        btn.classList.remove('fetching');
        if (data.ok && data.count > 0) {
          btn.classList.add('success');
          btn.textContent = '\\u2713 ' + data.count + ' \\u6761';
        } else if (data.ok) {
          btn.classList.add('error');
          btn.textContent = '\\u4ecd\\u65e0\\u6570\\u636e';
        } else {
          btn.classList.add('error');
          btn.textContent = '\\u5931\\u8d25';
        }
      })
      .catch(function () {
        fetching = false;
        btn.classList.remove('fetching');
        btn.classList.add('error');
        btn.textContent = '\\u8bf7\\u5148\\u542f\\u52a8 serve';
      });
    });
  });
</script>
</body>
</html>`;
}

// ----- trading panel -----

const SIGNAL_TONE: Record<string, "bull" | "bear" | "caution"> = {
  "golden-cross": "bull",
  "macd-bull-cross": "bull",
  "above-sma50-sma200": "bull",
  "near-52w-high": "bull",
  "death-cross": "bear",
  "macd-bear-cross": "bear",
  "below-sma50-sma200": "bear",
  "near-52w-low": "bear",
  "rsi-overbought": "caution",
  "rsi-oversold": "caution",
};

const TREND_LABEL: Record<TickerAnalysis["trend"], string> = {
  bullish: STR.trendBullish,
  bearish: STR.trendBearish,
  neutral: STR.trendNeutral,
};

function stanceClass(stance: string): "bull" | "bear" | "neutral" {
  // Supports both legacy ("看多"/"看空") and current ("偏上行"/"偏下行")
  // stance values. The current values were chosen to avoid Sonnet's
  // "no investment advice" guardrail; rendering keeps both readable.
  if (/多|涨|上行|bull/i.test(stance)) return "bull";
  if (/空|跌|下行|bear/i.test(stance)) return "bear";
  return "neutral";
}

function fmtNum(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  // Use thousand separators only for prices >= 1000
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toFixed(dp).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return n.toFixed(dp);
}

function fmtPct(n: number, dp = 2): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(dp)}%`;
}

function renderPickCard(p: WatchlistPick): string {
  const cls = stanceClass(p.stance);
  const symbol = escapeHtml(p.symbol);
  const name = escapeHtml(p.display_name ?? p.symbol);
  const stance = escapeHtml(p.stance);
  const rationale = escapeHtml(p.rationale ?? "");
  return `<article class="trading-pick stance-${cls}">
    <header class="pick-head">
      <div class="pick-symbol-block">
        <span class="pick-symbol">${symbol}</span>
        <span class="pick-name">${name}</span>
      </div>
      <span class="pick-stance pick-stance-${cls}">${stance}</span>
    </header>
    <p class="pick-rationale">${rationale}</p>
  </article>`;
}

function renderTickerCard(t: TickerAnalysis): string {
  const trendCls = t.trend;
  const priceCls = t.pct1Day >= 0 ? "positive" : "negative";
  const pct5Cls = t.pct5Day >= 0 ? "positive" : "negative";
  const signals = t.signals
    .map((s) => {
      const tone = SIGNAL_TONE[s.type] ?? "caution";
      const ageSuffix =
        s.daysAgo !== undefined
          ? ` <span class="signal-age">(${s.daysAgo === 0 ? STR.signalToday : `${s.daysAgo} ${STR.signalDaysAgoSuffix}`})</span>`
          : "";
      return `<span class="signal-pill tone-${tone}">${escapeHtml(s.label)}${ageSuffix}</span>`;
    })
    .join("");
  const currencyPrefix = t.currency === "USD" ? "$" : t.currency === "HKD" ? "HK$" : t.currency === "CNY" ? "¥" : "";
  return `<article class="ticker-card">
    <header class="ticker-head">
      <div class="ticker-id">
        <h3 class="ticker-symbol">${escapeHtml(t.symbol)}</h3>
        <p class="ticker-name">${escapeHtml(t.displayName)}</p>
      </div>
      <div class="ticker-price-block">
        <span class="ticker-price">${currencyPrefix}${fmtNum(t.currentPrice)}</span>
        <span class="ticker-pct ${priceCls}">${fmtPct(t.pct1Day)}</span>
      </div>
    </header>
    <dl class="ticker-indicators">
      <div><dt>${STR.ticker5d}</dt><dd class="${pct5Cls}">${fmtPct(t.pct5Day)}</dd></div>
      <div><dt>${STR.tickerVs52wHigh}</dt><dd>${fmtPct(t.pct52WeekHigh, 1)}</dd></div>
      <div><dt>RSI(14)</dt><dd class="rsi-${t.rsiState}">${fmtNum(t.rsi14, 1)}</dd></div>
      <div><dt>${STR.tickerTrend}</dt><dd class="trend-${trendCls}">${TREND_LABEL[t.trend]}</dd></div>
      <div><dt>SMA 20 / 50 / 200</dt><dd>${fmtNum(t.sma20)} / ${fmtNum(t.sma50)} / ${fmtNum(t.sma200)}</dd></div>
      <div><dt>${STR.tickerMacd}</dt><dd>${fmtNum(t.macd, 3)} / ${fmtNum(t.macdSignal, 3)}</dd></div>
    </dl>
    ${signals ? `<div class="ticker-signals">${signals}</div>` : ""}
  </article>`;
}

function fearGreedTone(value: number): "fear-extreme" | "fear" | "neutral" | "greed" | "greed-extreme" {
  if (value <= 24) return "fear-extreme";
  if (value <= 44) return "fear";
  if (value <= 55) return "neutral";
  if (value <= 74) return "greed";
  return "greed-extreme";
}

function fmtBigUsd(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)} T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)} B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)} M`;
  return `$${n.toFixed(0)}`;
}

function renderCryptoWidgets(t: TradingSection): string {
  const fg = t.crypto_fear_greed;
  const cg = t.crypto_global;
  if (!fg && !cg) return "";
  const items: string[] = [];
  if (fg) {
    const tone = fearGreedTone(fg.value);
    items.push(`<div class="crypto-widget fg-${tone}">
      <div class="widget-label">${STR.widgetCryptoFearGreed}</div>
      <div class="widget-value">${fg.value}</div>
      <div class="widget-sub">${escapeHtml(fg.classificationCn)}</div>
    </div>`);
  }
  if (cg) {
    const tone = cg.marketCapChangePct24h >= 0 ? "positive" : "negative";
    items.push(`<div class="crypto-widget">
      <div class="widget-label">${STR.widgetCryptoCap}</div>
      <div class="widget-value">${fmtBigUsd(cg.totalMarketCapUsd)}</div>
      <div class="widget-sub ${tone}">${fmtPct(cg.marketCapChangePct24h)} / 24h</div>
    </div>`);
    items.push(`<div class="crypto-widget">
      <div class="widget-label">${STR.widgetBtcDom}</div>
      <div class="widget-value">${cg.btcDominance.toFixed(1)}%</div>
      <div class="widget-sub">ETH ${cg.ethDominance.toFixed(1)}%</div>
    </div>`);
    items.push(`<div class="crypto-widget">
      <div class="widget-label">${STR.widgetVolume24h}</div>
      <div class="widget-value">${fmtBigUsd(cg.total24hVolumeUsd)}</div>
      <div class="widget-sub">${STR.widgetActiveCoins} ${cg.activeCryptocurrencies.toLocaleString()}</div>
    </div>`);
  }
  return `<div class="crypto-widgets">${items.join("")}</div>`;
}

function renderTradingPanel(trading: TradingSection): string {
  const tickers = trading.tickers;
  const groupCounts: Record<AssetGroup, number> = {
    "us-equity": 0,
    crypto: 0,
    "china-equity": 0,
    "commodity-fx": 0,
    macro: 0,
  };
  for (const t of tickers) groupCounts[t.group as AssetGroup] = (groupCounts[t.group as AssetGroup] ?? 0) + 1;

  const groupTabs = ASSET_GROUP_ORDER.map(
    (g, i) =>
      `<button class="trading-group-tab${i === 0 ? " active" : ""}" data-group="${g}">${escapeHtml(ASSET_GROUP_LABELS_LOCALIZED[g])}<span class="count">${groupCounts[g] ?? 0}</span></button>`,
  ).join("");

  const groupPanels = ASSET_GROUP_ORDER.map((g, i) => {
    const groupTickers = tickers.filter((t) => t.group === g);
    // Crypto sub-tab carries an extra header widget panel (F&G + global stats)
    const cryptoWidgets =
      g === "crypto" ? renderCryptoWidgets(trading) : "";
    return `<div class="trading-group-content${i === 0 ? " active" : ""}" data-group="${g}">
      ${cryptoWidgets}
      ${groupTickers.length === 0 ? `<p class="empty">${STR.emptyGroup}</p>` : groupTickers.map(renderTickerCard).join("")}
    </div>`;
  }).join("");

  const overview = escapeHtml(trading.market_overview ?? "");
  const risk = escapeHtml(trading.risk_caveat ?? "");

  return `<section class="trading-overview-card">
    <span class="eyebrow">${STR.tradingMarketOverview}</span>
    <p class="overview-text trading-overview-text">${overview}</p>
  </section>

  ${
    trading.watchlist.length > 0
      ? `<section class="trading-watchlist">
    <h2 class="category-title trading-section-title">${STR.tradingTodayFocus}</h2>
    <div class="trading-picks">
      ${trading.watchlist.map(renderPickCard).join("\n")}
    </div>
  </section>`
      : ""
  }

  <section class="trading-tickers">
    <h2 class="category-title trading-section-title">${STR.tradingAllAssets}</h2>
    <nav class="trading-group-tabs">${groupTabs}</nav>
    <div class="trading-group-contents">${groupPanels}</div>
  </section>

  ${
    risk
      ? `<section class="trading-risk">
    <span class="eyebrow">${STR.tradingRiskCaveat}</span>
    <p>${risk}</p>
  </section>`
      : ""
  }`;
}

// ----- markdown -----

function renderBriefMarkdown(b: BriefItem): string {
  const importance = Number.isFinite(b.importance) ? b.importance : 0;
  return `### [${b.title}](${b.url})\n${b.source} · ${STR.mdImportance} ${importance}/10\n\n${b.summary}\n`;
}

function renderSectionMarkdown(title: string, briefs: BriefItem[]): string {
  if (briefs.length === 0) return "";
  return `## ${title}\n\n${briefs.map(renderBriefMarkdown).join("\n")}\n`;
}

export function renderMarkdown(report: DailyReport, date: string): string {
  const blocks: string[] = [];
  blocks.push(`# ${STR.siteTitle} · ${date}\n`);
  if (report.hero_headline) blocks.push(`> ${report.hero_headline}\n`);
  if (report.daily_overview) {
    blocks.push(`## ${STR.mdTodayOverview}\n\n${report.daily_overview}\n`);
  }
  blocks.push(
    renderSectionMarkdown(CATEGORY_DIGEST_LABELS.tech, report.tech_briefs),
  );
  blocks.push(
    renderSectionMarkdown(
      CATEGORY_DIGEST_LABELS.finance,
      report.finance_briefs,
    ),
  );
  blocks.push(
    renderSectionMarkdown(
      CATEGORY_DIGEST_LABELS.politics,
      report.politics_briefs,
    ),
  );
  if (report.editor_note) {
    blocks.push(`## ${STR.mdEditorNote}\n\n${report.editor_note}\n`);
  }
  if (report.keywords.length > 0) {
    blocks.push(
      `## ${STR.mdTodayKeywords}\n\n${report.keywords.map((k) => `\`#${k}\``).join(" ")}\n`,
    );
  }
  return blocks.filter(Boolean).join("\n");
}
