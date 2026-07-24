import "./_env";

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { ArticleInput, DailyReport } from "../lib/ai/pipeline";
import { groupRaw, renderHtml } from "../lib/output/render";
import { sources } from "../lib/sources/registry";

const sourceRoleSchema = z.enum([
  "primary_report",
  "official_statement",
  "independent_corroboration",
  "analysis",
  "community_signal",
  "reprint",
]);

const familyBasisSchema = z.enum([
  "wire",
  "reprint",
  "shared_primary",
  "independent_report",
  "official_statement",
  "community_origin",
  "unknown",
]);

const sourceRefSchema = z.object({
  source_id: z.string().min(1),
  publisher: z.string().min(1),
  canonical_url: z.url({ protocol: /^https?$/ }),
  original_title: z.string().min(1),
  published_at: z.string().datetime({ offset: true }).nullable(),
  fetched_at: z.string().datetime({ offset: true }),
  role: sourceRoleSchema,
  origin_family_id: z.string().min(1),
  family_basis: familyBasisSchema,
  assignment_confidence: z.number().min(0).max(1),
}).strict();

const reviewItemSchema = z.object({
  item_id: z.string().min(1),
  story_id: z.string().min(1),
  stable_order: z.number().int().positive(),
  category: z.enum(["trending", "tech", "finance", "politics"]),
  subcategory: z.string().min(1),
  display_title: z.string().min(1),
  original_title: z.string().min(1),
  priority_level: z.enum(["P0", "P1", "P2", "P3", "P4"]),
  reason_codes: z.array(z.string().min(1)).min(1).max(3),
  evidence_state: z.enum([
    "multi_source_confirmed",
    "single_named_source",
    "developing",
    "unverified",
  ]),
  evidence_note: z.string().min(1),
  summary_short: z.string().min(1),
  summary_expanded: z.string().min(1).nullable(),
  uncertainties: z.array(z.string().min(1)).max(8),
  tags: z.array(z.string().min(1)).max(8),
  primary_source_ref_id: z.string().min(1),
  source_refs: z.array(sourceRefSchema).min(1),
  revision: z.number().int().nonnegative(),
}).strict().superRefine((item, context) => {
  if (!item.source_refs.some((source) => source.source_id === item.primary_source_ref_id)) {
    context.addIssue({
      code: "custom",
      path: ["primary_source_ref_id"],
      message: "primary_source_ref_id must identify one source_refs entry",
    });
  }

  const families = new Set(
    item.source_refs
      .filter((source) => source.family_basis !== "unknown" && source.family_basis !== "reprint")
      .map((source) => source.origin_family_id),
  );
  if (item.evidence_state === "multi_source_confirmed") {
    const hasCorroboration = item.source_refs.some((source) => source.role === "independent_corroboration");
    if (families.size < 2 || !hasCorroboration) {
      context.addIssue({
        code: "custom",
        path: ["source_refs"],
        message: "multi_source_confirmed requires two auditable origin families and independent corroboration",
      });
    }
  }

  const communityOnly = item.source_refs.every((source) => source.role === "community_signal");
  if (communityOnly && !["developing", "unverified"].includes(item.evidence_state)) {
    context.addIssue({
      code: "custom",
      path: ["evidence_state"],
      message: "community-only evidence cannot establish a confirmed fact",
    });
  }
});

const reviewFixtureSchema = z.object({
  review_only: z.literal(true),
  brief_id: z.string().min(1),
  brief_variant_id: z.string().min(1),
  snapshot_id: z.string().min(1),
  rule_set_name: z.literal("evidence_first"),
  rule_set_version: z.string().min(1),
  generated_at: z.string().datetime({ offset: true }),
  revision_notice: z.string().min(1),
  items: z.array(reviewItemSchema).min(1),
}).strict();

const publicSourceRefSchema = sourceRefSchema.omit({
  fetched_at: true,
  origin_family_id: true,
  family_basis: true,
  assignment_confidence: true,
});
const publicReviewSchema = z.object({
  brief_id: z.string().min(1),
  snapshot_id: z.string().min(1),
  brief_variant_id: z.string().min(1),
  rule_set_name: z.string().min(1),
  rule_set_version: z.string().min(1),
  generated_at: z.string().datetime({ offset: true }),
  total_items: z.number().int().nonnegative(),
  source_count: z.number().int().nonnegative(),
  ai_assistance_notice: z.string().min(1),
  revision_notice: z.string().min(1),
  items: z.array(z.object({
    item_id: z.string().min(1),
    story_id: z.string().min(1),
    stable_order: z.number().int().positive(),
    category: z.string().min(1),
    subcategory: z.string().min(1),
    display_title: z.string().min(1),
    priority_level: z.string().min(1),
    reason_codes: z.array(z.string().min(1)),
    evidence_state: z.string().min(1),
    evidence_note: z.string().min(1),
    summary_short: z.string().min(1),
    summary_expanded: z.string().min(1).nullable(),
    uncertainties: z.array(z.string().min(1)),
    tags: z.array(z.string().min(1)),
    primary_source_ref_id: z.string().min(1),
    source_refs: z.array(publicSourceRefSchema).min(1),
    revision: z.number().int().nonnegative(),
  }).strict()),
}).strict();

