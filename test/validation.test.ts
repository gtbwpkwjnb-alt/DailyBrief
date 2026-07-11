import assert from "node:assert/strict";
import test from "node:test";
import { parseConsolidatedResult } from "../lib/ai/consolidated-validation";
import { parseReportSidecar } from "../lib/output/sidecar";
import { safeExternalUrl } from "../lib/output/render";
import { sourceRegistrySchema } from "../lib/sources/schema";
import { parseFreshRssItems, parseMinifluxEntries } from "../lib/sources/reader";

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
    summary: "summary",
    tags: [],
    importance: 5,
  });
  assert.equal(result.has("https://example.com/other"), false);
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
    }],
  });
  assert.ok(sidecar.articles[0].publishedAt instanceof Date);
  assert.throws(() => parseReportSidecar({ date: "invalid", articles: [] }));
});
