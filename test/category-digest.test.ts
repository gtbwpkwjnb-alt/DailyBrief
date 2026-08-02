import assert from "node:assert/strict";
import test from "node:test";
import { buildCategoryDigests } from "../lib/editorial/category-digest";
import type { ArticleInput } from "../lib/ai/pipeline";

function article(overrides: Partial<ArticleInput> & Pick<ArticleInput, "title" | "url" | "category">): ArticleInput {
  return {
    sourceId: "example",
    source: "Example",
    excerpt: "Source context.",
    displayTitle: "有效标题",
    summary: "原文提供了可核验的事实背景。",
    aiAnalysis: "该变化可能影响相关用户的后续决策，仍需结合实际采用情况观察。",
    importance: 5,
    publishedAt: new Date("2026-08-02T06:00:00Z"),
    tags: ["科技"],
    ...overrides,
  };
}

test("category digests exclude source-only fallback items", () => {
  const digests = buildCategoryDigests([
    article({ title: "Valid", url: "https://example.com/valid", category: "tech", displayTitle: "有效项目更新" }),
    article({
      title: "Fallback analysis", url: "https://example.com/fallback-analysis", category: "tech",
      displayTitle: "降级标题", aiAnalysis: "本条 AI 分析暂不可用，形成判断前请先核验来源。",
    }),
    article({
      title: "Fallback tag", url: "https://example.com/fallback-tag", category: "tech",
      displayTitle: "信息有限标题", tags: ["信息有限"],
    }),
    article({
      title: "Fallback summary", url: "https://example.com/fallback-summary", category: "tech",
      displayTitle: "原文降级标题", summary: "信息有限：仅展示来源原文摘录。Source excerpt.",
    }),
  ]);

  assert.match(digests.tech ?? "", /有效项目更新/);
  assert.doesNotMatch(digests.tech ?? "", /降级标题|信息有限标题|原文降级标题/);
});

test("category digests rank valid items by importance then publication time", () => {
  const digests = buildCategoryDigests([
    article({ title: "Older high", url: "https://example.com/a", category: "finance", displayTitle: "高优先级较早", importance: 8, publishedAt: new Date("2026-08-02T01:00:00Z") }),
    article({ title: "Newest high", url: "https://example.com/b", category: "finance", displayTitle: "高优先级较新", importance: 8, publishedAt: new Date("2026-08-02T07:00:00Z") }),
    article({ title: "Lower", url: "https://example.com/c", category: "finance", displayTitle: "低优先级", importance: 6 }),
    article({ title: "Fourth", url: "https://example.com/d", category: "finance", displayTitle: "第四条", importance: 5 }),
  ]);

  const digest = digests.finance ?? "";
  assert.ok(digest.indexOf("高优先级较新") < digest.indexOf("高优先级较早"));
  assert.ok(digest.indexOf("高优先级较早") < digest.indexOf("低优先级"));
  assert.doesNotMatch(digest, /第四条/);
  assert.match(digest, /基于当前有效条目/);
});

test("category digests omit empty categories and support English copy", () => {
  const empty = buildCategoryDigests([
    article({
      title: "Fallback", url: "https://example.com/fallback", category: "politics",
      aiAnalysis: "AI analysis is unavailable for this item; verify the source.",
    }),
  ]);
  assert.deepEqual(empty, {});

  const english = buildCategoryDigests([
    article({ title: "Valid", url: "https://example.com/valid", category: "trending", displayTitle: "Valid item" }),
  ], "en");
  assert.match(english.trending ?? "", /^Trending brief \(based on current valid items\): Valid item:/);
});
