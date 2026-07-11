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
  const article: ArticleInput = {
    sourceId: "github-trending",
    source: "GitHub Trending",
    title: "Unsafe link is rendered as plain text",
    url: "javascript:alert(1)",
    category: "tech",
    summary: "A safe rendering test.",
  };
  const html = renderHtml(report, groupRaw([article], sources), "2026-07-10", []);

  await page.setContent(html);
  await expect(page.locator(".report-title")).toHaveText("2026-07-10");
  await expect(page.locator("a[href^='javascript:']")).toHaveCount(0);
  await expect(page.locator(".article-title")).toContainText(article.title);
  expect((await page.screenshot()).byteLength).toBeGreaterThan(1_000);
});
