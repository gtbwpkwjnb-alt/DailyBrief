import type { ArticleInput } from "../ai/pipeline";
import type { Category } from "../sources/types";

export type CategoryDigestLocale = "zh" | "en";

const FALLBACK_ANALYSIS = /AI 分析暂不可用|AI analysis is unavailable/i;
const FALLBACK_SUMMARY = /信息有限\s*[：:]\s*仅展示来源原文摘录|Information limited\s*:\s*source excerpt only|来源原文降级|source[- ]only edition/i;
const FALLBACK_TAG = /^(信息有限|Information limited)$/i;

const CATEGORY_LABELS = {
  zh: {
    trending: "热搜趋势",
    tech: "技术动态",
    finance: "财经要点",
    politics: "国际时政",
  },
  en: {
    trending: "Trending",
    tech: "Technology",
    finance: "Finance",
    politics: "Politics",
  },
} as const;

function isSuccessfulEnrichment(article: ArticleInput): boolean {
  return Boolean(
    article.displayTitle?.trim()
      && article.summary?.trim()
      && article.aiAnalysis?.trim()
      && !FALLBACK_ANALYSIS.test(article.aiAnalysis)
      && !FALLBACK_SUMMARY.test(article.summary)
      && !(article.tags ?? []).some((tag) => FALLBACK_TAG.test(tag.trim())),
  );
}

function compareArticles(left: ArticleInput, right: ArticleInput): number {
  const importanceDelta = (right.importance ?? 0) - (left.importance ?? 0);
  if (importanceDelta !== 0) return importanceDelta;

  const publishedDelta = (right.publishedAt?.getTime() ?? 0) - (left.publishedAt?.getTime() ?? 0);
  if (publishedDelta !== 0) return publishedDelta;

  return (left.displayTitle ?? left.title).localeCompare(right.displayTitle ?? right.title, "zh-Hans-CN");
}

function compactText(article: ArticleInput, locale: CategoryDigestLocale): string {
  const text = article.aiAnalysis?.trim() || article.summary?.trim() || "";
  const limit = locale === "en" ? 80 : 72;
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}...` : text;
}

/**
 * Builds deterministic, display-safe category overviews from successfully
 * AI-enriched items only. Fallback/source-only items are deliberately absent.
 */
export function buildCategoryDigests(
  articles: ArticleInput[],
  locale: CategoryDigestLocale = "zh",
): Record<string, string> {
  const grouped = new Map<Category, ArticleInput[]>();
  for (const article of articles) {
    if (!isSuccessfulEnrichment(article)) continue;
    const items = grouped.get(article.category) ?? [];
    items.push(article);
    grouped.set(article.category, items);
  }

  const result: Record<string, string> = {};
  for (const [category, items] of grouped) {
    const selected = [...items].sort(compareArticles).slice(0, 3);
    if (selected.length === 0) continue;

    const label = CATEGORY_LABELS[locale][category];
    const entries = selected.map((article) => {
      const title = article.displayTitle!.trim();
      return locale === "en"
        ? `${title}: ${compactText(article, locale)}`
        : `${title}：${compactText(article, locale)}`;
    });
    const prefix = locale === "en"
      ? `${label} brief (based on current valid items): `
      : `${label}栏目速览（基于当前有效条目）：`;
    result[category] = `${prefix}${entries.join(locale === "en" ? "; " : "；")}`.slice(0, 320);
  }

  return result;
}
