import { expect, test } from "@playwright/test";
import { groupRaw, renderHtml } from "../lib/output/render";
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
  await expect(page.locator(".article-importance")).toContainText("8/10");
  await expect(page.locator("#runDailyButton")).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect((await page.screenshot()).byteLength).toBeGreaterThan(1_000);
});

test("world cards show publisher attribution and the incremental filter control", async ({ page }) => {
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
  await page.locator("#customFilterToggle").click();
  await expect(page.locator("#customFilterForm")).toBeVisible();
  await expect(page.locator("#customKeywordsInput")).toHaveAttribute("maxlength", "120");
  expect(pageErrors).toEqual([]);
});
