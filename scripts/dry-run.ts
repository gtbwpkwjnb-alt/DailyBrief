import "./_env";

import { sources } from "../lib/sources/registry";
import { fetchSource } from "../lib/sources/dispatch";
import type { ArticleInput } from "../lib/ai/pipeline";
import type { RawArticle, SourceDef } from "../lib/sources/types";

type DryRunResult =
  | { source: SourceDef; items: RawArticle[] }
  | { source: SourceDef; error: unknown };

function readPositiveInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// Source-fetch sanity check only — does NOT call the LLM. For the full
// ingest → digest → write-to-disk pipeline use `npm run daily` instead.
async function main() {
  const concurrency = readPositiveInt("SOURCE_FETCH_CONCURRENCY", 6);
  console.log(`Fetching from sources (concurrency=${concurrency})…\n`);
  const articles: ArticleInput[] = [];

  const requestedIds = new Set(process.argv.slice(2));
  const enabled = sources.filter((source) =>
    source.enabled !== false && (requestedIds.size === 0 || requestedIds.has(source.id)),
  );
  const missingIds = [...requestedIds].filter((id) => !enabled.some((source) => source.id === id));
  if (missingIds.length > 0) throw new Error(`unknown or disabled source ids: ${missingIds.join(", ")}`);
  let failed = 0;
  for (let offset = 0; offset < enabled.length; offset += concurrency) {
    const batch = enabled.slice(offset, offset + concurrency);
    const results: DryRunResult[] = await Promise.all(batch.map(async (source): Promise<DryRunResult> => {
      try {
        return { source, items: await fetchSource(source) };
      } catch (error) {
        return { source, error };
      }
    }));
    for (const result of results) {
      if ("error" in result) {
        failed += 1;
        const msg = result.error instanceof Error ? result.error.message : String(result.error);
        console.error(`  ${result.source.id.padEnd(20)} FAILED — ${msg}`);
      } else {
        console.log(`  ${result.source.id.padEnd(20)} ${result.items.length}`);
        articles.push(...result.items.map((item) => ({ ...item, source: result.source.name })));
      }
    }
  }

  console.log(`\nTotal articles: ${articles.length} · failed sources: ${failed}/${enabled.length}`);
  console.log("\nTop 10 articles:");
  articles.slice(0, 10).forEach((a, i) => {
    console.log(`  ${i + 1}. [${a.category}] ${a.title}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
