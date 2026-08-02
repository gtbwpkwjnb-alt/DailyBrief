import assert from "node:assert/strict";
import test from "node:test";
import { parseConsolidatedResult } from "../lib/ai/consolidated-validation";
import { aiReview, consolidatedEnrich, createEnrichmentControl, hasUnsupportedHighRiskClaim, isLowInformationHotSearch, looksLikeGarbledAiText, planEnrichmentBatches, resolveReviewBlockingItems } from "../lib/ai/enrich";
import { buildDailyReportFromEnriched, canPublishLimitedCircuitEdition, createReviewUnavailableFallback, createReviewUnavailableFallbackArticles, hasHighRiskReviewContent, selectRoundRobin } from "../lib/ai/pipeline";
import { parseReportSidecar } from "../lib/output/sidecar";
import { filterRawArticles, groupRaw, safeExternalUrl, selectPersonalizedArticles, visibleArticlesFromRaw } from "../lib/output/render";
import { sourceRegistrySchema } from "../lib/sources/schema";
import { parseFreshRssItems, parseMinifluxEntries } from "../lib/sources/reader";
import { parseGoogleTrendsXml } from "../lib/sources/google-trends";
import { configuredFreshnessHours, filterFreshArticles } from "../lib/sources/freshness";
import { detectCoverageCountries, normalizeCustomKeywords, preserveTrendQuery } from "../lib/editorial/context";
import { sources } from "../lib/sources/registry";

test("safeExternalUrl only permits HTTP(S) links", () => {
  assert.equal(safeExternalUrl("https://example.com/news"), "https://example.com/news");
  assert.equal(safeExternalUrl("http://example.com"), "http://example.com/");
  assert.equal(safeExternalUrl("javascript:alert(1)"), null);
  assert.equal(safeExternalUrl("data:text/html,test"), null);
});

test("personalized selection adds eligible keyword matches without changing public selection", () => {
  const registry = sources.filter((source) => source.id === "github-trending");
  const candidates = Array.from({ length: 16 }, (_, index) => ({
    sourceId: "github-trending",
    source: "GitHub Trending",
    title: index === 15 ? "Special robotics project" : `General project ${index}`,
    url: `https://example.com/project-${index}`,
    category: "tech" as const,
    excerpt: "A concrete software project update with implementation details and a documented release.",
    publishedAt: new Date(Date.UTC(2026, 7, 2, 0, 16 - index)),
  }));
  const publicSelection = { referenceTime: new Date("2026-08-02T08:00:00Z") };
  const publicWithoutKeywords = groupRaw(candidates, registry, { publicSelection });
  const publicWithKeywords = groupRaw(candidates, registry, { customKeywords: ["robotics"], publicSelection });
  assert.deepEqual(
    visibleArticlesFromRaw(publicWithKeywords).map((article) => article.url),
    visibleArticlesFromRaw(publicWithoutKeywords).map((article) => article.url),
  );
  const personalized = selectPersonalizedArticles(candidates, publicWithoutKeywords, ["robotics"]);
  assert.equal(personalized.length, 1);
  assert.equal(personalized[0]?.title, "Special robotics project");
  assert.deepEqual(personalized[0]?.interestMatches, ["robotics"]);
  assert.equal(visibleArticlesFromRaw(publicWithoutKeywords).some((article) => article.url === personalized[0]?.url), false);
});

test("garbled AI summaries are detected without rejecting normal bilingual terms", () => {
  assert.equal(looksLikeGarbledAiText("泽连斯基就地区安全议题发表声明，相关讨论仍在持续。"), false);
  assert.equal(looksLikeGarbledAiText("????????????????????"), true);
  assert.equal(looksLikeGarbledAiText("The source returned an untranslated English summary that should be Chinese for this edition."), true);
  assert.equal(looksLikeGarbledAiText("使用 Transformer 和 RLHF 方法进行训练。"), false);
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
    aiAnalysis: undefined,
    tags: [],
    importance: 5,
    coverageCountries: [],
    interestMatches: [],
  });
  assert.equal(result.has("https://example.com/other"), false);
});

