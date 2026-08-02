import type { ArticleInput } from "../ai/pipeline";
import type { Category, SourceDef } from "../sources/types";

const CATEGORIES: Category[] = ["trending", "tech", "politics", "finance"];

export interface PublicSelectionOptions {
  /** Preferred per-section ceilings. Actual reading budgets adapt to qualified supply. */
  categoryTargets?: Partial<Record<Category, number>>;
  /** Minimum deterministic value score required after hard filtering. */
  minimumQualityScore?: number;
  referenceTime?: Date;
}

export interface PublicSelectionStats {
  input: number;
  eligible: number;
  hardFiltered: number;
  lowInformationFiltered: number;
  unavailableSourceFiltered: number;
  qualityFiltered: number;
  eventMerged: number;
  adaptiveTarget: number;
  selected: number;
  byCategory: Record<Category, number>;
  adaptiveByCategory: Record<Category, number>;
  expansionArticles: number;
  expansionReasons: Array<{ category: Category; count: number; reason: "high_value_density" }>;
}

export interface PublicSelectionResult {
  articles: ArticleInput[];
  stats: PublicSelectionStats;
}

interface ScoredArticle {
  article: ArticleInput;
  score: number;
}

const DEFAULT_TARGETS: Record<Category, number> = {
  trending: 6,
  tech: 16,
  politics: 10,
  finance: 10,
};
const DEFAULT_MINIMUM_QUALITY_SCORE = 72;

const LOW_INFORMATION_TITLE = /^(?:daily\s+discussion|open\s+thread|what\s+are\s+you\s+working\s+on|me_?irl|explain\s+it\s+peter|first|test|hello|闲聊|水帖|每日讨论)$/i;

function normalizedText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleTokens(article: ArticleInput): Set<string> {
  const text = normalizedText(article.displayTitle ?? article.title);
  const tokens = new Set(text.split(" ").filter((token) => token.length >= 3));
  // Chinese and Japanese titles often have no whitespace. Character bigrams
  // provide a conservative deterministic similarity signal for those titles.
  const compact = text.replace(/\s/g, "");
  for (let index = 0; index < compact.length - 1; index += 1) {
    const token = compact.slice(index, index + 2);
    if (/[^\x00-\x7f]/.test(token)) tokens.add(token);
  }
  return tokens;
}

