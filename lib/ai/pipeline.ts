import { jsonrepair } from "jsonrepair";
import { runLlm } from "./llm";
import { extractJson } from "./json-util";
import { SYSTEM_PROMPT_DIGEST_EN, SYSTEM_PROMPT_DIGEST_ZH } from "./prompts";
import { REPORT_LOCALE } from "../sources/registry";
import type { Category, RawArticle } from "../sources/types";
import {
  configuredFreshnessHours,
  isPublishedWithinFreshnessWindow,
} from "../sources/freshness";

const SYSTEM_PROMPT_DIGEST =
  REPORT_LOCALE === "en" ? SYSTEM_PROMPT_DIGEST_EN : SYSTEM_PROMPT_DIGEST_ZH;

export interface BriefItem {
  title: string;
  url: string;
  source: string;
  summary: string;
  importance: number;
}

export interface DailyReport {
  hero_headline: string;
  daily_overview: string;
  tech_briefs: BriefItem[];
  finance_briefs: BriefItem[];
  politics_briefs: BriefItem[];
  editor_note: string;
  keywords: string[];
  /** Optional trading-signals section, present when scripts/daily.ts ran successfully. */
  trading?: TradingSection;
}

import type { TickerAnalysis } from "../trading/signals";
import type { CryptoGlobalStats } from "../trading/coingecko";
import type { FearGreedSnapshot } from "../trading/fear-greed";
import type { TradingCommentary } from "./trading-commentary";

export interface TradingSection extends TradingCommentary {
  generated_at: string;
  tickers: TickerAnalysis[];
  crypto_fear_greed?: FearGreedSnapshot;
  crypto_global?: CryptoGlobalStats;
}

export interface ArticleInput extends RawArticle {
  source: string;
}

const HIGH_RISK_REVIEW_CONTENT = /病逝|去世|死亡|身亡|遇害|被杀|逮捕|被捕|拘留|辞职|下台|被解职|died|dead|death|killed|assassinated|arrested|detained|resigned|stepped down|removed from office/i;

export function hasHighRiskReviewContent(item: Pick<ArticleInput, "title" | "excerpt" | "summary" | "displayTitle">): boolean {
  return HIGH_RISK_REVIEW_CONTENT.test(`${item.title} ${item.excerpt ?? ""} ${item.displayTitle ?? ""} ${item.summary ?? ""}`);
}

export function createReviewUnavailableFallbackArticles(articles: ArticleInput[]): ArticleInput[] {
  return articles.map((article) => ({
    ...article,
    displayTitle: article.title,
    summary: REPORT_LOCALE === "en"
      ? `Information limited: source excerpt only. ${(article.excerpt ?? article.title).slice(0, 260)}`
      : `信息有限：仅展示来源原文摘录。${(article.excerpt ?? article.title).slice(0, 260)}`,
    aiAnalysis: REPORT_LOCALE === "en"
      ? "AI analysis is unavailable for this item; verify the linked source before drawing conclusions or acting on it."
      : "本条 AI 分析暂不可用，形成判断或采取行动前请先核验标题所链接的原始来源。",
    importance: 1,
    tags: [REPORT_LOCALE === "en" ? "Information limited" : "信息有限"],
    coverageCountries: [],
    interestMatches: [],
  }));
}

export function canPublishLimitedCircuitEdition(input: {
  enrichmentStopReason?: "budget" | "empty_response";
  sourceFallbackArticles: number;
  hasHighRiskContent: boolean;
  hasDisallowedReviewRisk: boolean;
}): boolean {
  return !!input.enrichmentStopReason
    && input.sourceFallbackArticles > 0
    && !input.hasHighRiskContent
    && !input.hasDisallowedReviewRisk;
}

