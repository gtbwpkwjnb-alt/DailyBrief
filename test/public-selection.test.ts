import assert from "node:assert/strict";
import test from "node:test";
import { selectPublicArticles } from "../lib/editorial/public-selection";
import type { ArticleInput } from "../lib/ai/pipeline";
import type { SourceDef } from "../lib/sources/types";

const sources: SourceDef[] = [
  { id: "core", name: "Core", type: "rss", url: "https://core.example/rss", category: "tech", tier: "core", priority: 5 },
  { id: "other", name: "Other", type: "rss", url: "https://other.example/rss", category: "tech", priority: 3 },
  { id: "weak", name: "Weak", type: "rss", url: "https://weak.example/rss", category: "tech", priority: 1 },
  { id: "finance", name: "Finance", type: "rss", url: "https://finance.example/rss", category: "finance", priority: 4 },
];

function article(overrides: Partial<ArticleInput> & Pick<ArticleInput, "sourceId" | "title" | "url" | "category">): ArticleInput {
  return {
    source: overrides.sourceId,
    excerpt: "This article contains a concrete product, market, or policy update with named context.",
    publishedAt: new Date("2026-08-02T06:00:00Z"),
    ...overrides,
  };
}

test("public selection filters noise, merges near events, and uses an adaptive budget", () => {
  const result = selectPublicArticles([
    article({ sourceId: "core", title: "Open model release adds local inference support", url: "https://core.example/model", category: "tech", importance: 8 }),
    article({ sourceId: "other", title: "Open model release adds support for local inference", url: "https://other.example/model", category: "tech", importance: 7 }),
    article({ sourceId: "core", title: "Developer tool adds reproducible build cache", url: "https://core.example/cache", category: "tech", importance: 6 }),
    article({ sourceId: "core", title: "Cloud service publishes regional outage report", url: "https://core.example/outage", category: "tech", importance: 5 }),
    article({ sourceId: "other", title: "Daily Discussion", url: "https://other.example/thread", category: "tech", excerpt: "" }),
    article({ sourceId: "weak", title: "Minor platform publishes a routine weekly update", url: "https://weak.example/update", category: "tech", excerpt: "A routine update with no supporting detail.", importance: 1 }),
    article({ sourceId: "finance", title: "Central bank publishes new inflation data", url: "https://finance.example/inflation", category: "finance", importance: 7 }),
  ], sources, { categoryTargets: { tech: 5, finance: 2 }, referenceTime: new Date("2026-08-02T08:00:00Z") });

  assert.deepEqual(result.articles.map((item) => item.url), [
    "https://core.example/model", "https://core.example/cache", "https://finance.example/inflation",
  ]);
  assert.equal(result.stats.lowInformationFiltered, 1);
  assert.equal(result.stats.qualityFiltered, 1);
  assert.equal(result.stats.eventMerged, 1);
  assert.equal(result.stats.byCategory.tech, 2);
  assert.equal(result.stats.byCategory.finance, 1);
  assert.equal(result.stats.selected, 3);
  assert.equal(result.stats.adaptiveTarget, 4);
  assert.equal(result.stats.expansionArticles, 0);
});

test("public selection is deterministic and rejects unavailable sources", () => {
  const candidates = [
    article({ sourceId: "missing", title: "Unavailable source update has enough context", url: "https://missing.example/a", category: "tech" }),
    article({ sourceId: "other", title: "Independent platform ships a concrete update", url: "https://other.example/a", category: "tech" }),
  ];
  const options = { categoryTargets: { tech: 1 }, referenceTime: new Date("2026-08-02T08:00:00Z") };
  const first = selectPublicArticles(candidates, sources, options);
  const second = selectPublicArticles([...candidates].reverse(), sources, options);

  assert.equal(first.stats.unavailableSourceFiltered, 1);
  assert.deepEqual(first.articles.map((item) => item.url), ["https://other.example/a"]);
  assert.deepEqual(second.articles.map((item) => item.url), first.articles.map((item) => item.url));
});

test("high-value density expands a section while low-value supply never fills it", () => {
  const highValue = Array.from({ length: 8 }, (_, index) => article({
    sourceId: index % 2 === 0 ? "core" : "other",
    title: `Distinct verified AI deployment initiative${index}`,
    url: `https://example.com/high-${index}`,
    category: "tech",
    importance: 9,
    evidenceState: "multi_source_confirmed",
  }));
  const result = selectPublicArticles(highValue, sources, {
    categoryTargets: { tech: 10 }, referenceTime: new Date("2026-08-02T08:00:00Z"),
  });

  // sqrt(8) * 2 gives a base budget of 6; high-value density authorizes two more.
  assert.equal(result.stats.adaptiveByCategory.tech, 8);
  assert.equal(result.stats.expansionArticles, 2);
  assert.deepEqual(result.stats.expansionReasons, [{ category: "tech", count: 2, reason: "high_value_density" }]);
  // The dynamic cap is four for an eight-item reading budget, so neither of
  // the two sources can dominate the result alone.
  assert.equal(result.articles.length, 8);
  assert.equal(result.stats.selected, 8);
});
