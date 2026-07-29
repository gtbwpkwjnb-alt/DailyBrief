import { expect, test } from "@playwright/test";
import { groupRaw, renderHtml, selectPersonalizedArticles } from "../lib/output/render";
import { sources } from "../lib/sources/registry";
import type { ArticleInput, DailyReport } from "../lib/ai/pipeline";

const report: DailyReport = {
  hero_headline: "Test headline",
  daily_overview: "Test overview",
  tech_briefs: [],
  finance_briefs: [],
  politics_briefs: [],
  editor_note: "",
  keywords: [],
};

test("report renders a usable tech panel without unsafe links", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const article: ArticleInput = {
    sourceId: "github-trending",
    source: "GitHub Trending",
    title: "Unsafe link is rendered as plain text",
    displayTitle: "安全链接渲染测试",
    url: "javascript:alert(1)",
    category: "tech",
    excerpt: "This original English excerpt should not be displayed.",
    summary: "用于验证中文标题、摘要和安全链接处理。",
    importance: 8,
  };
  const html = renderHtml(report, groupRaw([article], sources), "2026-07-10", []);

  await page.setContent(html);
  await expect(page.locator(".report-title")).toHaveText("2026-07-10");
  await expect(page.locator("a[href^='javascript:']")).toHaveCount(0);
  await expect(page.locator(".article-title")).toContainText(article.displayTitle!);
  await expect(page.locator(".article-excerpt")).toHaveCount(0);
  await expect(page.locator(".article-meta")).toHaveCount(0);
  await expect(page.locator(".article-legacy-score")).toHaveCount(0);
  await expect(page.locator(".article-public-context")).toHaveCount(0);
  await expect(page.locator(".brief-meta-summary")).toBeVisible();
  await expect(page.locator(".brief-meta-summary")).toContainText("1 个来源");
  await expect(page.locator(".brief-meta-summary")).not.toContainText("0 个来源");
  await page.locator(".brief-meta-summary").click();
  await expect(page.locator("#runDailyButton")).toHaveCount(0);
  await expect(page.locator("#filterConsole")).toHaveCount(0);
  await expect(page.locator(".failed-sources")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  expect((await page.screenshot()).byteLength).toBeGreaterThan(1_000);
});

