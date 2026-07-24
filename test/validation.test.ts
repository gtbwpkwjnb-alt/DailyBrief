import assert from "node:assert/strict";
import test from "node:test";
import { parseConsolidatedResult } from "../lib/ai/consolidated-validation";
import { aiReview, hasUnsupportedHighRiskClaim } from "../lib/ai/enrich";
import { createReviewUnavailableFallback, createReviewUnavailableFallbackArticles, hasHighRiskReviewContent, selectRoundRobin } from "../lib/ai/pipeline";
import { parseReportSidecar } from "../lib/output/sidecar";
import { safeExternalUrl } from "../lib/output/render";
import { sourceRegistrySchema } from "../lib/sources/schema";
import { parseFreshRssItems, parseMinifluxEntries } from "../lib/sources/reader";
import { configuredFreshnessHours, filterFreshArticles } from "../lib/sources/freshness";
import { detectCoverageCountries, normalizeCustomKeywords } from "../lib/editorial/context";

test("safeExternalUrl only permits HTTP(S) links", () => {
  assert.equal(safeExternalUrl("https://example.com/news"), "https://example.com/news");
  assert.equal(safeExternalUrl("http://example.com"), "http://example.com/");
  assert.equal(safeExternalUrl("javascript:alert(1)"), null);
  assert.equal(safeExternalUrl("data:text/html,test"), null);
});

test("source registry rejects unsafe URLs and duplicate IDs", () => {
  const source = {
    id: "example",
    name: "Example",
    type: "rss",
    url: "https://example.com/feed.xml",
    category: "tech",
    locales: ["zh", "en"],
  };
  assert.equal(sourceRegistrySchema.safeParse([source]).success, true);
  assert.equal(sourceRegistrySchema.safeParse([{ ...source, url: "file:///etc/passwd" }]).success, false);
  assert.equal(sourceRegistrySchema.safeParse([source, source]).success, false);
  assert.equal(sourceRegistrySchema.safeParse([{ ...source, type: "reader" }]).success, false);
  assert.equal(sourceRegistrySchema.safeParse([{ ...source, type: "reader", provider: "freshrss" }]).success, true);
  assert.equal(sourceRegistrySchema.safeParse([{ ...source, category: "politics" }]).success, false);
  assert.equal(sourceRegistrySchema.safeParse([{ ...source, category: "politics", originCountry: "美国" }]).success, true);
  assert.equal(sourceRegistrySchema.safeParse([{ ...source, freshnessMode: "live_snapshot" }]).success, true);
  assert.equal(sourceRegistrySchema.safeParse([{ ...source, maxAgeHours: 0 }]).success, false);
});

test("freshness policy rejects stale, undated, and far-future articles", () => {
  const registry = [
    { id: "dated", name: "Dated", type: "rss" as const, url: "https://example.com/rss", category: "tech" as const },
    { id: "live", name: "Live", type: "scrape" as const, url: "https://example.com/live", category: "tech" as const, freshnessMode: "live_snapshot" as const },
  ];
  const result = filterFreshArticles([
    { sourceId: "dated", title: "Recent", url: "https://example.com/recent", category: "tech" as const, publishedAt: new Date("2026-07-23T08:00:00Z") },
    { sourceId: "dated", title: "Stale", url: "https://example.com/stale", category: "tech" as const, publishedAt: new Date("2026-07-19T00:00:00Z") },
    { sourceId: "dated", title: "Undated", url: "https://example.com/undated", category: "tech" as const },
    { sourceId: "dated", title: "Future", url: "https://example.com/future", category: "tech" as const, publishedAt: new Date("2026-07-25T12:00:00Z") },
    { sourceId: "live", title: "Live ranking", url: "https://example.com/ranking", category: "tech" as const },
  ], registry, {
    referenceTime: new Date("2026-07-24T08:00:00Z"),
    maxAgeHours: 72,
  });

  assert.deepEqual(result.articles.map((article) => article.title), ["Recent", "Live ranking"]);
  assert.equal(result.stats.freshArticles, 2);
  assert.equal(result.stats.staleArticlesRejected, 1);
  assert.equal(result.stats.undatedArticlesRejected, 1);
  assert.equal(result.stats.futureArticlesRejected, 1);
  assert.equal(result.stats.liveSnapshotArticles, 1);
  assert.equal(result.stats.newestPublishedAt, "2026-07-23T08:00:00.000Z");
  assert.equal(configuredFreshnessHours("48"), 48);
  assert.throws(() => configuredFreshnessHours("72hours"));
});

test("reader providers normalize their documented response shapes", () => {
  const source = {
    id: "reader-tech", name: "Reader", type: "reader" as const, provider: "freshrss" as const,
    url: "https://freshrss.org", category: "tech" as const,
  };
  const fresh = parseFreshRssItems(source, [{
    title: " Fresh item ", alternate: [{ href: "https://example.com/fresh" }],
    summary: { content: "<p>Fresh <b>summary</b></p>" }, published: 1_700_000_000,
  }]);
  const miniflux = parseMinifluxEntries(source, [{
    title: "Miniflux item", url: "https://example.com/miniflux", content: "<p>Entry</p>", published_at: "2026-07-10T00:00:00Z",
  }]);
  assert.deepEqual(fresh[0], { sourceId: "reader-tech", title: "Fresh item", url: "https://example.com/fresh", excerpt: "Fresh summary", publishedAt: new Date(1_700_000_000_000), category: "tech" });
  assert.equal(miniflux[0]?.excerpt, "Entry");
  assert.ok(miniflux[0]?.publishedAt instanceof Date);
});

