import fs from "node:fs";
import { parseReportSidecar } from "../lib/output/sidecar";
import {
  groupRaw,
  selectPersonalizedArticles,
  selectPublicArticlesForDisplay,
  visibleArticlesFromRaw,
} from "../lib/output/render";
import { normalizeCustomKeywords } from "../lib/editorial/context";
import { sources } from "../lib/sources/registry";

function readInput(): string {
  const file = process.argv[2];
  return file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8");
}

const sidecar = parseReportSidecar(JSON.parse(readInput().replace(/^\uFEFF/, "")));
const referenceTime = new Date(sidecar.runStats?.generatedAt ?? `${sidecar.date}T23:59:59+08:00`);
const customKeywords = normalizeCustomKeywords(
  process.env.BACKTEST_KEYWORDS ?? sidecar.filterProfile?.customKeywords ?? [],
);
const minimumQuality = Number(process.env.BACKTEST_MINIMUM_QUALITY);
const publicSelection = selectPublicArticlesForDisplay(sidecar.articles, sources, {
  referenceTime,
  minimumQualityScore: Number.isFinite(minimumQuality) && minimumQuality >= 0
    ? minimumQuality
    : undefined,
});
const publicRaw = groupRaw(publicSelection.articles, sources, { skipPublicSelection: true });
const limitedSelection = selectPublicArticlesForDisplay(publicSelection.articles, sources, {
  referenceTime,
  categoryTargets: { trending: 4, tech: 12, politics: 6, finance: 6 },
  minimumQualityScore: Number.isFinite(minimumQuality) && minimumQuality >= 0
    ? minimumQuality
    : undefined,
});
const personalized = selectPersonalizedArticles(sidecar.articles, publicRaw, customKeywords);
const publicUrls = new Set(visibleArticlesFromRaw(publicRaw).map((article) => article.url));

console.log(JSON.stringify({
  date: sidecar.date,
  historical: {
    storedCandidates: sidecar.articles.length,
    fetchedArticles: sidecar.runStats?.fetchedArticles,
    dedupedArticles: sidecar.runStats?.dedupedArticles,
    freshArticles: sidecar.runStats?.freshArticles,
    displayedArticles: sidecar.runStats?.displayedArticles,
    aiEnrichedArticles: sidecar.runStats?.aiEnrichedArticles,
    sourceFallbackArticles: sidecar.runStats?.sourceFallbackArticles,
  },
  replay: {
    publicArticles: publicUrls.size,
    personalizedArticles: personalized.length,
    totalArticles: publicUrls.size + personalized.length,
    personalizedKeywords: customKeywords,
    personalizedOverlapsPublic: personalized.filter((article) => publicUrls.has(article.url)).length,
    selection: publicSelection.stats,
    circuitLimitedApproximation: {
      publicArticles: limitedSelection.articles.length,
      selection: limitedSelection.stats,
    },
  },
}, null, 2));
