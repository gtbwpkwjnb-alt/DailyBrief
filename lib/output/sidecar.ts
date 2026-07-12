import { z } from "zod";
import type { ArticleInput } from "../ai/pipeline";
import type { FilterProfile, RunStats } from "./render";

const categorySchema = z.enum(["trending", "tech", "finance", "politics"]);

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
  displayTitle: z.string().optional(),
  importance: z.number().min(1).max(10).optional(),
  meta: z.string().optional(),
  tags: z.array(z.string()).optional(),
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
  generatedAt: z.string().datetime(),
  mode: z.enum(["fresh", "reuse"]),
});

const filterProfileSchema = z.object({
  baseRules: z.string().min(1),
  customKeywords: z.array(z.string()).max(8),
  mode: z.enum(["base", "incremental"]),
});

const sidecarSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  articles: z.array(articleSchema),
  failedSources: z.array(failedSourceSchema).default([]),
  runStats: runStatsSchema.optional(),
  filterProfile: filterProfileSchema.optional(),
});

export type ReportSidecar = {
  date: string;
  articles: ArticleInput[];
  failedSources: z.infer<typeof failedSourceSchema>[];
  runStats?: RunStats;
  filterProfile?: FilterProfile;
};

export function parseReportSidecar(value: unknown): ReportSidecar {
  const parsed = sidecarSchema.parse(value);
  return {
    ...parsed,
    articles: parsed.articles.map((article) => ({
      ...article,
      publishedAt: article.publishedAt ? new Date(article.publishedAt) : undefined,
    })),
  };
}
