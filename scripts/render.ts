import "./_env";

import fs from "node:fs";
import path from "node:path";

import type { ArticleInput, DailyReport } from "../lib/ai/pipeline";
import { parseReportSidecar } from "../lib/output/sidecar";
import { sources } from "../lib/sources/registry";
import { filterFreshArticles } from "../lib/sources/freshness";
import { todayKey } from "../lib/utils";

const OUTPUT_DIR = "daily_reports";

function loadReport(date: string): DailyReport {
  const file = path.join(OUTPUT_DIR, date, `${date}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Report JSON not found: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as DailyReport;
}

function loadArticles(date: string): { articles: ArticleInput[]; failedSources?: Array<{ id: string; name: string; reason: string }>; runStats?: import("../lib/output/render").RunStats; filterProfile?: import("../lib/output/render").FilterProfile; qualityReview?: { passed: boolean; summary: string; issues: string[]; suggestions: string[] } } {
  const file = path.join(OUTPUT_DIR, date, `${date}-articles.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Articles sidecar not found: ${file}\n` +
        `Run \`npm run daily\` for ${date} first (or any date >= when sidecar was introduced).`,
    );
  }
  const data = parseReportSidecar(JSON.parse(fs.readFileSync(file, "utf8")));
  return {
    articles: data.articles,
    failedSources: data.failedSources,
    runStats: data.runStats,
    filterProfile: data.filterProfile,
    qualityReview: data.qualityReview,
  };
}

async function main() {
  const date = process.argv[2] || todayKey();
  console.log(`[render] re-rendering ${date} from cached data…`);

  const report = loadReport(date);
  const { articles, failedSources, runStats, filterProfile, qualityReview } = loadArticles(date);
  console.log(`[render] loaded ${articles.length} articles + report`);

  // Dynamic import to bypass ESM module cache during UI iteration
  const { renderHtml, groupRaw, renderMarkdown } = await import(
    `../lib/output/render?cacheBust=${Date.now()}`
  );

  const freshness = filterFreshArticles(articles, sources, {
    referenceTime: runStats?.generatedAt ? new Date(runStats.generatedAt) : new Date(),
  });
  const effectiveRunStats = runStats ? { ...runStats, ...freshness.stats } : undefined;
  console.log(
    `[render] freshness kept ${freshness.stats.freshArticles}/${articles.length} articles `
      + `(${freshness.stats.freshnessWindowHours}h window)`,
  );
  const raw = groupRaw(freshness.articles, sources, { customKeywords: filterProfile?.customKeywords });
  const dateDir = path.join(OUTPUT_DIR, date);
  fs.mkdirSync(dateDir, { recursive: true });
  const base = path.join(dateDir, date);
  fs.writeFileSync(`${base}.html`, renderHtml(report, raw, date, failedSources, {}, qualityReview, effectiveRunStats, filterProfile), "utf8");
  if (process.env.OUTPUT_MARKDOWN === "true") {
    fs.writeFileSync(`${base}.md`, renderMarkdown(report, date), "utf8");
    console.log(`[render] wrote ${base}.{html,md}`);
  } else {
    console.log(`[render] wrote ${base}.html`);
  }
}

main().catch((e) => {
  console.error("[render] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
