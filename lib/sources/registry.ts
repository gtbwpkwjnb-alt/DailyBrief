import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceRegistrySchema } from "./schema";
import type { SourceDef } from "./types";

/**
 * Source registry — loaded at module-init time from sources.config.json
 * at the project root. The JSON file is the **single source of truth**;
 * edit it (or use `npm run sources` to inspect) rather than hard-coding
 * sources here.
 *
 * Locale filtering:
 *   - `REPORT_LOCALE=zh` (default) — keeps sources whose `locales` includes "zh"
 *   - `REPORT_LOCALE=en`           — keeps sources whose `locales` includes "en"
 *   Sources without an explicit `locales` field default to both ["zh", "en"].
 *
 * Adding a source:
 *   - Plain RSS / Atom: add a JSON entry with type=rss. If the host blocks
 *     Node's undici TLS fingerprint (Cloudflare "Just a moment…"), set
 *     useCurl=true so rss.ts shells out to curl.
 *   - Special source (HN / V2EX / GitHub Trending / LinuxDo): add a branch
 *     in lib/sources/dispatch.ts pointing to your fetcher.
 *
 * `enabled: false` entries stay in the config for visibility; disable
 * rather than delete so the "why we don't use this" history is preserved.
 *
 * Subcategory determines L2 grouping in the rendered HTML:
 *   tech    → github-trending / ai-news / x-viral (cn-community renders as L1)
 *   finance → news
 *   politics → no L2 split (subcategory omitted)
 */

export const REPORT_LOCALE: "zh" | "en" =
  process.env.REPORT_LOCALE === "en" ? "en" : "zh";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, "../..", "sources.config.json");

function loadAndValidate(): SourceDef[] {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Source config missing: ${CONFIG_PATH}`);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch (e) {
    throw new Error(`Cannot read ${CONFIG_PATH}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${CONFIG_PATH}: ${(e as Error).message}`);
  }
  const result = sourceRegistrySchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${CONFIG_PATH}: ${details}`);
  }
  return result.data as SourceDef[];
}

function filterByLocale(all: SourceDef[]): SourceDef[] {
  return all.filter((s) => {
    const locales = s.locales ?? ["zh", "en"];
    return locales.includes(REPORT_LOCALE);
  });
}

export const sources: SourceDef[] = filterByLocale(loadAndValidate());

/**
 * The full unfiltered list — used by `npm run sources` so the CLI can
 * show entries that are filtered out in the current locale.
 */
export function loadAllSources(): SourceDef[] {
  return loadAndValidate();
}
