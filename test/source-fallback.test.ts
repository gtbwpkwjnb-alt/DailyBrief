import assert from "node:assert/strict";
import test from "node:test";
import { completeSourceExcerpt, createReviewUnavailableFallbackArticles } from "../lib/ai/pipeline";

test("source fallback keeps complete sentences instead of fixed-width fragments", () => {
  const firstSentence = "A concrete first sentence explains what changed and why it matters to readers.";
  const excerpt = `${firstSentence} ${"A later sentence contains additional detail. ".repeat(12)}`;
  assert.equal(completeSourceExcerpt(excerpt, 100, 180), firstSentence);

  const [article] = createReviewUnavailableFallbackArticles([{
    sourceId: "example",
    source: "Example",
    title: "A source report",
    url: "https://example.com/report",
    category: "tech",
    excerpt,
  }]);
  assert.ok(article);
  assert.match(article.summary ?? "", /first sentence explains/);
  assert.match(article.summary ?? "", /[.!?。！？]["'”’）)\]]*$/);
  assert.doesNotMatch(article.summary ?? "", /additional detai$/);
});

test("source fallback uses an explicit verification notice when no complete sentence is safe", () => {
  const excerpt = "word ".repeat(160).trim();
  assert.equal(completeSourceExcerpt(excerpt), null);
  const [article] = createReviewUnavailableFallbackArticles([{
    sourceId: "example",
    source: "Example",
    title: "A source report",
    url: "https://example.com/report",
    category: "finance",
    excerpt,
  }]);
  assert.ok(article);
  assert.match(article.summary ?? "", /完整来源句子|complete source sentence/i);
});
