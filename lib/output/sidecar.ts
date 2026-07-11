import { z } from "zod";
import type { ArticleInput } from "../ai/pipeline";

const categorySchema = z.enum(["trending", "tech", "finance", "politics"]);

const articleSchema = z.object({
  sourceId: z.string().min(1),
  source: z.string().min(1),
  title: z.string().min(1),
  url: z.string().min(1),
  category: categorySchema,
  excerpt: z.string().optional(),
  publishedAt: z.string().datetime().optional(),
  summary: z.string().optional(),
  meta: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const failedSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  reason: z.string().min(1),
});

const sidecarSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  articles: z.array(articleSchema),
  failedSources: z.array(failedSourceSchema).default([]),
});

export type ReportSidecar = {
  date: string;
  articles: ArticleInput[];
  failedSources: z.infer<typeof failedSourceSchema>[];
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