function similarity(left: ArticleInput, right: ArticleInput): number {
  const leftTitle = normalizedText(left.displayTitle ?? left.title);
  const rightTitle = normalizedText(right.displayTitle ?? right.title);
  if (!leftTitle || !rightTitle) return 0;
  if (leftTitle === rightTitle || leftTitle.includes(rightTitle) || rightTitle.includes(leftTitle)) return 1;
  const leftTokens = titleTokens(left);
  const rightTokens = titleTokens(right);
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  const union = leftTokens.size + rightTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function isLowInformation(article: ArticleInput): boolean {
  const title = (article.displayTitle ?? article.title).trim();
  const body = (article.summary ?? article.excerpt ?? "").trim();
  const combined = normalizedText(`${title} ${body}`);
  if (!title || LOW_INFORMATION_TITLE.test(title)) return true;
  if (combined.length < 16) return true;
  // A trend query with neither traffic/context nor a linked report is not a
  // publishable fact on its own. This only removes it; it never invents cause.
  if (article.category === "trending" && body.length < 18) return true;
  return false;
}

function sourceQuality(source: SourceDef | undefined): number {
  if (!source) return 0;
  const priority = Math.max(1, Math.min(5, source.priority ?? 3));
  const tierBonus = source.tier === "core" ? 1 : source.tier === "supplement" ? -0.5 : 0;
  return priority * 12 + tierBonus * 6;
}

function scoreArticle(article: ArticleInput, source: SourceDef | undefined, referenceTime: Date): number {
  const body = article.summary ?? article.excerpt ?? "";
  const detail = Math.min(24, Math.floor(normalizedText(body).length / 12) * 3);
  const importance = Math.max(0, Math.min(10, article.importance ?? 5)) * 4;
  const evidence = article.evidenceState === "multi_source_confirmed" ? 12
    : article.evidenceState === "single_named_source" ? 7
      : article.evidenceState === "developing" ? 3 : 0;
  const metadata = (article.tags?.length ?? 0) > 0 ? 2 : 0;
  const ageHours = article.publishedAt
    ? Math.max(0, (referenceTime.getTime() - article.publishedAt.getTime()) / 3_600_000)
    : 72;
  const freshness = Math.max(0, 14 - Math.min(14, ageHours / 6));
  return sourceQuality(source) + detail + importance + evidence + metadata + freshness;
}

function stableRank(left: ScoredArticle, right: ScoredArticle): number {
  if (right.score !== left.score) return right.score - left.score;
  const rightPublished = right.article.publishedAt?.getTime() ?? 0;
  const leftPublished = left.article.publishedAt?.getTime() ?? 0;
  if (rightPublished !== leftPublished) return rightPublished - leftPublished;
  return left.article.sourceId.localeCompare(right.article.sourceId)
    || left.article.url.localeCompare(right.article.url)
    || left.article.title.localeCompare(right.article.title);
}

function isHighValue(candidate: ScoredArticle): boolean {
  return (candidate.article.importance ?? 5) >= 8
    || candidate.article.evidenceState === "multi_source_confirmed"
    || candidate.score >= 112;
}

function categoryReadingBudget(qualified: ScoredArticle[], preferredCeiling: number): {
  base: number;
  expansion: number;
} {
  if (qualified.length === 0 || preferredCeiling <= 0) return { base: 0, expansion: 0 };
  // Activity grows sublinearly: a tenfold increase in raw candidates cannot
  // create a tenfold reading burden. The preferred ceiling is a soft editorial
  // bound, not a quota that must be filled.
  const base = Math.min(
    qualified.length,
    preferredCeiling,
    Math.max(2, Math.ceil(Math.sqrt(qualified.length) * 2)),
  );
  const highValueOutsideBase = qualified.slice(base).filter(isHighValue).length;
  // Expansion requires high-value supply beyond the normal reading budget.
  // Square-root growth has no fixed upper bound, but prevents a surge in raw
  // candidates from creating a proportional reading burden.
  const expansion = Math.min(
    highValueOutsideBase,
    Math.ceil(Math.sqrt(highValueOutsideBase)),
  );
  return { base, expansion };
}

function dynamicSourceCap(readingBudget: number): number {
  // Small sections still get at least one item per source. Larger active
  // sections may take more from a source, but never enough to dominate them.
  return Math.max(1, Math.min(4, Math.ceil(readingBudget * 0.4)));
}

/**
 * Select a compact public briefing from already deduplicated, fresh candidates.
 * The function is intentionally deterministic and does not synthesize facts.
 */
export function selectPublicArticles(
  articles: ArticleInput[],
  sources: SourceDef[],
  options: PublicSelectionOptions = {},
): PublicSelectionResult {
  const targets = { ...DEFAULT_TARGETS, ...options.categoryTargets };
  const minimumQualityScore = Math.max(0, options.minimumQualityScore ?? DEFAULT_MINIMUM_QUALITY_SCORE);
  const referenceTime = options.referenceTime ?? new Date();
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const stats: PublicSelectionStats = {
    input: articles.length, eligible: 0, hardFiltered: 0, lowInformationFiltered: 0,
    unavailableSourceFiltered: 0, qualityFiltered: 0, eventMerged: 0, adaptiveTarget: 0, selected: 0,
    byCategory: { trending: 0, tech: 0, politics: 0, finance: 0 },
    adaptiveByCategory: { trending: 0, tech: 0, politics: 0, finance: 0 },
    expansionArticles: 0, expansionReasons: [],
  };

  const eligible: ScoredArticle[] = [];
  for (const article of articles) {
    const source = sourceById.get(article.sourceId);
    if (!source || source.enabled === false) {
      stats.hardFiltered += 1;
      stats.unavailableSourceFiltered += 1;
      continue;
    }
    if (isLowInformation(article)) {
      stats.hardFiltered += 1;
      stats.lowInformationFiltered += 1;
      continue;
    }
    const score = scoreArticle(article, source, referenceTime);
    if (score < minimumQualityScore) {
      stats.qualityFiltered += 1;
      continue;
    }
    eligible.push({ article, score });
  }
  stats.eligible = eligible.length;
  eligible.sort(stableRank);

  const representatives: ScoredArticle[] = [];
  for (const candidate of eligible) {
    const duplicate = representatives.some((kept) =>
      kept.article.category === candidate.article.category && similarity(kept.article, candidate.article) >= 0.78,
    );
    if (duplicate) {
      stats.eventMerged += 1;
      continue;
    }
    representatives.push(candidate);
  }

  const selected: ArticleInput[] = [];
  for (const category of CATEGORIES) {
    const ranked = representatives.filter((candidate) => candidate.article.category === category);
    const budget = categoryReadingBudget(ranked, Math.max(0, targets[category] ?? 0));
    const target = budget.base + budget.expansion;
    stats.adaptiveByCategory[category] = target;
    stats.adaptiveTarget += target;
    if (budget.expansion > 0) {
      stats.expansionReasons.push({ category, count: budget.expansion, reason: "high_value_density" });
    }
    const selectedPerSource = new Map<string, number>();
    const sourceCap = dynamicSourceCap(target);
    for (let index = 0; index < ranked.length && stats.byCategory[category] < target; index += 1) {
      const candidate = ranked[index]!;
      // Past the normal budget, only explicitly high-value items may expand a section.
      if (stats.byCategory[category] >= budget.base && !isHighValue(candidate)) continue;
      const count = selectedPerSource.get(candidate.article.sourceId) ?? 0;
      if (count >= sourceCap) continue;
      selected.push(candidate.article);
      selectedPerSource.set(candidate.article.sourceId, count + 1);
      stats.byCategory[category] += 1;
      if (stats.byCategory[category] > budget.base) stats.expansionArticles += 1;
    }
  }
  stats.selected = selected.length;
  return { articles: selected, stats };
}
