import "./_env";

import fs from "node:fs";

import type { DailyReport } from "../lib/ai/pipeline";
import { groupRaw, renderHtml } from "../lib/output/render";
import { parseReportSidecar } from "../lib/output/sidecar";
import { filterFreshArticles } from "../lib/sources/freshness";
import { sources } from "../lib/sources/registry";

function renderedArticles(raw: ReturnType<typeof groupRaw>) {
  return Object.values(raw).flatMap((groups) =>
    groups.flatMap((group) => group.sources.flatMap((source) => source.items)),
  );
}

function main(): void {
  const sidecarPath = process.argv[2];
  const reportPath = process.argv[3];
  if (!sidecarPath) {
    throw new Error("usage: npm run backtest:freshness -- <articles.json> [report.json]");
  }

  const sidecar = parseReportSidecar(JSON.parse(fs.readFileSync(sidecarPath, "utf8")));
  const generatedAt = sidecar.runStats?.generatedAt;
  if (!generatedAt) throw new Error("sidecar runStats.generatedAt is required for deterministic backtesting");

  const freshness = filterFreshArticles(sidecar.articles, sources, {
    referenceTime: new Date(generatedAt),
  });
  const raw = groupRaw(freshness.articles, sources, {
    customKeywords: sidecar.filterProfile?.customKeywords,
  });
  const rendered = renderedArticles(raw);
  const renderedCheck = filterFreshArticles(rendered, sources, {
    referenceTime: new Date(generatedAt),
    maxAgeHours: freshness.stats.freshnessWindowHours,
  });
  if (renderedCheck.articles.length !== rendered.length) {
    throw new Error(
      `freshness regression: ${rendered.length - renderedCheck.articles.length} rejected articles reached rendering`,
    );
  }

  let htmlBytes: number | undefined;
  if (reportPath) {
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as DailyReport;
    const stats = sidecar.runStats ? { ...sidecar.runStats, ...freshness.stats } : undefined;
    const html = renderHtml(
      report,
      raw,
      sidecar.date,
      sidecar.failedSources,
      {},
      undefined,
      stats,
      sidecar.filterProfile,
    );
    htmlBytes = Buffer.byteLength(html);
  }

  console.log(JSON.stringify({
    date: sidecar.date,
    originalArticles: sidecar.articles.length,
    ...freshness.stats,
    renderedArticles: rendered.length,
    htmlBytes,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error("[backtest:freshness] FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
}