test("public review output exposes target evidence fields without operator controls", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const article: ArticleInput = {
    sourceId: "bbc-world",
    source: "BBC World",
    title: "Public contract review fixture",
    displayTitle: "目标公开契约评审样本",
    url: "https://example.com/review/primary",
    category: "politics",
    summary: "这是一条用于验证公开优先级、证据状态、入选原因和多来源列表的评审样本。",
    itemId: "review-item",
    storyId: "review-story",
    stableOrder: 1,
    priorityLevel: "P1",
    reasonCodes: ["HIGH_PUBLIC_IMPACT", "MULTI_SOURCE_CONFIRMED"],
    evidenceState: "multi_source_confirmed",
    evidenceNote: "两个独立来源对核心事实描述一致。",
    uncertainties: ["实施细节仍待正式文件确认"],
    sourceRefs: [
      {
        sourceId: "bbc-world",
        publisher: "BBC World",
        canonicalUrl: "https://example.com/review/primary",
        originalTitle: "Primary report",
        fetchedAt: new Date("2026-07-23T06:10:00.000Z"),
        role: "primary_report",
        originFamilyId: "family-primary",
        familyBasis: "independent_report",
        assignmentConfidence: 1,
      },
      {
        sourceId: "ap-world",
        publisher: "AP News",
        canonicalUrl: "https://example.com/review/corroboration",
        originalTitle: "Independent corroboration",
        fetchedAt: new Date("2026-07-23T06:20:00.000Z"),
        role: "independent_corroboration",
        originFamilyId: "family-corroboration",
        familyBasis: "independent_report",
        assignmentConfidence: 1,
      },
    ],
    revision: 2,
  };
  const previousWebMode = process.env.WEB_MODE;
  const previousRepository = process.env.GITHUB_REPOSITORY;
  process.env.WEB_MODE = "true";
  process.env.GITHUB_REPOSITORY = "gtbwpkwjnb-alt/DailyBrief";
  const html = renderHtml(
    report,
    groupRaw([article], sources),
    "2026-07-23",
    [{ id: "internal", name: "Internal failure", reason: "must stay private" }],
    undefined,
    { passed: true, summary: "本期来源覆盖与摘要质量符合发布标准。", issues: [], suggestions: [] },
    {
      fetchedSources: 12,
      successfulSources: 11,
      sourceSuccessRate: 11 / 12,
      fetchedArticles: 120,
      dedupedArticles: 96,
      displayedArticles: 1,
      aiEnrichedArticles: 1,
      freshnessWindowHours: 72,
      freshArticles: 82,
      staleArticlesRejected: 12,
      undatedArticlesRejected: 2,
      futureArticlesRejected: 0,
      liveSnapshotArticles: 1,
      newestPublishedAt: "2026-07-23T06:20:00.000Z",
      generatedAt: "2026-07-23T07:00:00.000Z",
      mode: "fresh",
    },
    { baseRules: "公共日报基础筛选规则", customKeywords: ["AI Agent"], mode: "incremental" },
    {
      ruleSetName: "evidence_first",
      ruleSetVersion: "evidence-first-review-v1.4-r2",
      revisionNotice: "Review revision 2",
    },
  );
  if (previousWebMode === undefined) delete process.env.WEB_MODE;
  else process.env.WEB_MODE = previousWebMode;
  if (previousRepository === undefined) delete process.env.GITHUB_REPOSITORY;
  else process.env.GITHUB_REPOSITORY = previousRepository;

  await page.setContent(html);
  await expect(page.locator(".brief-meta")).toHaveAttribute("open", "");
  await expect(page.locator(".public-disclosure")).toHaveCount(0);
  await expect(page.locator("#runDailyButton")).toHaveCount(0);
  await expect(page.locator("#filterConsole")).toHaveCount(0);
  await expect(page.locator(".failed-sources")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "前往 GitHub Actions 手动运行" })).toHaveCount(0);
  await expect(page.locator(".article-priority")).toHaveCount(0);
  await expect(page.locator(".article-legacy-score")).toHaveCount(0);
  await expect(page.locator(".article-public-context")).toContainText("公共影响高");
  await expect(page.locator(".article-public-context")).toContainText("实施细节仍待正式文件确认");
  await expect(page.locator(".evidence-multi_source_confirmed")).toContainText("多源确认");
  await expect(page.locator(".article-source-list a")).toHaveCount(2);
  await expect(page.locator(".article-revision")).toContainText("修订 2");
  await expect(page.locator(".article")).toHaveAttribute("data-item-id", "review-item");
  await expect(page.locator(".article")).toHaveAttribute("data-story-id", "review-story");
  await expect(page.locator(".article")).toHaveAttribute("data-stable-order", "1");
  await expect(page.getByText("反馈本期简报")).toHaveCount(0);
  await expect(page.locator(".brief-meta-summary")).toContainText("当前日报质量分析");
  await expect(page.locator("[data-testid='edition-quality']")).toContainText("本期来源覆盖与摘要质量符合发布标准");
  await expect(page.locator("[data-testid='edition-quality']")).toContainText("91.7%");
  await expect(page.locator("[data-testid='edition-quality']")).toContainText("抓取入库");
  await expect(page.locator("[data-testid='edition-quality']")).toContainText("120 条");
  await expect(page.locator("[data-testid='edition-quality']")).toContainText("初筛候选");
  await expect(page.locator("[data-testid='edition-quality']")).toContainText("82 条");
  await expect(page.locator("[data-testid='edition-quality']")).toContainText("前端精选");
  await expect(page.locator("[data-testid='edition-quality']")).toContainText("AI 精炼 1/1");
  await expect(page.locator("[data-testid='edition-quality']")).toContainText("抽检通过");
  await expect(page.locator("[data-testid='reader-tools']")).toContainText("公共日报");
  await expect(page.locator("[data-testid='reader-tools']")).toContainText("按 URL 和规范化标题去重");
  await expect(page.locator("[data-testid='reader-tools']")).toContainText("栏目配额、来源均衡");
  await expect(page.locator("[data-testid='reader-tools']")).toContainText("AI 只对选入条目");
  await expect(page.locator("[data-testid='reader-tools']")).toContainText("用户个性化");
  await expect(page.locator("#readerKeywordsInput")).toHaveValue("AI Agent");
  expect(pageErrors).toEqual([]);
});

