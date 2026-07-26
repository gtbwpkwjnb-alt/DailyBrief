import { z } from "zod";

const consolidatedItemSchema = z.object({
  url: z.url(),
  displayTitle: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1),
  aiAnalysis: z.string().trim().min(1).optional(),
  tags: z.array(z.string().trim().min(1)).default([]),
  importance: z.number().finite().min(1).max(10).default(5),
  coverageCountries: z.array(z.string().trim().min(1)).max(8).default([]),
  interestMatches: z.array(z.string().trim().min(1)).max(8).default([]),
});

const consolidatedResultSchema = z.object({
  items: z.array(consolidatedItemSchema),
});

export type ConsolidatedValue = {
  displayTitle?: string;
  summary: string;
  aiAnalysis?: string;
  tags: string[];
  importance: number;
  coverageCountries: string[];
  interestMatches: string[];
};

export function parseConsolidatedResult(
  value: unknown,
  requestedUrls: Iterable<string>,
): Map<string, ConsolidatedValue> {
  const requested = new Set(requestedUrls);
  const parsed = consolidatedResultSchema.parse(value);
  const result = new Map<string, ConsolidatedValue>();

  for (const item of parsed.items) {
    if (!requested.has(item.url) || result.has(item.url)) continue;
    result.set(item.url, {
      displayTitle: item.displayTitle,
      summary: item.summary,
      aiAnalysis: item.aiAnalysis,
      tags: item.tags,
      importance: item.importance,
      coverageCountries: item.coverageCountries,
      interestMatches: item.interestMatches,
    });
  }

  return result;
}