export function createReviewUnavailableFallback(articles: ArticleInput[]): DailyReport {
  const grouped: Record<Category, ArticleInput[]> = { trending: [], tech: [], finance: [], politics: [] };
  for (const article of articles) grouped[article.category].push(article);
  const toBriefs = (items: ArticleInput[], limit: number): BriefItem[] => items.slice(0, limit).map((article) => ({
    title: article.title,
    url: article.url,
    source: article.source,
    summary: article.summary ?? article.excerpt ?? article.title,
    importance: 1,
  }));
  return {
    hero_headline: REPORT_LOCALE === "en" ? "Daily Brief - source-only edition" : "每日简报 - 来源原文版",
    daily_overview: REPORT_LOCALE === "en"
      ? "The AI quality review service was unavailable. This limited edition contains source titles and excerpts only, without AI factual synthesis."
      : "AI 质量审核服务不可用。本次为信息有限版本，仅展示来源标题和原文摘录，不包含 AI 事实归纳。",
    tech_briefs: toBriefs(grouped.tech, 5),
    finance_briefs: toBriefs(grouped.finance, 5),
    politics_briefs: toBriefs(grouped.politics, 3),
    editor_note: REPORT_LOCALE === "en" ? "Quality review unavailable; source-only edition." : "质量审核不可用；仅发布来源原文版。",
    keywords: [],
  };
}

const PER_CATEGORY_LIMIT: Record<Category, number> = {
  trending: 20,
  tech: 25,
  finance: 20,
  politics: 15,
};

/**
 * Pick `limit` items from `items` so every source gets a fair shot.
 *
 * Why this exists: the previous `slice(0, limit)` honored insertion order,
 * which is the source-iteration order in daily.ts. That gave whichever
 * source came first 100% of the quota — e.g. all 25 tech slots filled by
 * Hacker News before GitHub Trending / Solidot / V2EX / 阮一峰 got a turn.
 *
 * Strategy: drop dated items outside the shared freshness window, group by sourceId,
 * sort each bucket newest-first, then round-robin one item per source
 * until we hit the limit. Sources with fewer items naturally drop out
 * and others absorb the slack.
 */