test("reader preferences and hot-tag suggestions work without a backend", async ({ page }) => {
  const articles: ArticleInput[] = [
    {
      sourceId: "github-trending",
      source: "GitHub Trending",
      title: "AI agent infrastructure",
      displayTitle: "AI Agent 基础设施持续升温",
      url: "https://example.com/ai-agent",
      category: "tech",
      summary: "用于验证热点词建议和行业分析测试流程。",
      tags: ["AI Agent", "人工智能"],
      importance: 7,
    },
  ];
  const html = renderHtml(report, groupRaw(articles, sources), "2026-07-24", []);

  await page.route("http://dailybrief.test/preferences", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.route("http://dailybrief.test/api/preferences", async (route) => {
    const body = route.request().postDataJSON() as { keywords: string[] };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ keywords: body.keywords, appliesTo: "next_run" }) });
  });
  await page.goto("http://dailybrief.test/preferences");
  await expect(page.locator("#readerKeywordsInput")).toHaveAttribute("placeholder", /AI Agent/);
  await page.locator(".brief-meta-summary").click();
  await page.locator(".tag-cloud-chip[data-tag='AI Agent']").click();
  await expect(page.locator("#readerKeywordsInput")).toHaveValue("AI Agent");
  await expect(page.locator("#readerKeywordHint")).toContainText("已加入热点词");
  await expect(page.locator("#readerKeywordCount")).toHaveText("1/8");
  await expect(page.getByRole("button", { name: "锁定词汇" })).toBeEnabled();
  await expect.poll(() => page.evaluate("localStorage.getItem('dailybrief.readerKeywords')")).toBeNull();
  await page.getByRole("button", { name: "锁定词汇" }).click();
  await expect(page.locator("#readerKeywordHint")).toContainText("下一次抓取将从初筛候选池增量筛选");
  await expect(page.locator("#readerKeywordsInput")).toHaveAttribute("readonly", "");
  await expect(page.locator(".article.keyword-match, .article.keyword-dimmed")).toHaveCount(0);
  await expect(page.locator(".industry-lab")).toHaveCount(0);
  await expect(page.getByText("行业分析简报")).toHaveCount(0);
});