test("consolidated result ignores unrequested URLs and applies defaults", () => {
  const result = parseConsolidatedResult({
    items: [
      { url: "https://example.com/a", summary: "summary" },
      { url: "https://example.com/other", summary: "ignore" },
    ],
  }, ["https://example.com/a"]);
  assert.deepEqual(result.get("https://example.com/a"), {
    displayTitle: undefined,
    summary: "summary",
    tags: [],
    importance: 5,
    coverageCountries: [],
    interestMatches: [],
  });
  assert.equal(result.has("https://example.com/other"), false);
});

test("consolidated result preserves the translated display title", () => {
  const result = parseConsolidatedResult({
    items: [{ url: "https://example.com/a", displayTitle: "中文标题", summary: "中文摘要" }],
  }, ["https://example.com/a"]);
  assert.equal(result.get("https://example.com/a")?.displayTitle, "中文标题");
});

test("report sidecar validates data and restores publication timestamps", () => {
  const sidecar = parseReportSidecar({
    date: "2026-07-10",
    articles: [{
      sourceId: "example",
      source: "Example",
      title: "Title",
      url: "https://example.com/a",
      category: "tech",
      publishedAt: "2026-07-10T08:00:00.000Z",
      priorityLevel: "P1",
      reasonCodes: ["MULTI_SOURCE_CONFIRMED"],
      evidenceState: "multi_source_confirmed",
      evidenceNote: "Two independent sources agree.",
      sourceRefs: [{
        sourceId: "example",
        publisher: "Example",
        canonicalUrl: "https://example.com/a",
        originalTitle: "Title",
        publishedAt: null,
        fetchedAt: "2026-07-10T08:05:00.000Z",
        role: "primary_report",
        originFamilyId: "example-original",
        familyBasis: "independent_report",
        assignmentConfidence: 0.95,
      }],
      revision: 1,
    }],
  });
  assert.ok(sidecar.articles[0].publishedAt instanceof Date);
  assert.equal(sidecar.articles[0].sourceRefs?.[0]?.publishedAt, undefined);
  assert.ok(sidecar.articles[0].sourceRefs?.[0]?.fetchedAt instanceof Date);
  assert.equal(sidecar.articles[0].priorityLevel, "P1");
  assert.throws(() => parseReportSidecar({ date: "invalid", articles: [] }));
});

test("editorial context separates publisher country from covered countries", () => {
  assert.deepEqual(detectCoverageCountries("US and Iran discuss a new regional agreement"), ["美国", "伊朗"]);
  assert.deepEqual(normalizeCustomKeywords(" AI Agent,伊朗,AI Agent,这是一个很长的关键词超过限制 "), ["AI Agent", "伊朗", "这是一个很长的关键词超过限制"]);
  assert.equal(normalizeCustomKeywords("a,b,c,d,e,f,g,h,i").length, 8);
});

test("digest candidates prioritize explicit interest matches within a source", () => {
  const selected = selectRoundRobin([
    {
      sourceId: "source-a",
      source: "Source A",
      title: "Recent unrelated item",
      url: "https://example.com/recent",
      category: "tech",
      publishedAt: new Date("2026-07-12T08:00:00Z"),
      interestMatches: [],
    },
    {
      sourceId: "source-a",
      source: "Source A",
      title: "Older AI item",
      url: "https://example.com/interest",
      category: "tech",
      publishedAt: new Date("2026-07-11T08:00:00Z"),
      interestMatches: ["AI"],
    },
  ], 1, { referenceTime: new Date("2026-07-12T08:00:00Z"), maxAgeHours: 72 });

  assert.equal(selected[0]?.url, "https://example.com/interest");
});

test("high-risk enrichment claims require evidence in the source excerpt", () => {
  const item = {
    url: "https://example.com/news",
    title: "Senator Lindsey Graham comments on the proposal",
    excerpt: "The senator discussed the proposal in an interview.",
  };
  const fabricated = {
    summary: "林赛·格雷厄姆病逝，相关提案引发关注。",
    tags: [],
    importance: 5,
    coverageCountries: [],
    interestMatches: [],
  };
  const supported = {
    ...fabricated,
    summary: "报道称林赛·格雷厄姆在采访中讨论了这项提案。",
  };

  assert.equal(hasUnsupportedHighRiskClaim(item, fabricated), "死亡/遇害");
  assert.equal(hasUnsupportedHighRiskClaim({ ...item, excerpt: "The senator died after a long illness." }, fabricated), null);
  assert.equal(hasUnsupportedHighRiskClaim(item, supported), null);
});

test("reviewer outage is never reported as a passed review", async () => {
  const result = await aiReview("test", async () => {
    throw new Error("reviewer unavailable");
  });

  assert.equal(result.passed, false);
  assert.equal(result.reviewState, "unavailable");
  assert.equal(result.publicationState, "blocked");
  assert.deepEqual(result.failureCodes, ["AI_REVIEW_UNAVAILABLE"]);
});

test("reviewer outage fallback is source-only and excludes high-risk content", () => {
  const lowRisk = {
    sourceId: "example", source: "Example", title: "Product update released", url: "https://example.com/update",
    excerpt: "The publisher announced a product update.", category: "tech" as const,
    summary: "An AI-written summary that must not be used.",
  };
  const safeArticles = createReviewUnavailableFallbackArticles([lowRisk]);
  const fallback = createReviewUnavailableFallback(safeArticles);

  assert.equal(hasHighRiskReviewContent(lowRisk), false);
  assert.match(fallback.tech_briefs[0]!.summary, /信息有限|source excerpt only/i);
  assert.doesNotMatch(fallback.tech_briefs[0]!.summary, /AI-written summary/);
  assert.equal(safeArticles[0]!.displayTitle, lowRisk.title);
  assert.doesNotMatch(safeArticles[0]!.summary ?? "", /AI-written summary/);
  assert.equal(hasHighRiskReviewContent({ ...lowRisk, title: "Official says minister resigned" }), true);
});
