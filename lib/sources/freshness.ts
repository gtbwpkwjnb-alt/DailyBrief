import type { RawArticle, SourceDef } from "./types";

export const DEFAULT_FRESHNESS_HOURS = 72;
const MAX_FUTURE_SKEW_HOURS = 6;

export type FreshnessStats = {
  freshnessWindowHours: number;
  freshArticles: number;
  staleArticlesRejected: number;
  undatedArticlesRejected: number;
  futureArticlesRejected: number;
  liveSnapshotArticles: number;
  newestPublishedAt?: string;
};

export type FreshnessResult<T extends RawArticle> = {
  articles: T[];
  stats: FreshnessStats;
};

export function configuredFreshnessHours(raw = process.env.REPORT_FRESHNESS_HOURS): number {
  if (!raw?.trim()) return DEFAULT_FRESHNESS_HOURS;
  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error("REPORT_FRESHNESS_HOURS must be an integer between 1 and 336");
  }
  const value = Number(normalized);
  if (!Number.isInteger(value) || value < 1 || value > 336) {
    throw new Error("REPORT_FRESHNESS_HOURS must be an integer between 1 and 336");
  }
  return value;
}

export function isPublishedWithinFreshnessWindow(
  publishedAt: Date,
  referenceTime: Date,
  maxAgeHours: number,
): boolean {
  const publishedMs = publishedAt.getTime();
  const referenceMs = referenceTime.getTime();
  if (!Number.isFinite(publishedMs) || !Number.isFinite(referenceMs)) return false;
  const ageMs = referenceMs - publishedMs;
  return ageMs >= -MAX_FUTURE_SKEW_HOURS * 3_600_000
    && ageMs <= maxAgeHours * 3_600_000;
}

/**
 * Apply one freshness contract before articles reach enrichment, rendering,
 * or the persisted sidecar. Sources marked as live snapshots are current by
 * collection semantics and may omit publication timestamps.
 */
export function filterFreshArticles<T extends RawArticle>(
  articles: T[],
  registry: SourceDef[],
  options: { referenceTime?: Date; maxAgeHours?: number } = {},
): FreshnessResult<T> {
  const referenceTime = options.referenceTime ?? new Date();
  if (!Number.isFinite(referenceTime.getTime())) {
    throw new Error("freshness referenceTime must be a valid date");
  }
  const maxAgeHours = options.maxAgeHours ?? configuredFreshnessHours();
  if (!Number.isInteger(maxAgeHours) || maxAgeHours < 1 || maxAgeHours > 336) {
    throw new Error("freshness maxAgeHours must be an integer between 1 and 336");
  }

  const sourceById = new Map(registry.map((source) => [source.id, source]));
  const fresh: T[] = [];
  let staleArticlesRejected = 0;
  let undatedArticlesRejected = 0;
  let futureArticlesRejected = 0;
  let liveSnapshotArticles = 0;
  let newestPublishedMs = Number.NEGATIVE_INFINITY;

  for (const article of articles) {
    const source = sourceById.get(article.sourceId);
    if (source?.freshnessMode === "live_snapshot") {
      fresh.push(article);
      liveSnapshotArticles += 1;
      continue;
    }

    const publishedMs = article.publishedAt?.getTime();
    if (!Number.isFinite(publishedMs)) {
      undatedArticlesRejected += 1;
      continue;
    }

    const sourceMaxAgeHours = source?.maxAgeHours ?? maxAgeHours;
    const ageMs = referenceTime.getTime() - publishedMs!;
    if (ageMs < -MAX_FUTURE_SKEW_HOURS * 3_600_000) {
      futureArticlesRejected += 1;
      continue;
    }
    if (!isPublishedWithinFreshnessWindow(article.publishedAt!, referenceTime, sourceMaxAgeHours)) {
      staleArticlesRejected += 1;
      continue;
    }

    fresh.push(article);
    newestPublishedMs = Math.max(newestPublishedMs, publishedMs!);
  }

  return {
    articles: fresh,
    stats: {
      freshnessWindowHours: maxAgeHours,
      freshArticles: fresh.length,
      staleArticlesRejected,
      undatedArticlesRejected,
      futureArticlesRejected,
      liveSnapshotArticles,
      newestPublishedAt: Number.isFinite(newestPublishedMs)
        ? new Date(newestPublishedMs).toISOString()
        : undefined,
    },
  };
}