test("reader keyword form saves normalized terms, gives feedback, and restores them on reload", async ({ page }) => {
  const articles: ArticleInput[] = [
    {
      sourceId: "github-trending",
      source: "GitHub Trending",
      title: "AI agent infrastructure",
      displayTitle: "AI Agent 基础设施持续升温",
      url: "https://example.com/ai-agent-keyword-form",
      category: "tech",
      summary: "用于验证用户筛选词保存、提示和本机恢复。",
      tags: ["AI Agent", "机器人"],
      importance: 7,
    },
  ];
  const html = renderHtml(report, groupRaw(articles, sources), "2026-07-24", []);
  const input = page.locator("#readerKeywordsInput");
  const form = page.locator("#readerKeywordForm");
  const hint = page.locator("#readerKeywordHint");

  await page.route("http://dailybrief.test/keyword-form", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.route("http://dailybrief.test/api/preferences", async (route) => {
    const body = route.request().postDataJSON() as { keywords: string[] };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ keywords: body.keywords, appliesTo: "next_run" }) });
  });
  await page.goto("http://dailybrief.test/keyword-form");
  await page.locator(".brief-meta-summary").click();
  await expect(page.locator("#readerKeywordHint")).toContainText("已输入 0/8 个，还可添加 8 个");
  await input.fill("词1、词2、词3、词4、词5、词6、词7、词8、词9");
  await expect(page.locator("#readerKeywordCount")).toHaveText("8/8");
  await expect(page.getByRole("button", { name: "请调整词汇" })).toBeDisabled();
  await expect(hint).toContainText("最多保存 8 个词");
  await input.fill(" AI Agent,机器人；ai agent | 半导体 ");
  await expect(page.locator("#readerKeywordHint")).toContainText("已输入 3/8 个，还可添加 5 个");
  await expect(page.getByRole("button", { name: "锁定词汇" })).toBeEnabled();
  await page.getByRole("button", { name: "锁定词汇" }).click();

  await expect(input).toHaveValue("AI Agent、机器人、半导体");
  await expect(hint).toContainText("已同步 3/8 个词汇");
  await expect(hint).toContainText("下一次抓取将从初筛候选池增量筛选");
  await expect(form).toHaveClass(/saved/);
  await expect(input).toHaveAttribute("readonly", "");
  await expect(page.getByRole("button", { name: "解除锁定" })).toBeEnabled();
  await expect(page.locator(".article.keyword-match, .article.keyword-dimmed")).toHaveCount(0);
  await expect.poll(() => page.evaluate("localStorage.getItem('dailybrief.readerKeywords')")).toBe("AI Agent、机器人、半导体");

  // Re-rendering the static report simulates reopening the same edition in the browser.
  await page.reload();
  await page.locator(".brief-meta-summary").click();
  await expect(input).toHaveValue("AI Agent、机器人、半导体");
  await expect(input).toHaveAttribute("readonly", "");
  await expect(input).toHaveAttribute("placeholder", /建议词：AI Agent/);

  await page.locator(".tag-cloud-chip[data-tag='AI Agent']").click();
  await expect(input).toHaveValue("AI Agent、机器人、半导体");
  await expect(hint).toContainText("词汇已锁定");

  await page.getByRole("button", { name: "解除锁定" }).click();
  await expect(input).not.toHaveAttribute("readonly", "");
  await expect(hint).toContainText("已解除锁定");
  await input.fill("");
  await page.getByRole("button", { name: "清空并恢复公共日报" }).click();
  await expect(hint).toContainText("未保存自定义词");
  await expect(page.getByRole("button", { name: "锁定词汇" })).toBeDisabled();
  await expect(page.locator(".article.keyword-match, .article.keyword-dimmed")).toHaveCount(0);
  await expect.poll(() => page.evaluate("localStorage.getItem('dailybrief.readerKeywords')")).toBeNull();
});

test("personalized section renders only incremental matches from the eligible pool", async ({ page }) => {
  const candidates: ArticleInput[] = Array.from({ length: 16 }, (_, index) => ({
    sourceId: "github-trending",
    source: "GitHub Trending",
    title: index === 15 ? "Robotics edge platform" : `General platform ${index}`,
    displayTitle: index === 15 ? "机器人边缘平台进入个性化增量" : `通用平台 ${index}`,
    url: `https://example.com/personalized-${index}`,
    category: "tech",
    summary: index === 15 ? "该项目聚焦机器人边缘推理。" : "通用技术项目。",
    aiAnalysis: "用于回归测试。",
    publishedAt: new Date(Date.UTC(2026, 6, 28, 0, 16 - index)),
  }));
  const publicRaw = groupRaw(candidates, sources);
  const personalized = selectPersonalizedArticles(candidates, publicRaw, ["Robotics"]);
  const html = renderHtml(
    report,
    publicRaw,
    "2026-07-28",
    [],
    undefined,
    undefined,
    undefined,
    { baseRules: "公共规则", customKeywords: ["Robotics"], mode: "incremental" },
    undefined,
    personalized,
  );
  await page.setContent(html);
  await expect(page.locator(".tab[data-tab='personalized']")).toContainText("用户个性化");
  await expect(page.locator("[data-panel='personalized'] .article")).toHaveCount(1);
  await expect(page.locator("[data-panel='personalized']")).toContainText("机器人边缘平台进入个性化增量");
  await expect(page.locator("[data-panel='personalized']")).toContainText("初筛候选池");
  await expect(page.locator("[data-panel='tech']")).not.toContainText("机器人边缘平台进入个性化增量");
});