const projectRoot = path.resolve(import.meta.dirname, "..");
const fixturePath = path.join(projectRoot, "fixtures", "content-model-v2-review.json");
const fixture = reviewFixtureSchema.parse(JSON.parse(fs.readFileSync(fixturePath, "utf8")));

process.env.WEB_MODE = "true";
process.env.CONTENT_MODEL_REVIEW = "true";
process.env.GITHUB_REPOSITORY ||= "gtbwpkwjnb-alt/DailyBrief";

const articles: ArticleInput[] = fixture.items.map((item) => {
  const primary = item.source_refs.find((source) => source.source_id === item.primary_source_ref_id)!;
  return {
    sourceId: primary.source_id,
    source: primary.publisher,
    title: item.original_title,
    displayTitle: item.display_title,
    url: primary.canonical_url,
    publishedAt: primary.published_at ? new Date(primary.published_at) : undefined,
    category: item.category,
    summary: item.summary_expanded ?? item.summary_short,
    tags: item.tags,
    itemId: item.item_id,
    storyId: item.story_id,
    stableOrder: item.stable_order,
    subcategory: item.subcategory,
    summaryShort: item.summary_short,
    summaryExpanded: item.summary_expanded ?? undefined,
    uncertainties: item.uncertainties,
    primarySourceRefId: item.primary_source_ref_id,
    priorityLevel: item.priority_level,
    reasonCodes: item.reason_codes,
    evidenceState: item.evidence_state,
    evidenceNote: item.evidence_note,
    sourceRefs: item.source_refs.map((source) => ({
      sourceId: source.source_id,
      publisher: source.publisher,
      canonicalUrl: source.canonical_url,
      originalTitle: source.original_title,
      publishedAt: source.published_at ? new Date(source.published_at) : undefined,
      fetchedAt: new Date(source.fetched_at),
      role: source.role,
      originFamilyId: source.origin_family_id,
      familyBasis: source.family_basis,
      assignmentConfidence: source.assignment_confidence,
    })),
    revision: item.revision,
  };
});

const sourceIds = new Set(fixture.items.flatMap((item) => item.source_refs.map((source) => source.source_id)));
const publicReview = publicReviewSchema.parse({
  brief_id: fixture.brief_id,
  snapshot_id: fixture.snapshot_id,
  brief_variant_id: fixture.brief_variant_id,
  rule_set_name: fixture.rule_set_name,
  rule_set_version: fixture.rule_set_version,
  generated_at: fixture.generated_at,
  total_items: fixture.items.length,
  source_count: sourceIds.size,
  ai_assistance_notice: "内容由 AI 辅助筛选与精炼，事实判断以具名来源和证据状态为准。",
  revision_notice: fixture.revision_notice,
  items: fixture.items.map((item) => ({
    item_id: item.item_id,
    story_id: item.story_id,
    stable_order: item.stable_order,
    category: item.category,
    subcategory: item.subcategory,
    display_title: item.display_title,
    priority_level: item.priority_level,
    reason_codes: item.reason_codes,
    evidence_state: item.evidence_state,
    evidence_note: item.evidence_note,
    summary_short: item.summary_short,
    summary_expanded: item.summary_expanded,
    uncertainties: item.uncertainties,
    tags: item.tags,
    primary_source_ref_id: item.primary_source_ref_id,
    source_refs: item.source_refs.map((source) => ({
      source_id: source.source_id,
      publisher: source.publisher,
      canonical_url: source.canonical_url,
      original_title: source.original_title,
      published_at: source.published_at,
      role: source.role,
    })),
    revision: item.revision,
  })),
});

const report: DailyReport = {
  hero_headline: "DailyBrief 内容与输出模型 v2 评审",
  daily_overview: "此页面只用于确认公开字段、证据状态、优先级和来源展示。",
  tech_briefs: [],
  finance_briefs: [],
  politics_briefs: [],
  editor_note: "",
  keywords: [],
};

const raw = groupRaw(articles, sources);
const outputDir = path.join(projectRoot, "daily_reports", "review-model-v2");
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(
  path.join(outputDir, "index.html"),
  renderHtml(
    report,
    raw,
    "2026-07-23 · 模型评审",
    [],
    {},
    undefined,
    {
      fetchedSources: sourceIds.size,
      successfulSources: sourceIds.size,
      sourceSuccessRate: 1,
      fetchedArticles: fixture.items.length,
      dedupedArticles: fixture.items.length,
      generatedAt: fixture.generated_at,
      mode: "reuse",
    },
    {
      baseRules: `${fixture.rule_set_name} ${fixture.rule_set_version} · Q/R 门禁 · 独立来源家族 · 公共 U=0 · P0-P4`,
      customKeywords: [],
      mode: "base",
    },
    {
      ruleSetName: fixture.rule_set_name,
      ruleSetVersion: fixture.rule_set_version,
      revisionNotice: fixture.revision_notice,
    },
  ),
  "utf8",
);
fs.writeFileSync(path.join(outputDir, "review-v2.json"), `${JSON.stringify(publicReview, null, 2)}\n`, "utf8");
console.log(`[review-v2] validated fixture and wrote ${outputDir}`);