export function selectRoundRobin(
  items: ArticleInput[],
  limit: number,
  options: { referenceTime?: Date; maxAgeHours?: number } = {},
): ArticleInput[] {
  const referenceTime = options.referenceTime ?? new Date();
  const maxAgeHours = options.maxAgeHours ?? configuredFreshnessHours();
  const fresh = items.filter(
    (it) => !it.publishedAt
      || isPublishedWithinFreshnessWindow(it.publishedAt, referenceTime, maxAgeHours),
  );

  const bySource = new Map<string, ArticleInput[]>();
  for (const it of fresh) {
    const arr = bySource.get(it.sourceId) ?? [];
    arr.push(it);
    bySource.set(it.sourceId, arr);
  }
  for (const arr of bySource.values()) {
    arr.sort(
      (a, b) => {
        const interestDelta = (b.interestMatches?.length ?? 0) - (a.interestMatches?.length ?? 0);
        if (interestDelta !== 0) return interestDelta;
        return (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0);
      },
    );
  }

  const buckets = Array.from(bySource.values());
  const out: ArticleInput[] = [];
  let madeProgress = true;
  while (out.length < limit && madeProgress) {
    madeProgress = false;
    for (const b of buckets) {
      if (b.length === 0) continue;
      out.push(b.shift()!);
      madeProgress = true;
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function buildDailyReportFromEnriched(articles: ArticleInput[]): DailyReport {
  const grouped: Record<Category, ArticleInput[]> = { trending: [], tech: [], finance: [], politics: [] };
  for (const article of articles) grouped[article.category].push(article);

  const ranked = (items: ArticleInput[]) => [...items].sort((a, b) => {
    const interestDelta = (b.interestMatches?.length ?? 0) - (a.interestMatches?.length ?? 0);
    if (interestDelta !== 0) return interestDelta;
    const importanceDelta = (b.importance ?? 5) - (a.importance ?? 5);
    if (importanceDelta !== 0) return importanceDelta;
    return (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0);
  });
  const toBriefs = (items: ArticleInput[], limit: number): BriefItem[] => ranked(items)
    .slice(0, limit)
    .map((article) => ({
      title: article.displayTitle ?? article.title,
      url: article.url,
      source: article.source,
      summary: article.summary ?? article.excerpt ?? article.title,
      importance: article.importance ?? 5,
    }));

  const allRanked = ranked(articles);
  const lead = allRanked[0];
  const overviewParts = (Object.keys(grouped) as Category[])
    .map((category) => ranked(grouped[category])[0]?.summary)
    .filter((summary): summary is string => Boolean(summary));
  const tagCounts = new Map<string, number>();
  for (const article of articles) {
    for (const tag of article.tags ?? []) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }

  return {
    hero_headline: lead?.displayTitle ?? lead?.title ?? (REPORT_LOCALE === "en" ? "Daily Brief" : "每日简报"),
    daily_overview: overviewParts.join(REPORT_LOCALE === "en" ? " " : "；").slice(0, REPORT_LOCALE === "en" ? 900 : 220),
    tech_briefs: toBriefs(grouped.tech, 5),
    finance_briefs: toBriefs(grouped.finance, 5),
    politics_briefs: toBriefs(grouped.politics, 3),
    editor_note: REPORT_LOCALE === "en"
      ? "Compiled deterministically from the same AI-enriched articles displayed in the web edition."
      : "本期概览由网页端实际展示的 AI 精炼条目确定性生成。",
    keywords: [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([tag]) => tag),
  };
}

async function callOnce(userPayloadJson: string): Promise<DailyReport> {
  // Claude Code CLI's built-in system prompt biases the model toward
  // conversational markdown output. Anchor the format expectation in the
  // user message (instruction recency wins) *and* explicitly demand every
  // schema field be populated — without this Sonnet has been observed to
  // emit a JSON shell with empty arrays to "satisfy" a JSON-only ask.
  const userPrompt =
    REPORT_LOCALE === "en"
      ? [
          "**Output language: ENGLISH ONLY.** Every string value in the JSON — hero_headline, daily_overview, every brief's title/summary, editor_note, keywords — must be written entirely in English. No Chinese characters anywhere.",
          "",
          "Your task: generate today's daily brief from the candidate news below. **The response MUST be a single valid JSON object** — starts with `{`, ends with `}`, no markdown, no code fences, no explanations.",
          "",
          "The JSON must contain every field non-empty (briefs arrays per the system-prompt counts):",
          "  - hero_headline: 10-25 word headline of the day",
          "  - daily_overview: **150-250 word** paragraph covering tech / finance / politics signals so a reader sees the whole picture at a glance",
          "  - tech_briefs: **3-5** tech BriefItems",
          "  - finance_briefs: **3-5** finance BriefItems",
          "  - politics_briefs: **2-3** politics BriefItems",
          "  - editor_note: 30-60 word editor's note",
          "  - keywords: 5-8 keywords",
          "",
          "BriefItem fields: title, url (copied verbatim from candidate), source, summary, importance (1-10). For politics, keep publisher-country and covered-country distinctions from the candidate metadata; for trends, describe search interest and do not turn keywords into verified facts.",
          "**Quote rule (important!)**: For any quotation INSIDE a JSON string, use single quotes ' or curly quotes '\" — **never** raw double quotes \", which break JSON parsing.",
          "No trailing commas.",
          "",
          `Candidate news (JSON array, ${userPayloadJson.length} chars):`,
          userPayloadJson,
        ].join("\n")
      : [
          "你的任务：根据下方候选新闻，生成一份当日简报，**响应必须是一个合法 JSON 对象**——以 `{` 开头，以 `}` 结尾，不要 markdown / 不要代码围栏 / 不要任何解释。",
          "",
          "JSON 必须包含全部字段且不能为空（briefs 数组按 system prompt 规定的条数填充）：",
          "  - hero_headline: 10-25 字的当日一句话头条",
          "  - daily_overview: **150-220 字** 的当日总览段落，一段话覆盖技术 / 财经 / 时政 的核心信号，让读者一眼抓住全貌",
          "  - tech_briefs: **3-5 条** 科技 BriefItem",
          "  - finance_briefs: **3-5 条** 财经 BriefItem",
          "  - politics_briefs: **2-3 条** 时政 BriefItem",
          "  - editor_note: 30-60 字的编辑短评",
          "  - keywords: 5-8 个关键词",
          "",
          "BriefItem 字段：title、url（必须从候选条目原样选取）、source、summary、importance(1-10)。国际时政必须保留候选元数据中的媒体所属国与涉及国区分；热搜只能说明搜索热度，不能写成已确认事实。",
          "**引号规则（重要！）**：JSON 字符串内的中文引用请使用**中文全角引号**「」或者 “”，**绝对不要**用英文双引号 \" —— 那会导致 JSON 解析失败。例：写 商务部回应「内卷」 而不是 商务部回应\"内卷\"。",
          "不要使用单引号、不要末尾多余逗号。",
          "",
          "候选新闻（JSON 数组，共 " + userPayloadJson.length + " 字符）：",
          userPayloadJson,
        ].join("\n");
  // Digest gets a longer timeout (180s) than enrichment (80s) because it
  // produces a larger, more structured output that the model needs more time
  // to reason about.
  const { text } = await runLlm({
    systemPrompt: SYSTEM_PROMPT_DIGEST,
    userPrompt,
    timeoutMs: 180_000,
  });
  const cleaned = extractJson(text);
  let parsed: Partial<DailyReport>;
  try {
    parsed = JSON.parse(cleaned) as Partial<DailyReport>;
  } catch (strictErr) {
    // LLMs routinely emit JSON with unescaped quotes inside Chinese
    // strings (e.g. 商务部回应"内卷"). jsonrepair fixes most of these
    // mechanically before we ever surface a failure.
    try {
      const repaired = jsonrepair(cleaned);
      parsed = JSON.parse(repaired) as Partial<DailyReport>;
      console.warn("[pipeline] JSON.parse failed but jsonrepair recovered");
    } catch {
      try {
        const fs = await import("node:fs");
        fs.mkdirSync("logs", { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        fs.writeFileSync(`logs/claude-raw-${ts}.txt`, text, "utf8");
        fs.writeFileSync(`logs/claude-cleaned-${ts}.txt`, cleaned, "utf8");
        console.warn(
          `[pipeline] both JSON.parse and jsonrepair failed; raw at logs/claude-raw-${ts}.txt`,
        );
      } catch {
        // best-effort logging
      }
      throw strictErr;
    }
  }
  return {
    hero_headline: parsed.hero_headline ?? "",
    daily_overview: parsed.daily_overview ?? "",
    tech_briefs: parsed.tech_briefs ?? [],
    finance_briefs: parsed.finance_briefs ?? [],
    politics_briefs: parsed.politics_briefs ?? [],
    editor_note: parsed.editor_note ?? "",
    keywords: parsed.keywords ?? [],
  };
}

/**
 * Build a minimal fallback digest when the LLM completely fails.
 * Instead of aborting, we produce a usable report from raw article titles
 * so the daily output is never empty.
 */
function fallbackDigest(articles: ArticleInput[]): DailyReport {
  const grouped: Record<Category, ArticleInput[]> = {
    trending: [],
    tech: [],
    finance: [],
    politics: [],
  };
  for (const a of articles) grouped[a.category].push(a);

  const toBriefs = (items: ArticleInput[], limit: number): BriefItem[] =>
    items.slice(0, limit).map((a) => ({
      title: a.displayTitle ?? a.title,
      url: a.url,
      source: a.source,
      summary: a.summary ?? a.excerpt ?? "",
      importance: a.importance ?? 5,
    }));

  return {
    hero_headline: REPORT_LOCALE === "en"
      ? `Daily Brief — ${new Date().toISOString().slice(0, 10)}`
      : `每日简报 — ${new Date().toISOString().slice(0, 10)}`,
    daily_overview: REPORT_LOCALE === "en"
      ? "Auto-generated fallback: LLM digest failed. Showing raw article titles."
      : "自动降级简报：LLM 生成失败，以下为原始文章列表。",
    tech_briefs: toBriefs(grouped.tech, 5),
    finance_briefs: toBriefs(grouped.finance, 5),
    politics_briefs: toBriefs(grouped.politics, 3),
    editor_note: "",
    keywords: [],
  };
}

function ensureSourceDiversity(
  briefs: BriefItem[],
  candidates: ArticleInput[],
): BriefItem[] {
  if (briefs.length < 2 || new Set(briefs.map((brief) => brief.source)).size >= 2) return briefs;
  const primarySource = briefs[0]?.source;
  const usedUrls = new Set(briefs.map((brief) => brief.url));
  const replacement = candidates
    .filter((article) => article.summary && article.source !== primarySource && !usedUrls.has(article.url))
    .sort((a, b) => (b.importance ?? 5) - (a.importance ?? 5))[0];
  if (!replacement) return briefs;
  const diversified = [...briefs];
  diversified[diversified.length - 1] = {
    title: replacement.displayTitle ?? replacement.title,
    url: replacement.url,
    source: replacement.source,
    summary: replacement.summary ?? "",
    importance: replacement.importance ?? 5,
  };
  return diversified;
}

export async function generateDailyReport(
  articles: ArticleInput[],
): Promise<{ report: DailyReport; tokensUsed: number }> {
  const grouped: Record<Category, ArticleInput[]> = {
    trending: [],
    tech: [],
    finance: [],
    politics: [],
  };
  for (const a of articles) grouped[a.category].push(a);

  const compact = (Object.keys(grouped) as Category[]).flatMap((c) =>
    selectRoundRobin(grouped[c], PER_CATEGORY_LIMIT[c]),
  );

  const userPayload = compact.map((a, i) => ({
    n: i + 1,
    title: a.displayTitle ?? a.title,
    url: a.url,
    source: a.source,
    sourceCountry: a.sourceCountry ?? "",
    coverageCountries: a.coverageCountries ?? [],
    interestMatches: a.interestMatches ?? [],
    category: a.category,
    excerpt: (a.summary ?? a.excerpt ?? "").slice(0, 160),
    published: a.publishedAt?.toISOString() ?? "",
  }));
  const userPayloadJson = JSON.stringify(userPayload);

  let report: DailyReport = fallbackDigest(articles);
  try {
    report = await callOnce(userPayloadJson);
  } catch (firstErr) {
    // Up to two retries — claude CLI occasionally wraps in narration on
    // early passes but obeys when the same prompt is repeated.
    let lastErr = firstErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      console.warn(
        `[pipeline] claude CLI call failed (attempt ${attempt}/2): ${
          lastErr instanceof Error ? lastErr.message : String(lastErr)
        }`,
      );
      try {
        report = await callOnce(userPayloadJson);
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) {
      console.warn("[pipeline] all claude CLI attempts failed, using fallback digest");
      report = fallbackDigest(articles);
    }
  }

  report.tech_briefs = ensureSourceDiversity(report.tech_briefs, grouped.tech);
  report.finance_briefs = ensureSourceDiversity(report.finance_briefs, grouped.finance);
  report.politics_briefs = ensureSourceDiversity(report.politics_briefs, grouped.politics);

  // Max subscription has no per-call token meter — we expose 0 for schema
  // compatibility; consumers should treat 0 as "metric not available".
  return { report, tokensUsed: 0 };
}