test("Google Trends cards expose the original query and explain editorial importance", async ({ page }) => {
  const article: ArticleInput = {
    sourceId: "google-trends-us",
    source: "Google 热搜 · 美国",
    title: "jordan rodgers",
    displayTitle: "乔丹·罗杰斯相关搜索热度上升",
    url: "https://sports.example.com/kyle-tucker-trade",
    category: "trending",
    summary: "搜索词指向棒球运动员凯尔·塔克，因球队交易报道集中发布而在美国搜索热度上升。",
    aiAnalysis: "这笔交易可能改变球队季后赛竞争力，并影响同位置球员的后续市场估值。",
    importance: 3,
  };
  const html = renderHtml(report, groupRaw([article], sources), "2026-07-24", []);

  await page.setContent(html);
  await expect(page.locator(".article-title")).toContainText("乔丹·罗杰斯相关搜索热度上升");
  await expect(page.locator(".article-title a")).toHaveAttribute("href", "https://sports.example.com/kyle-tucker-trade");
  await expect(page.locator(".article-title a")).toHaveAttribute("target", "_blank");
  await expect(page.locator(".article-search-query")).toContainText("原始搜索词");
  await expect(page.locator(".article-search-query")).toBeVisible();
  await expect(page.locator(".article-search-query code")).toHaveText("jordan rodgers");
  await expect(page.locator(".article-summary")).toContainText("搜索词「jordan rodgers」");
  await expect(page.locator(".article-analysis")).toContainText("AI 评价");
  await expect(page.locator(".article-analysis")).toContainText(article.aiAnalysis!);
  await expect(page.locator(".article-analysis")).not.toContainText(article.summary!);
  await expect(page.locator(".article-permalink")).toHaveCount(0);
  await expect(page.locator(".article-meta")).toHaveCount(0);
  await expect(page.locator(".article-legacy-score")).toHaveCount(0);
  await expect(page.getByText("旧模型评分")).toHaveCount(0);

  await page.locator(".brief-meta-summary").click();
  await expect(page.locator(".public-disclosure")).toHaveCount(0);
});

test("world cards show publisher attribution without operator controls", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const article: ArticleInput = {
    sourceId: "bbc-world",
    source: "BBC World",
    sourceCountry: "英国",
    title: "US and Iran discuss a new regional agreement",
    displayTitle: "美国与伊朗讨论新的地区协议",
    url: "https://example.com/world",
    category: "politics",
    excerpt: "The United States and Iran discussed a regional agreement.",
    summary: "美国与伊朗就新的地区协议展开讨论，后续仍需等待正式文件确认。",
    coverageCountries: ["美国", "伊朗"],
    importance: 7,
    tags: ["国际", "外交"],
  };
  const html = renderHtml(report, groupRaw([article], sources), "2026-07-10", []);

  await page.setContent(html);
  await expect(page.locator(".article-attribution")).toContainText("英国媒体");
  await expect(page.locator(".article-attribution")).toContainText("美国");
  await expect(page.locator(".article-attribution")).toContainText("伊朗");
  await page.locator(".brief-meta-summary").click();
  await expect(page.locator("#runDailyButton")).toHaveCount(0);
  await expect(page.locator("#filterConsole")).toHaveCount(0);
  await expect(page.locator(".failed-sources")).toHaveCount(0);
  await expect(page.locator("#readerKeywordsInput")).toHaveAttribute("maxlength", "120");
  expect(pageErrors).toEqual([]);
});

test("Signal White theme remains readable without mobile overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const html = renderHtml(report, groupRaw([], sources), "2026-07-10", []);

  await page.setContent(html);

  const colors = {
    background: await page.locator("body").evaluate(
      (element: unknown) => (globalThis as any).getComputedStyle(element).backgroundColor,
    ),
    header: await page.locator(".report-header").evaluate(
      (element: unknown) => (globalThis as any).getComputedStyle(element).backgroundColor,
    ),
    title: await page.locator(".report-title").evaluate(
      (element: unknown) => (globalThis as any).getComputedStyle(element).color,
    ),
  };
  const viewport = await page.evaluate(() => {
    const browser = globalThis as any;
    return {
      width: browser.innerWidth,
      scrollWidth: browser.document.documentElement.scrollWidth,
    };
  });

  expect(colors.header).toBe("rgb(11, 19, 43)");
  expect(colors.title).toBe("rgb(248, 251, 255)");
  expect(colors.background).not.toBe("");
  await expect(page.locator("body")).toHaveAttribute("data-active-category", "trending");
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width);
  await expect(page.locator(".tabs")).toBeVisible();
  await expect(page.locator(".reading-context")).toBeVisible();
});

