import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePublicationGate } from "../lib/ai/pipeline";
import { parseReportSidecar } from "../lib/output/sidecar";

test("publication gate blocks 0 AI enrichment across a source-only two-category fallback", () => {
  const reasons = evaluatePublicationGate({
    aiTargetArticles: 14,
    aiEnrichedArticles: 0,
    aiEnrichedCategories: [],
    requiredCategories: ["tech", "finance"],
    minimumCoverage: 0.7,
    reviewState: "failed",
    blockingScope: "systemic",
  });

  assert.ok(reasons.includes("AI_ENRICHMENT_EMPTY"));
  assert.ok(reasons.includes("AI_ENRICHMENT_COVERAGE"));
  assert.ok(reasons.includes("REQUIRED_AI_CATEGORY_MISSING:tech,finance"));
  assert.ok(reasons.includes("SYSTEMIC_QUALITY_REVIEW"));
});

test("publication gate allows other categories when one category is skipped", () => {
  const reasons = evaluatePublicationGate({
    aiTargetArticles: 10,
    aiEnrichedArticles: 8,
    aiEnrichedCategories: ["tech"],
    requiredCategories: [],
    minimumCoverage: 0.7,
    reviewState: "passed",
    blockingScope: "none",
  });

  assert.deepEqual(reasons, []);
});

test("sidecar retains separate AI, fallback, and final-publication counts", () => {
  const sidecar = parseReportSidecar({
    date: "2026-08-03",
    articles: [],
    runStats: {
      fetchedSources: 60,
      successfulSources: 59,
      sourceSuccessRate: 0.983,
      fetchedArticles: 1256,
      dedupedArticles: 1217,
      aiTargetArticles: 60,
      aiEnrichedArticles: 0,
      sourceFallbackCandidateArticles: 26,
      sourceFallbackSecondaryFilteredArticles: 12,
      sourceFallbackArticles: 14,
      finalPublishedArticles: 14,
      generatedAt: "2026-08-03T07:10:00.000Z",
      mode: "fresh",
    },
  });

  assert.equal(sidecar.runStats?.aiTargetArticles, 60);
  assert.equal(sidecar.runStats?.sourceFallbackCandidateArticles, 26);
  assert.equal(sidecar.runStats?.sourceFallbackSecondaryFilteredArticles, 12);
  assert.equal(sidecar.runStats?.finalPublishedArticles, 14);
});
