import type { RawArticle } from "../sources/types";

export const MAX_CUSTOM_KEYWORDS = 8;
export const MAX_CUSTOM_KEYWORD_LENGTH = 24;
export const MAX_CUSTOM_KEYWORD_TOTAL = 120;

export const BASE_FILTER_RULES_ZH =
  "对已启用信息源的抓取结果按 URL 和规范化标题去重；仅保留 72 小时内内容及实时榜单；剔除已禁用来源、国际时政中的体育内容和社区离题内容；再按栏目配额、来源均衡、源内热度或发布时间选入公共日报。AI 只对选入条目做标题、摘要、标签和编辑重要度精炼，不参与本轮候选价值筛选。";

export const BASE_FILTER_RULES_EN =
  "Deduplicate enabled-source results by URL and normalized title; keep items from the last 72 hours plus live rankings; exclude disabled sources, sports from world news, and off-topic community posts; then select the public brief by section quotas, source balance, source ranking, or publication time. AI refines titles, summaries, tags, and editorial importance only after selection; it does not perform candidate value selection in this run.";

export function isGoogleTrendsArticle(sourceId: string): boolean {
  return sourceId.startsWith("google-trends-");
}

export function isHotSearchArticle(sourceId: string): boolean {
  return isGoogleTrendsArticle(sourceId) || sourceId === "weibo-hot-search" || sourceId === "baidu-hot-search";
}

export function normalizeHotSearchQuery(title: string): string {
  return title.trim().replace(/^\[(?:新|荐|沸|热|爆)\]\s*/, "");
}

/** Keep the exact query visible even when an AI summary uses a generic phrase such as "该词条". */
export function preserveTrendQuery(
  sourceId: string,
  title: string,
  summary: string | undefined,
  locale: "zh" | "en" = "zh",
): string {
  if (!isHotSearchArticle(sourceId) || !title.trim()) return summary ?? "";
  const query = normalizeHotSearchQuery(title);
  const current = (summary ?? "").trim();
  const normalizedQuery = query.toLocaleLowerCase();
  const containsExactQuery = /^[\x00-\x7F]+$/.test(query)
    ? new RegExp(`(^|[^a-z0-9])${normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(current)
    : current.toLocaleLowerCase().includes(normalizedQuery);
  if (containsExactQuery) return current;
  if (locale === "zh" && current.includes("该词条")) {
    return current.replace("该词条", `搜索词「${query}」`);
  }
  return locale === "en"
    ? `Original search query "${query}": ${current || "Only the search-interest signal is confirmed; the reason remains unverified."}`
    : `搜索词「${query}」：${current || "当前仅确认搜索热度，具体原因待核验。"}`;
}

const COUNTRY_ALIASES: Array<[string, string[]]> = [
  ["美国", ["美国", "美方", "美军", "华盛顿", "united states", "u.s.", "us", "america", "american"]],
  ["英国", ["英国", "英方", "伦敦", "united kingdom", "britain", "british", "england"]],
  ["中国", ["中国", "中方", "北京", "china", "chinese"]],
  ["俄罗斯", ["俄罗斯", "俄方", "莫斯科", "russia", "russian"]],
  ["乌克兰", ["乌克兰", "基辅", "ukraine", "ukrainian"]],
  ["伊朗", ["伊朗", "德黑兰", "iran", "iranian"]],
  ["以色列", ["以色列", "以方", "特拉维夫", "israel", "israeli"]],
  ["巴勒斯坦", ["巴勒斯坦", "加沙", "约旦河西岸", "palestine", "palestinian", "gaza"]],
  ["印度", ["印度", "新德里", "india", "indian"]],
  ["日本", ["日本", "东京", "japan", "japanese"]],
  ["韩国", ["韩国", "首尔", "south korea", "korea", "korean"]],
  ["朝鲜", ["朝鲜", "平壤", "north korea", "dprk"]],
  ["法国", ["法国", "巴黎", "france", "french"]],
  ["德国", ["德国", "柏林", "germany", "german"]],
  ["加拿大", ["加拿大", "渥太华", "canada", "canadian"]],
  ["墨西哥", ["墨西哥", "mexico", "mexican"]],
  ["澳大利亚", ["澳大利亚", "澳洲", "悉尼", "australia", "australian"]],
  ["新加坡", ["新加坡", "singapore", "singaporean"]],
  ["卡塔尔", ["卡塔尔", "多哈", "qatar", "qatari"]],
  ["沙特阿拉伯", ["沙特", "利雅得", "saudi arabia", "saudi"]],
  ["土耳其", ["土耳其", "安卡拉", "turkey", "turkish"]],
  ["台湾", ["台湾", "台北", "taiwan"]],
];

function includesAlias(text: string, alias: string): boolean {
  if (/^[a-z .-]+$/i.test(alias)) {
    return new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}\\b`, "i").test(text);
  }
  return text.includes(alias);
}

export function detectCoverageCountries(text: string): string[] {
  const normalized = text.toLowerCase();
  return COUNTRY_ALIASES
    .filter(([, aliases]) => aliases.some((alias) => includesAlias(normalized, alias.toLowerCase())))
    .map(([country]) => country);
}

export function normalizeCustomKeywords(input: string | string[] | undefined): string[] {
  const values = Array.isArray(input) ? input : (input ?? "").split(/[\n,，、;；|]+/);
  const result: string[] = [];
  let total = 0;
  for (const value of values) {
    const cleaned = value
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_CUSTOM_KEYWORD_LENGTH);
    if (!cleaned) continue;
    const key = cleaned.toLocaleLowerCase();
    if (result.some((item) => item.toLocaleLowerCase() === key)) continue;
    if (total + cleaned.length > MAX_CUSTOM_KEYWORD_TOTAL) break;
    result.push(cleaned);
    total += cleaned.length;
    if (result.length >= MAX_CUSTOM_KEYWORDS) break;
  }
  return result;
}

export function matchCustomKeywords(article: Pick<RawArticle, "title" | "excerpt" | "summary" | "displayTitle">, keywords: string[]): string[] {
  if (keywords.length === 0) return [];
  const text = `${article.displayTitle ?? ""} ${article.title} ${article.excerpt ?? ""} ${article.summary ?? ""}`.toLocaleLowerCase();
  return keywords.filter((keyword) => text.includes(keyword.toLocaleLowerCase()));
}

export function politicsAttribution(sourceCountry: string | undefined, coverageCountries: string[]): string {
  if (!sourceCountry) return "";
  const covered = coverageCountries.length > 0 ? ` · 涉及：${coverageCountries.join("、")}` : " · 国际报道";
  return `${sourceCountry}媒体${covered}`;
}