test("continuous stream keeps sections in one flow and progressively reveals more items", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const trending = Array.from({ length: 14 }, (_, index): ArticleInput => ({
    sourceId: "google-trends-us",
    source: "Google 热搜 · 美国",
    title: `Trending item ${index + 1}`,
    displayTitle: `连续热搜条目 ${index + 1}`,
    url: `https://example.com/trending/${index + 1}`,
    category: "trending",
    summary: `用于验证连续信息流自动接入的第 ${index + 1} 条摘要。`,
    tags: ["热搜", index % 2 === 0 ? "科技" : "社会"],
    importance: 6,
  }));
  const tech: ArticleInput = {
    sourceId: "github-trending",
    source: "GitHub Trending",
    title: "Continuous feed navigation",
    displayTitle: "连续信息流导航",
    url: "https://example.com/tech",
    category: "tech",
    summary: "验证点击栏目只负责滚动定位，不会隐藏其他栏目。",
    tags: ["技术"],
    importance: 8,
  };
  const politics: ArticleInput = {
    sourceId: "bbc-world",
    source: "BBC World",
    title: "World update",
    displayTitle: "国际动态更新",
    url: "https://example.com/world-update",
    category: "politics",
    summary: "验证后续栏目能够自动接入同一条纵向信息流。",
    tags: ["国际"],
    importance: 7,
  };
  const html = renderHtml(report, groupRaw([...trending, tech, politics], sources), "2026-07-10", []);

  await page.setContent(html);

  await expect(page.locator("[data-panel='trending']")).toBeVisible();
  const trendingBackground = await page.locator("body").evaluate((element: unknown) => (globalThis as any).getComputedStyle(element).backgroundColor);
  await expect(page.locator("body")).toHaveAttribute("data-active-category", "trending");
  await expect(page.locator(".article.stream-pending")).toHaveCount(4);
  await page.locator(".tab[data-tab='tech']").click();
  await expect(page.locator("[data-panel='tech']")).toBeVisible();
  await expect(page.locator("[data-panel='trending']")).toBeVisible();
  await expect(page.locator("#currentCategory")).toContainText("技术动态");
  await expect(page.locator("#readingPosition")).toContainText("15 / 16");
  await expect(page.locator("body")).toHaveAttribute("data-active-category", "tech");
  const techBackground = await page.locator("body").evaluate((element: unknown) => (globalThis as any).getComputedStyle(element).backgroundColor);
  expect(techBackground).not.toBe(trendingBackground);
  await expect(page.locator(".panel:not(.active)")).toHaveCount(0);
});

test("mobile category spy keeps the active category inside the horizontal navigation", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  const articles: ArticleInput[] = [
    { sourceId: "google-trends-us", source: "Google Trends", title: "Trend", url: "https://example.com/t", category: "trending", summary: "趋势摘要" },
    { sourceId: "github-trending", source: "GitHub Trending", title: "Tech", url: "https://example.com/a", category: "tech", summary: "技术摘要" },
    { sourceId: "bbc-world", source: "BBC World", title: "World", url: "https://example.com/p", category: "politics", summary: "国际摘要" },
    { sourceId: "wallstreetcn", source: "WallstreetCN", title: "Finance", url: "https://example.com/f", category: "finance", summary: "财经摘要" },
  ];
  const html = renderHtml(report, groupRaw(articles, sources), "2026-07-10", []);

  await page.setContent(html);
  const financeTab = page.locator(".tab[data-tab='finance']");
  await financeTab.click();
  await expect(financeTab).toHaveClass(/active/);
  await expect.poll(async () => financeTab.evaluate((element) => {
    const tab = element.getBoundingClientRect();
    const nav = element.parentElement!.getBoundingClientRect();
    return tab.left >= nav.left && tab.right <= nav.right;
  })).toBe(true);
});

