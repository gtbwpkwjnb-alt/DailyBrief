import { z } from "zod";
import type { ArticleInput } from "../ai/pipeline";
import type { FilterProfile, RunStats } from "./render";

const categorySchema = z.enum(["trending", "tech", "finance", "politics"]);
const priorityLevelSchema = z.enum(["P0", "P1", "P2", "P3", "P4"]);
const evidenceStateSchema = z.enum([
  "multi_source_confirmed",
  "single_named_source",
  "developing",
  "unverified",
]);
const sourceRoleSchema = z.enum([
  "primary_report",
  "official_statement",
  "independent_corroboration",
  "analysis",
  "community_signal",
  "reprint",
]);
const sourceFamilyBasisSchema = z.enum([
  "wire",
  "reprint",
  "shared_primary",
  "independent_report",
  "official_statement",
  "community_origin",
  "unknown",
]);

const sourceRefSchema = z.object({
  sourceId: z.string().min(1),
  publisher: z.string().min(1),
  canonicalUrl: z.url(),
  originalTitle: z.string().min(1),
  publishedAt: z.string().datetime().nullable().optional(),
  fetchedAt: z.string().datetime().optional(),
  role: sourceRoleSchema,
  originFamilyId: z.string().min(1).optional(),
  familyBasis: sourceFamilyBasisSchema.optional(),
  assignmentConfidence: z.number().min(0).max(1).optional(),
});

const articleSchema = z.object({
  sourceId: z.string().min(1),
  source: z.string().min(1),
  sourceCountry: z.string().optional(),
  coverageCountries: z.array(z.string()).max(8).optional(),
  interestMatches: z.array(z.string()).max(8).optional(),
  title: z.string().min(1),
  url: z.string().min(1),
  category: categorySchema,
  excerpt: z.string().optional(),
  publishedAt: z.string().datetime().optional(),
  summary: z.string().optional(),
  aiAnalysis: z.string().optional(),
  cnSummary: z.string().optional(),
  displayTitle: z.string().optional(),
  importance: z.number().min(1).max(10).optional(),
  meta: z.string().optional(),
  tags: z.array(z.string()).optional(),
  itemId: z.string().min(1).optional(),
  storyId: z.string().min(1).optional(),
  stableOrder: z.number().int().positive().optional(),
  subcategory: z.string().min(1).optional(),
  summaryShort: z.string().min(1).optional(),
  summaryExpanded: z.string().min(1).optional(),
  uncertainties: z.array(z.string().min(1)).max(8).optional(),
  primarySourceRefId: z.string().min(1).optional(),
  priorityLevel: priorityLevelSchema.optional(),
  reasonCodes: z.array(z.string().min(1)).max(8).optional(),
  evidenceState: evidenceStateSchema.optional(),
  evidenceNote: z.string().min(1).optional(),
  sourceRefs: z.array(sourceRefSchema).min(1).optional(),
  revision: z.number().int().nonnegative().optional(),
});

const failedSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  reason: z.string().min(1),
});

const runStatsSchema = z.object({
  fetchedSources: z.number().int().nonnegative(),
  successfulSources: z.number().int().nonnegative(),
  sourceSuccessRate: z.number().min(0).max(1),
  fetchedArticles: z.number().int().nonnegative(),
  dedupedArticles: z.number().int().nonnegative(),
  displayedArticles: z.number().int().nonnegative().optional(),
  personalizedArticles: z.number().int().nonnegative().optional(),
  aiEnrichedArticles: z.number().int().nonnegative().optional(),
  enrichmentVersion: z.number().int().positive().optional(),
  suppressedArticles: z.number().int().nonnegative().optional(),
  sourceFallbackArticles: z.number().int().nonnegative().optional(),
  enrichmentCircuitOpen: z.boolean().optional(),
  enrichmentStopReason: z.enum(["budget", "empty_response"]).optional(),
  freshnessWindowHours: z.number().int().min(1).max(336).optional(),
  freshArticles: z.number().int().nonnegative().optional(),
  staleArticlesRejected: z.number().int().nonnegative().optional(),
  undatedArticlesRejected: z.number().int().nonnegative().optional(),
  futureArticlesRejected: z.number().int().nonnegative().optional(),
  liveSnapshotArticles: z.number().int().nonnegative().optional(),
  newestPublishedAt: z.string().datetime().optional(),
  generatedAt: z.string().datetime(),
  mode: z.enum(["fresh", "reuse"]),
});

const filterProfileSchema = z.object({
  baseRules: z.string().min(1),
  customKeywords: z.array(z.string()).max(8),
  mode: z.enum(["base", "incremental"]),
});

const qualityReviewSchema = z.object({
  passed: z.boolean(),
  summary: z.string(),
  issues: z.array(z.string()),
  suggestions: z.array(z.string()),
});

const sidecarSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  articles: z.array(articleSchema),
  failedSources: z.array(failedSourceSchema).default([]),
  runStats: runStatsSchema.optional(),
  filterProfile: filterProfileSchema.optional(),
  qualityReview: qualityReviewSchema.optional(),
});

export type ReportSidecar = {
  date: string;
  articles: ArticleInput[];
  failedSources: z.infer<typeof failedSourceSchema>[];
  runStats?: RunStats;
  filterProfile?: FilterProfile;
  qualityReview?: z.infer<typeof qualityReviewSchema>;
};

export function parseReportSidecar(value: unknown): ReportSidecar {
  const parsed = sidecarSchema.parse(value);
  return {
    ...parsed,
    articles: parsed.articles.map((article) => {
      const { cnSummary, ...current } = article;
      return {
        ...current,
        summary: current.summary ?? cnSummary,
        publishedAt: current.publishedAt ? new Date(current.publishedAt) : undefined,
        sourceRefs: current.sourceRefs?.map((source) => ({
          ...source,
          publishedAt: source.publishedAt ? new Date(source.publishedAt) : undefined,
          fetchedAt: source.fetchedAt ? new Date(source.fetchedAt) : undefined,
        })),
      };
    }),
  };
}
