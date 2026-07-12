import type { RawArticle } from "../sources/types";

export const MAX_CUSTOM_KEYWORDS = 8;
export const MAX_CUSTOM_KEYWORD_LENGTH = 24;
export const MAX_CUSTOM_KEYWORD_TOTAL = 120;

export const BASE_FILTER_RULES_ZH =
  "覆盖热搜、技术、财经、国际时政；优先时效性、事实密度、来源多样性和重要度；同一事件去重；摘要保留主体、地点、时间、数字和原文可验证信息；国际时政同时标注媒体所属国与文章涉及国。";

export const BASE_FILTER_RULES_EN =
  "Cover trends, technology, finance, and world news; prioritize timeliness, factual density, source diversity, and importance; deduplicate the same event; retain verifiable people, places, dates, and numbers; label both publisher country and countries covered in world-news items.";

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