test("mobile navigation keeps the current subsection directly reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const articles: ArticleInput[] = [
    { sourceId: "github-trending", source: "GitHub Trending", title: "GitHub item", url: "https://example.com/github", category: "tech", summary: "GitHub 摘要" },
    { sourceId: "qbitai", source: "量子位", title: "QbitAI item", url: "https://example.com/qbitai", category: "tech", summary: "量子位摘要" },
    { sourceId: "openai-news", source: "OpenAI News", title: "OpenAI item", url: "https://example.com/openai", category: "tech", summary: "OpenAI 摘要" },
  ];
  await page.setContent(renderHtml(report, groupRaw(articles, sources), "2026-07-10", []));
  await page.locator(".tab[data-tab='tech']").click();

  const aiNewsSub = page.locator("#mobileSubTabs .sub-tab[data-sub='ai-news']");
  await expect(aiNewsSub).toBeVisible();
  await aiNewsSub.click();
  await expect(page.locator("#mobileSubTabs .sub-tab[data-sub='ai-news']")).toHaveClass(/active/);
  await expect(page.locator("#mobileSourceTabs")).toBeHidden();
  await expect(page.locator("body")).toHaveAttribute("data-active-category", "tech");
  await expect(page.locator(".article[data-article-url='https://example.com/qbitai']")).toBeVisible();
  await expect(page.locator(".article-meta, .article-legacy-score, .article-priority")).toHaveCount(0);

  const sectionColor = await page.locator(".stream-section[data-panel='tech']").evaluate(
    (element: unknown) => (globalThis as any).getComputedStyle(element).borderTopColor,
  );
  await expect.poll(() => page.locator("#mobileSubTabs .sub-tab.active").evaluate(
    (element: unknown) => (globalThis as any).getComputedStyle(element).backgroundColor,
  )).toBe(sectionColor);
});

test("market and community columns are absent and community sources stay out of public output", async ({ page }) => {
  const articles: ArticleInput[] = [
    { sourceId: "github-trending", source: "GitHub Trending", title: "Visible technology", url: "https://example.com/visible-tech", category: "tech", summary: "技术摘要" },
    { sourceId: "v2ex-hot", source: "V2EX", title: "Hidden community", url: "https://example.com/hidden-community", category: "tech", summary: "社区摘要" },
  ];
  const raw = groupRaw(articles, sources);
  const personalized = selectPersonalizedArticles(articles, raw, ["Hidden community"]);
  await page.setContent(renderHtml({ ...report, trading: { generated_at: "2026-07-10T00:00:00.000Z", tickers: [], watchlist: [], market_overview: "hidden", risk_caveat: "hidden" } }, raw, "2026-07-10", [], undefined, undefined, undefined, undefined, undefined, personalized));

  await expect(page.locator(".tab[data-tab='trading'], [data-panel='trading']")).toHaveCount(0);
  await expect(page.locator(".tab[data-tab='community'], [data-panel='community']")).toHaveCount(0);
  await expect(page.locator(".article[data-article-url='https://example.com/hidden-community']")).toHaveCount(0);
  expect(personalized).toHaveLength(0);
});

