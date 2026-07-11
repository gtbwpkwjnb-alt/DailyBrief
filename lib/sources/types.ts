export type Category = "trending" | "tech" | "finance" | "politics";
export type SourceType = "rss" | "api" | "scrape" | "reader";
export type SourceProvider = "direct" | "freshrss" | "miniflux";
export type SourceTier = "core" | "standard" | "supplement";

export interface SourceDef {
  id: string;
  name: string;
  type: SourceType;
  /**
   * Collection boundary. Omitted sources use the existing direct fetch path.
   * Reader providers pull already-ingested content from a single API.
   */
  provider?: SourceProvider;
  /**
   * External feed/stream ID for reader providers. FreshRSS accepts a stream
   * name; Miniflux accepts an optional numeric feed ID.
   */
  providerSourceId?: string;
  /** Operational importance for provider-aware health reporting and gates. */
  tier?: SourceTier;
  url: string;
  category: Category;
  /**
   * Group key within a category. Render order/labels are defined per
   * category in lib/output/render.ts. Categories without a registered
   * order render flat (no L2 tabs).
   */
  subcategory?: string;
  /**
   * When true, the rss fetcher shells out to curl instead of using
   * Node's undici. Required for hosts that TLS-fingerprint Node
   * (Cloudflare's "Just a moment…" challenge — LinuxDo, Reddit, etc.)
   */
  useCurl?: boolean;
  enabled?: boolean;
  /**
   * Source content language. Default treated as "en". When this equals
   * the active REPORT_LOCALE, the summary-enrichment step skips this
   * source — its content is already in the target language, so an LLM
   * "summary" would just be a slightly-shorter rewrite.
   */
  lang?: "zh" | "en";
  /**
   * Report locales this source participates in. Defaults to ["zh", "en"]
   * (both) when omitted. Set to ["zh"] for Chinese-only sources whose
   * content is meaningless to English-mode readers (V2EX/LinuxDo/etc.),
   * or ["en"] for English-community sources used to replace Chinese ones
   * when REPORT_LOCALE=en. The registry filters by REPORT_LOCALE at load.
   */
  locales?: ("zh" | "en")[];
  /**
   * Optional human-readable note explaining why a source is disabled or
   * any context useful for fork users. Ignored at runtime.
   */
  notes?: string;
  /**
   * Optional keyword filter list. When present, only items whose title or
   * body matches at least one keyword (case-insensitive) are kept.
   * Omit or leave empty to return all items unfiltered.
   */
  keywords?: string[];
  /**
   * Quality priority score (1-5, 5=highest). Used by the pipeline to
   * fetch high-quality sources first and prioritize enrichment.
   * Default: 3 for most sources, 5 for top-tier sources, 1 for disabled.
   */
  priority?: number;
}

export interface RawArticle {
  sourceId: string;
  title: string;
  url: string;
  excerpt?: string;
  publishedAt?: Date;
  category: Category;
  /**
   * LLM-generated summary in the active REPORT_LOCALE language. For zh
   * reports this is the Chinese translation/summary of an English source;
   * for en reports it'd be the English summary of a non-English source.
   */
  summary?: string;
  /**
   * LLM-generated title in the active report locale. The original feed title
   * remains intact for deduplication, attribution, and the outbound link.
   */
  displayTitle?: string;
  /** LLM-assigned editorial importance score, from 1 (low) to 10 (highest). */
  importance?: number;
  /**
   * Structured one-line metadata to display above the excerpt — currently
   * used by GitHub Trending for "Language · ★stars · forks · stars today".
   */
  meta?: string;
  /**
   * AI-generated content attribute tags, e.g. ["官媒", "政治", "战争"].
   * Set by the tag enrichment step after summary generation.
   * Tags enable retrieval, linking, and cross-referencing in Obsidian KB.
   */
  tags?: string[];
}