test("consolidated result preserves the translated display title", () => {
  const result = parseConsolidatedResult({
    items: [{
      url: "https://example.com/a",
      displayTitle: "中文标题",
      summary: "中文摘要",
      aiAnalysis: "这项变化可能降低用户的迁移成本，但长期影响仍取决于后续采用率。",
    }],
  }, ["https://example.com/a"]);
  assert.equal(result.get("https://example.com/a")?.displayTitle, "中文标题");
  assert.equal(
    result.get("https://example.com/a")?.aiAnalysis,
    "这项变化可能降低用户的迁移成本，但长期影响仍取决于后续采用率。",
  );
});

test("one consolidated AI call returns both the displayed summary and AI analysis", async () => {
  const calls: Array<{ userPrompt: string }> = [];
  const result = await consolidatedEnrich("技术动态", [{
    url: "https://example.com/visible",
    title: "Visible article",
    excerpt: "The source describes a concrete product update.",
  }], {
    run: async (request) => {
      calls.push({ userPrompt: request.userPrompt });
      return {
        durationMs: 1,
        text: JSON.stringify({
          items: [{
            url: "https://example.com/visible",
            displayTitle: "产品更新带来新能力",
            summary: "该产品公布了已在原文说明的新功能更新。",
            aiAnalysis: "这可能降低目标用户的使用门槛，但实际价值仍取决于后续采用和稳定性。",
            tags: ["科技", "产品"],
            importance: 5,
            coverageCountries: [],
            interestMatches: [],
          }],
        }),
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.userPrompt, /"summary"/);
  assert.match(calls[0]!.userPrompt, /"aiAnalysis"/);
  assert.equal(result.get("https://example.com/visible")?.summary, "该产品公布了已在原文说明的新功能更新。");
  assert.equal(result.get("https://example.com/visible")?.aiAnalysis, "这可能降低目标用户的使用门槛，但实际价值仍取决于后续采用和稳定性。");
});

test("AI enrichment batches adapt to item count and prompt size", () => {
  const items = Array.from({ length: 7 }, (_, index) => ({
    url: `https://example.com/batch-${index}`,
    title: `Batch item ${index}`,
    excerpt: index === 3 ? "x".repeat(250) : "short context",
  }));
  assert.deepEqual(planEnrichmentBatches(items, { maxItems: 4, maxChars: 10_000 }).map((batch) => batch.length), [4, 3]);
  assert.deepEqual(planEnrichmentBatches(items, { maxItems: 12, maxChars: 500 }).map((batch) => batch.length), [3, 1, 3]);
});

function consolidatedItem(url: string) {
  return {
    url,
    displayTitle: `精炼标题 ${url}`,
    summary: "原文提供了明确背景、事件进展和可核验的具体信息。",
    aiAnalysis: "这一变化可能影响相关产品的采用路径，后续仍需结合实际数据判断。",
    tags: ["技术"],
    importance: 5,
    coverageCountries: [],
    interestMatches: [],
  };
}

test("consolidated enrichment retries only missing URLs", async () => {
  const urls = ["https://example.com/a", "https://example.com/b"];
  const prompts: string[] = [];
  const result = await consolidatedEnrich("技术动态", urls.map((url) => ({
    url,
    title: `Article ${url}`,
    excerpt: "A concrete product update with enough source context for verification.",
  })), {
    run: async (request) => {
      prompts.push(request.userPrompt);
      const returned = prompts.length === 1 ? [urls[0]!] : [urls[1]!];
      return { durationMs: 1, text: JSON.stringify({ items: returned.map(consolidatedItem) }) };
    },
  });

  assert.equal(result.size, 2);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /https:\/\/example\.com\/b/);
  assert.doesNotMatch(prompts[1]!, /https:\/\/example\.com\/a/);
});

test("consolidated enrichment opens a shared circuit after three empty responses", async () => {
  const control = createEnrichmentControl({ budgetMs: 60_000, emptyFailureThreshold: 3 });
  let calls = 0;
  const run = async () => {
    calls++;
    return { durationMs: 1, text: calls % 2 === 0 ? '{"items":[' : "" };
  };
  const first = await consolidatedEnrich("技术动态", [{
    url: "https://example.com/failing",
    title: "Failing item",
    excerpt: "A sufficiently detailed source excerpt that should be safe to process.",
  }], { control, run });
  const second = await consolidatedEnrich("财经要点", [{
    url: "https://example.com/never-started",
    title: "Never started",
    excerpt: "Another sufficiently detailed excerpt that must not start after the circuit opens.",
  }], { control, run });

  assert.equal(first.size, 0);
  assert.equal(second.size, 0);
  assert.equal(calls, 3);
  assert.equal(control.circuitOpen, true);
  assert.equal(control.reason, "empty_response");
  assert.equal(control.attemptsByUrl.get("https://example.com/failing"), 3);
  assert.equal(control.attemptsByUrl.has("https://example.com/never-started"), false);
});

test("consolidated enrichment shares its deadline and shortens call timeout", async () => {
  let clock = 1_000;
  const control = createEnrichmentControl({ budgetMs: 12_345, perCallTimeoutMs: 60_000, now: () => clock });
  const timeouts: Array<number | undefined> = [];
  const result = await consolidatedEnrich("技术动态", [{
    url: "https://example.com/deadline",
    title: "Deadline item",
    excerpt: "The source includes enough concrete context to produce an enrichment.",
  }], {
    control,
    run: async (request) => {
      timeouts.push(request.timeoutMs);
      clock = control.deadlineAt;
      return { durationMs: 1, text: JSON.stringify({ items: [consolidatedItem("https://example.com/deadline")] }) };
    },
  });
  const afterDeadline = await consolidatedEnrich("财经要点", [{
    url: "https://example.com/after-deadline",
    title: "After deadline",
    excerpt: "This request should never be sent because the shared budget is exhausted.",
  }], { control, run: async () => { throw new Error("must not run"); } });

  assert.equal(result.size, 1);
  assert.deepEqual(timeouts, [12_345]);
  assert.equal(afterDeadline.size, 0);
  assert.equal(control.reason, "budget");
});

test("a valid response resets consecutive empty-response failures", async () => {
  const control = createEnrichmentControl({ budgetMs: 60_000, emptyFailureThreshold: 3 });
  const responses = [
    "",
    JSON.stringify({ items: [consolidatedItem("https://example.com/reset-a")] }),
    "",
    '{"items":',
    JSON.stringify({ items: [consolidatedItem("https://example.com/reset-b")] }),
  ];
  let calls = 0;
  const run = async () => ({ durationMs: 1, text: responses[calls++] ?? "" });
  const first = await consolidatedEnrich("技术动态", [{
    url: "https://example.com/reset-a",
    title: "Reset A",
    excerpt: "A detailed source excerpt for the first reset test item.",
  }], { control, run });
  const second = await consolidatedEnrich("财经要点", [{
    url: "https://example.com/reset-b",
    title: "Reset B",
    excerpt: "A detailed source excerpt for the second reset test item.",
  }], { control, run });

  assert.equal(first.size, 1);
  assert.equal(second.size, 1);
  assert.equal(calls, 5);
  assert.equal(control.consecutiveEmptyFailures, 0);
  assert.equal(control.circuitOpen, false);
});

test("final web set never backfills an article that was outside the AI target set", () => {
  const sourceIds = ["github-trending", "qbitai", "openai-news"];
  const topics = ["compiler", "database", "robotics", "browser", "security", "storage", "network", "runtime", "kernel", "graphics", "testing", "observability", "payments", "search", "messaging"];
  const candidates = Array.from({ length: 15 }, (_, index) => ({
    sourceId: sourceIds[index % sourceIds.length]!,
    source: sourceIds[index % sourceIds.length]!,
    title: `${topics[index]} engineering release ${index + 1}`,
    url: `https://example.com/project-${index + 1}`,
    category: "tech" as const,
    excerpt: `Project ${index + 1} publishes a concrete engineering release with implementation details.`,
    publishedAt: new Date("2026-08-02T06:00:00Z"),
    importance: 2,
  }));
  const initiallyVisible = groupRaw(candidates, sources, {
    publicSelection: {
      categoryTargets: { tech: 4 },
      referenceTime: new Date("2026-08-02T08:00:00Z"),
    },
  });
  const aiTargets = visibleArticlesFromRaw(initiallyVisible);
  assert.equal(aiTargets.length, 4);
  const outsideTarget = candidates.find((article) => !aiTargets.includes(article));
  assert.ok(outsideTarget);

  const finalRaw = filterRawArticles(initiallyVisible, (article) => article !== aiTargets[0]);
  const finalVisible = visibleArticlesFromRaw(finalRaw);
  assert.equal(finalVisible.length, 3);
  assert.equal(finalVisible.every((article) => aiTargets.includes(article)), true);
  assert.equal(finalVisible.some((article) => article.url === outsideTarget.url), false);
});

test("digest metadata is derived only from the enriched web-visible articles", () => {
  const displayed = [{
    sourceId: "github-trending",
    source: "GitHub Trending",
    title: "Visible source title",
    displayTitle: "前端展示标题",
    url: "https://example.com/visible",
    category: "tech" as const,
    summary: "这是已经在前端显示的精炼摘要。",
    aiAnalysis: "该变化可能影响开发者采用路径，但仍需观察实际使用数据。",
    importance: 8,
    tags: ["科技", "开发工具"],
  }];
  const report = buildDailyReportFromEnriched(displayed);

  assert.equal(report.hero_headline, "前端展示标题");
  assert.equal(report.tech_briefs[0]?.url, "https://example.com/visible");
  assert.match(report.daily_overview, /前端显示的精炼摘要/);
  assert.deepEqual(report.keywords, ["开发工具", "科技"]);
});

test("Google Trends XML uses related reporting as context and the concrete source URL", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <rss xmlns:ht="https://trends.google.com/trending/rss"><channel><item>
      <title>kyle tucker</title>
      <link>https://trends.google.com/trending/rss?geo=US</link>
      <pubDate>Fri, 24 Jul 2026 12:00:00 GMT</pubDate>
      <ht:approx_traffic>200K+</ht:approx_traffic>
      <ht:news_item>
        <ht:news_item_title>Cubs complete trade involving Kyle Tucker</ht:news_item_title>
        <ht:news_item_url>https://sports.example.com/kyle-tucker-trade</ht:news_item_url>
        <ht:news_item_source>Example Sports</ht:news_item_source>
      </ht:news_item>
      <ht:news_item>
        <ht:news_item_title>What the move means for the playoff race</ht:news_item_title>
        <ht:news_item_url>https://analysis.example.com/playoff-race</ht:news_item_url>
        <ht:news_item_source>Analysis Desk</ht:news_item_source>
      </ht:news_item>
    </item></channel></rss>`;

  const articles = parseGoogleTrendsXml(
    "google-trends-us",
    "https://trends.google.com/trending/rss?geo=US",
    xml,
  );

  assert.equal(articles.length, 1);
  assert.equal(articles[0]?.title, "kyle tucker");
  assert.equal(articles[0]?.url, "https://sports.example.com/kyle-tucker-trade");
  assert.match(articles[0]?.excerpt ?? "", /搜索量约 200K\+/);
  assert.match(articles[0]?.excerpt ?? "", /Cubs complete trade involving Kyle Tucker（Example Sports）/);
  assert.match(articles[0]?.excerpt ?? "", /What the move means for the playoff race（Analysis Desk）/);
  assert.equal(articles[0]?.publishedAt?.toISOString(), "2026-07-24T12:00:00.000Z");
});

test("low-information hot-search enrichment is rejected while evidence-based context passes", () => {
  const item = {
    sourceId: "google-trends-us",
    title: "kyle tucker",
    url: "https://sports.example.com/kyle-tucker-trade",
    excerpt: "搜索量约 200K+；关联报道：Cubs complete trade involving Kyle Tucker（Example Sports）",
  };
  const base = {
    displayTitle: "凯尔·塔克交易引发关注",
    aiAnalysis: "这笔交易可能改变球队季后赛竞争力，并影响同位置球员的后续市场估值。",
    tags: ["棒球"],
    importance: 5,
    coverageCountries: ["美国"],
    interestMatches: [],
  };

  assert.equal(isLowInformationHotSearch(item, {
    ...base,
    summary: "凯尔·塔克成为美国谷歌热搜话题，搜索热度上升。",
  }), true);
  assert.equal(isLowInformationHotSearch(item, {
    ...base,
    summary: "搜索词指向棒球运动员凯尔·塔克，因球队交易报道集中发布而在美国搜索热度上升。",
  }), false);
  assert.equal(isLowInformationHotSearch({ ...item, excerpt: "搜索量 200K+" }, {
    ...base,
    summary: "搜索词指向棒球运动员凯尔·塔克，因球队交易报道集中发布而在美国搜索热度上升。",
  }), true);
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
      cnSummary: "旧版中文摘要",
      aiAnalysis: "该变化可能扩大产品覆盖，但仍需观察实际采用率。",
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
    qualityReview: {
      passed: true,
      summary: "Quality gates passed.",
      issues: [],
      suggestions: ["Keep monitoring source diversity."],
    },
    runStats: {
      fetchedSources: 1,
      successfulSources: 1,
      sourceSuccessRate: 1,
      fetchedArticles: 3,
      dedupedArticles: 2,
      freshArticles: 1,
      publicSelectionEligible: 1,
      publicSelectionLowInformationFiltered: 1,
      publicSelectionQualityFiltered: 0,
      publicSelectionEventMerged: 0,
      publicSelectionAdaptiveTarget: 1,
      publicSelectionExpansionArticles: 0,
      displayedArticles: 1,
      aiEnrichedArticles: 1,
      enrichmentVersion: 2,
      generatedAt: "2026-07-10T08:00:00.000Z",
      mode: "fresh",
    },
  });
  assert.ok(sidecar.articles[0].publishedAt instanceof Date);
  assert.equal(sidecar.articles[0].sourceRefs?.[0]?.publishedAt, undefined);
  assert.ok(sidecar.articles[0].sourceRefs?.[0]?.fetchedAt instanceof Date);
  assert.equal(sidecar.articles[0].priorityLevel, "P1");
  assert.equal(sidecar.articles[0].summary, "旧版中文摘要");
  assert.equal(sidecar.articles[0].aiAnalysis, "该变化可能扩大产品覆盖，但仍需观察实际采用率。");
  assert.equal(sidecar.qualityReview?.passed, true);
  assert.equal(sidecar.qualityReview?.summary, "Quality gates passed.");
  assert.equal(sidecar.runStats?.displayedArticles, 1);
  assert.equal(sidecar.runStats?.publicSelectionEligible, 1);
  assert.equal(sidecar.runStats?.publicSelectionLowInformationFiltered, 1);
  assert.equal(sidecar.runStats?.publicSelectionAdaptiveTarget, 1);
  assert.equal(sidecar.runStats?.aiEnrichedArticles, 1);
  assert.equal(sidecar.runStats?.enrichmentVersion, 2);
  assert.throws(() => parseReportSidecar({ date: "invalid", articles: [] }));
});

test("editorial context separates publisher country from covered countries", () => {
  assert.deepEqual(detectCoverageCountries("US and Iran discuss a new regional agreement"), ["美国", "伊朗"]);
  assert.deepEqual(normalizeCustomKeywords(" AI Agent,伊朗,AI Agent,这是一个很长的关键词超过限制 "), ["AI Agent", "伊朗", "这是一个很长的关键词超过限制"]);
  assert.equal(normalizeCustomKeywords("a,b,c,d,e,f,g,h,i").length, 8);
});

test("Google Trends summaries retain the exact original search query", () => {
  assert.equal(
    preserveTrendQuery("google-trends-us", "jordan rodgers", "该词条在美国谷歌热搜中成为热门搜索词。"),
    "搜索词「jordan rodgers」在美国谷歌热搜中成为热门搜索词。",
  );
  assert.equal(
    preserveTrendQuery("google-trends-jp", "tシャツが乾くまで", "tシャツが乾くまで在日本搜索热度上升。"),
    "tシャツが乾くまで在日本搜索热度上升。",
  );
  assert.equal(preserveTrendQuery("github-trending", "project", "项目热度上升。"), "项目热度上升。");
  assert.equal(
    preserveTrendQuery("google-trends-gb", "m5 traffic", undefined),
    "搜索词「m5 traffic」：当前仅确认搜索热度，具体原因待核验。",
  );
  assert.equal(
    preserveTrendQuery("google-trends-us", "AI", "Thailand travel searches increased."),
    "搜索词「AI」：Thailand travel searches increased.",
  );
  assert.equal(
    preserveTrendQuery("google-trends-us", "AI", undefined, "en"),
    "Original search query \"AI\": Only the search-interest signal is confirmed; the reason remains unverified.",
  );
  assert.equal(
    preserveTrendQuery("weibo-hot-search", "[新] 歌手排名", "该词条在微博成为新热搜。"),
    "搜索词「歌手排名」在微博成为新热搜。",
  );
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

test("structured item-level review blockers can be resolved to exact reviewed URLs", async () => {
  const result = await aiReview("test", async () => ({
    text: JSON.stringify({
      passed: false,
      summary: "One unsupported claim must be removed.",
      issues: ["The named person is unsupported by the source excerpt."],
      suggestions: [],
      blockingScope: "items",
      blockingItems: [{
        url: "https://example.com/unsafe",
        category: "finance",
        reason: "The named person is unsupported by the source excerpt.",
      }],
    }),
  }) as never);

  assert.equal(result.reviewState, "failed");
  assert.equal(result.blockingScope, "items");
  const resolution = resolveReviewBlockingItems(result, [
    { url: "https://example.com/safe", category: "finance" },
    { url: "https://example.com/unsafe", category: "finance" },
  ]);
  assert.equal(resolution.recoverable, true);
  assert.deepEqual(resolution.urls, ["https://example.com/unsafe"]);
  assert.deepEqual(resolution.unresolved, []);

  const localizedCategory = resolveReviewBlockingItems({
    ...result,
    blockingItems: [{
      url: "https://example.com/unsafe",
      category: "财经要点",
      reason: "The named person is unsupported by the source excerpt.",
    }],
  }, [{ url: "https://example.com/unsafe", category: "finance" }]);
  assert.equal(localizedCategory.recoverable, true);
});

test("unstructured, systemic, and unknown review blockers remain publication-fatal", async () => {
  const unstructured = await aiReview("test", async () => ({
    text: JSON.stringify({
      passed: false,
      summary: "A blocker was found but could not be located.",
      issues: ["Unsupported claim"],
      suggestions: [],
    }),
  }) as never);
  assert.equal(unstructured.blockingScope, "systemic");
  assert.equal(resolveReviewBlockingItems(unstructured, [{ url: "https://example.com/item" }]).recoverable, false);

  const unknownItem = {
    ...unstructured,
    blockingScope: "items" as const,
    blockingItems: [{ url: "https://example.com/not-reviewed", reason: "Unsupported claim" }],
  };
  const resolution = resolveReviewBlockingItems(unknownItem, [{ url: "https://example.com/item" }]);
  assert.equal(resolution.recoverable, false);
  assert.equal(resolution.reason, "unresolved_items");
  assert.equal(resolution.unresolved.length, 1);
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
  assert.match(safeArticles[0]!.aiAnalysis ?? "", /AI 分析暂不可用|AI analysis is unavailable/i);
  assert.equal(hasHighRiskReviewContent({ ...lowRisk, title: "Official says minister resigned" }), true);
});

test("limited circuit publication permits safe mixed output but never bypasses factual-risk failures", () => {
  assert.equal(canPublishLimitedCircuitEdition({
    enrichmentStopReason: "empty_response",
    sourceFallbackArticles: 100,
    hasHighRiskContent: false,
    hasDisallowedReviewRisk: false,
  }), true);
  assert.equal(canPublishLimitedCircuitEdition({
    enrichmentStopReason: "empty_response",
    sourceFallbackArticles: 99,
    hasHighRiskContent: false,
    hasDisallowedReviewRisk: false,
  }), true);
  assert.equal(canPublishLimitedCircuitEdition({
    enrichmentStopReason: "budget",
    sourceFallbackArticles: 100,
    hasHighRiskContent: true,
    hasDisallowedReviewRisk: false,
  }), false);
  assert.equal(canPublishLimitedCircuitEdition({
    sourceFallbackArticles: 100,
    hasHighRiskContent: false,
    hasDisallowedReviewRisk: false,
  }), false);
  assert.equal(canPublishLimitedCircuitEdition({
    enrichmentStopReason: "empty_response",
    sourceFallbackArticles: 100,
    hasHighRiskContent: false,
    hasDisallowedReviewRisk: true,
  }), false);
});