test("desktop sidebar keeps current subsection shortcuts visible and category-colored", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  const articles: ArticleInput[] = [
    { sourceId: "github-trending", source: "GitHub Trending", title: "GitHub", url: "https://example.com/desktop/github", category: "tech", summary: "GitHub 摘要" },
    { sourceId: "qbitai", source: "量子位", title: "AI", url: "https://example.com/desktop/ai", category: "tech", summary: "AI 摘要" },
  ];
  await page.setContent(renderHtml(report, groupRaw(articles, sources), "2026-07-10", []));
  await page.locator(".tab[data-tab='tech']").click();

  const shortcuts = page.locator("#mobileSubTabs");
  await expect(shortcuts).toBeVisible();
  await expect(shortcuts.locator(".sub-tab[data-sub='github-trending']")).toBeVisible();
  const aiShortcut = shortcuts.locator(".sub-tab[data-sub='ai-news']");
  await expect(aiShortcut).toBeVisible();
  await aiShortcut.click();
  await expect(aiShortcut).toHaveClass(/active/);
  await expect(page.locator("#currentSubcategory")).toContainText("AI 媒体");

  const sectionColor = await page.locator(".stream-section[data-panel='tech']").evaluate(
    (element: unknown) => (globalThis as any).getComputedStyle(element).borderTopColor,
  );
  await expect.poll(() => aiShortcut.evaluate(
    (element: unknown) => (globalThis as any).getComputedStyle(element).backgroundColor,
  )).toBe(sectionColor);
  await expect(page.locator(".stream-section[data-panel='tech'] .article").first()).toHaveCSS("border-left-color", sectionColor);
  await expect(page.locator(".stream-section[data-panel='tech'] .article-summary").first()).toHaveCSS("border-left-color", sectionColor);
});

test("edition polling preserves existing query parameters", async ({ page }) => {
  const requests: string[] = [];
  const html = renderHtml(report, groupRaw([], sources), "2026-07-10", [], undefined, undefined, {
    fetchedSources: 1,
    successfulSources: 1,
    sourceSuccessRate: 1,
    fetchedArticles: 1,
    dedupedArticles: 1,
    generatedAt: "2026-07-10T08:00:00.000Z",
    mode: "fresh",
  });
  await page.clock.install();
  await page.route("https://brief.test/report**", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/html", body: html });
  });

  await page.goto("https://brief.test/report?view=compact");
  requests.length = 0;
  await page.clock.fastForward(180_000);
  await expect.poll(() => requests.find((url) => url.includes("edition=")) ?? "").not.toBe("");

  const refreshUrl = new URL(requests.find((url) => url.includes("edition="))!);
  expect(refreshUrl.searchParams.get("view")).toBe("compact");
  expect(refreshUrl.searchParams.get("edition")).toMatch(/^\d+$/);
});

test("tag navigation reveals a matching article beyond the current batch", async ({ page }) => {
  const articles = Array.from({ length: 13 }, (_, index): ArticleInput => ({
    sourceId: "google-trends-us",
    source: "Google Trends",
    title: `Tagged item ${index + 1}`,
    url: `https://example.com/tagged/${index + 1}`,
    category: "trending",
    summary: `标签跳转测试 ${index + 1}`,
    tags: [index === 12 ? "后续目标" : "首批标签"],
  }));
  const html = renderHtml(report, groupRaw(articles, sources), "2026-07-10", []);

  await page.setContent(html);
  const target = page.locator(".article[data-article-url='https://example.com/tagged/13']");
  await expect(target).toHaveClass(/stream-pending/);
  await page.locator(".brief-meta-summary").click();
  await page.locator(".tag-cloud-chip[data-tag='后续目标']").click();
  await expect(target).not.toHaveClass(/stream-pending/);
  await expect(target).toBeVisible();
});

test("reload anchor restores the matching article after page load", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const articles = Array.from({ length: 14 }, (_, index): ArticleInput => ({
    sourceId: "google-trends-us",
    source: "Google Trends",
    title: `Restored item ${index + 1}`,
    url: `https://example.com/restored/${index + 1}`,
    category: "trending",
    summary: `刷新后阅读位置恢复测试 ${index + 1}`,
  }));
  const html = renderHtml(report, groupRaw(articles, sources), "2026-07-10", []);
  await page.route("https://brief.test/restore", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: html });
  });

  await page.goto("https://brief.test/restore");
  const targetUrl = "https://example.com/restored/13";
  await page.evaluate((url) => (globalThis as any).sessionStorage.setItem("dailybrief.reloadAnchor", url), targetUrl);
  await page.reload({ waitUntil: "load" });

  const target = page.locator(`.article[data-article-url='${targetUrl}']`);
  await expect(target).not.toHaveClass(/stream-pending/);
  await expect(target).toBeInViewport();
  await expect.poll(() => page.evaluate(() => (globalThis as any).scrollY)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (globalThis as any).sessionStorage.getItem("dailybrief.reloadAnchor"))).toBeNull();
});
