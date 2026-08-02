import { jsonrepair } from "jsonrepair";
import { parseConsolidatedResult, type ConsolidatedValue } from "./consolidated-validation";
import { runLlm } from "./llm";
import { extractJson } from "./json-util";
import { REPORT_LOCALE } from "../sources/registry";
import { isHotSearchArticle } from "../editorial/context";

export interface EnrichInput {
  sourceId?: string;
  url: string;
  title: string;
  excerpt?: string;
  source?: string;
  sourceCountry?: string;
  customKeywords?: string[];
}

/** Detect output that is visibly garbled or violates the configured output locale. */
export function looksLikeGarbledAiText(value: string | undefined): boolean {
  const text = value?.trim() ?? "";
  if (!text) return false;
  if (/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return true;
  if (/(?:\?{3,}|\u951f\u65a4\u62f7|\u00c3|\u00c2|\u00e2)/.test(text)) return true;

  // Chinese editions must not silently publish an untranslated all-English summary.
  if (REPORT_LOCALE === "zh") {
    const cjk = (text.match(/[\u3400-\u9FFF]/g) ?? []).length;
    const letters = (text.match(/[A-Za-z]/g) ?? []).length;
    if (text.length >= 36 && cjk === 0 && letters >= 24) return true;
  }
  return false;
}

const GH_SYSTEM_PROMPT_ZH = `你是一名技术编辑，负责为 GitHub Trending 项目写中文介绍。

输入：每个项目有 owner/repo 名 + 一行英文 description（可能没有）。

任务：根据 repo 名和 description，写一段 60-120 字的**通顺中文介绍**，要说清：
  1. 这个项目是做什么的，解决了什么问题
  2. 用了什么技术 / 方法（能从 repo 名 + description 推断的话）
  3. 谁会用它，典型场景是什么

写作风格：
  - 信息密度高，不写"这是一个…"这种废话开头
  - 中文术语优先，技术名词保留英文
  - 不要标题党，事实陈述为主
  - 如果信息不足，宁可短不要编造

输出严格 JSON 对象，不要 markdown：
{
  "summaries": [
    { "url": "<原 url，从输入中精确复制>", "summary": "<60-120 字中文介绍>" },
    ...
  ]
}`;

const GH_SYSTEM_PROMPT_EN = `You are a technical editor writing English summaries for GitHub Trending repositories.

Input: each repo has owner/repo name + a one-line description (may be missing).

Task: write a 60-120 word **fluent English summary** covering:
  1. What the project does and what problem it solves
  2. What technology / approach (inferable from repo name + description)
  3. Who uses it, typical use case

Style:
  - High information density; avoid "This is a..." filler openings
  - Concrete; if info is insufficient, prefer shorter over fabrication
  - Factual statements only, no hype

Output STRICTLY a JSON object, no markdown:
{
  "summaries": [
    { "url": "<exact url from input>", "summary": "<60-120 word English summary>" },
    ...
  ]
}`;

const FINANCE_SYSTEM_PROMPT_ZH = `你是一名中文财经编辑，为英文/中文财经新闻生成**中文事实摘要**。

输入：每条新闻有 url、title、excerpt 和 source（来源媒体名）。

任务：根据 title + excerpt，生成一段 50-100 字的**中文摘要**：
  - 原文是英文 → 翻译关键信息为中文（不是逐字翻译，而是抽出要点）
  - 原文是中文 → 凝练为信息密度更高的中文
  - 必须保留：关键数字（涨跌幅、金额、利率）、机构/公司/人名、地区
  - 必须中性事实陈述，不带情绪、不标题党
  - 信息不足时宁可短，不要编造或扩展

输出严格 JSON 对象，不要 markdown 包裹：
{
  "summaries": [
    { "url": "<原 url，从输入中精确复制>", "summary": "<50-100 字中文摘要>" },
    ...
  ]
}

**引号规则（重要！）**：summary 内的引用一律用中文全角引号「」或""，**绝不**用英文双引号 \" —— 否则会导致 JSON 解析失败。`;

const FINANCE_SYSTEM_PROMPT_EN = `You are an English-language financial / world-news editor producing **factual summaries**.

Input: each news item has url, title, excerpt, and source (publisher name).

Task: from title + excerpt, write a 50-100 word **English summary**:
  - If the source text is non-English, translate the key information (not word-for-word; extract the points)
  - If already English, condense to higher information density
  - Preserve: key numbers (% moves, amounts, rates), institutions / companies / people / regions
  - Neutral factual tone — no emotion, no clickbait
  - If info is insufficient, prefer shorter over fabrication

Output STRICTLY a JSON object, no markdown wrapping:
{
  "summaries": [
    { "url": "<exact url from input>", "summary": "<50-100 word English summary>" },
    ...
  ]
}

**Quote rule (important!)**: For any quotation INSIDE a summary string, use single quotes ' or curly quotes '" — **never** a raw double quote, which breaks JSON parsing.`;

const XVIRAL_SYSTEM_PROMPT_ZH = `你是一名中文 AI 圈编辑，为 X（Twitter）上的爆款 AI 帖子生成**中文摘要**。

输入：每条帖子有 url、title、author（@handle 形式）、previewText（推文开头几句）。

注意 X 帖子的特点：
  - title 经常是博主自己起的标题党，**摘要不要照搬标题**
  - previewText 是推文实际内容开头，**信息源以它为准**
  - 内容多是 prompt 工程 / 工作流 / 工具对比 / 案例分享 / 教程

任务：生成 60-100 字中文摘要，说清楚：
  1. **博主在分享什么**（教程？工作流？踩坑？产品发布？）
  2. **关键数字/工具/概念**（如果有）：如 \"用 Claude Code 月入 4 万美元\"、\"40 条 prompt 模板\"、\"3 个 sub-agent 协作\"
  3. **价值/角度**（如果能推断）：是新发现还是老话题？

写作风格：
  - 信息密度高，不写 \"博主分享了…\" 这种废话开头
  - 中文术语优先，工具名/平台名保留英文（Claude、GPT、Codex、Cursor 等）
  - 不带营销腔，不要 "震惊！" "必看！" 这种标题党
  - 信息不足宁可短，不要硬扩

输出严格 JSON 对象，不要 markdown 包裹：
{
  "summaries": [
    { "url": "<原 url，从输入中精确复制>", "summary": "<60-100 字中文摘要>" },
    ...
  ]
}

**引号规则（重要！）**：summary 内的引用一律用中文全角引号「」或""，**绝不**用英文双引号 \" —— 否则会导致 JSON 解析失败。`;

const XVIRAL_SYSTEM_PROMPT_EN = `You are an editor producing **English summaries** of viral AI-related X (Twitter) posts.

Input: each post has url, title, author (@handle), and previewText (first lines of the tweet).

X-post patterns:
  - title is often the author's clickbait headline — **do not just rephrase the title**
  - previewText is the actual tweet opening — **treat it as the source of truth**
  - typical content: prompt engineering / workflows / tool comparisons / case studies / tutorials

Task: write a 60-100 word English summary covering:
  1. **What the author is sharing** (tutorial? workflow? gotcha? product launch?)
  2. **Key numbers / tools / concepts** (if present): e.g. "\$40k/month with Claude Code", "40 prompt templates", "3 sub-agents collaborating"
  3. **Angle / value** (if inferable): novel finding or established take?

Style:
  - High information density; avoid "The author shares..." filler
  - Keep tool / platform names in original case (Claude, GPT, Codex, Cursor, etc.)
  - No marketing tone; no "Mind-blowing!" / "Must-read!" hype
  - If info is insufficient, prefer shorter over fabrication

Output STRICTLY a JSON object, no markdown wrapping:
{
  "summaries": [
    { "url": "<exact url from input>", "summary": "<60-100 word English summary>" },
    ...
  ]
}

**Quote rule (important!)**: For any quotation INSIDE a summary string, use single quotes ' or curly quotes '" — **never** a raw double quote, which breaks JSON parsing.`;

const PAPERS_SYSTEM_PROMPT_ZH = `你是一名 AI 研究方向的中文编辑，为 HuggingFace 上的热门论文写**中文摘要**。

输入：每篇论文有 url、title（英文标题）、excerpt（英文摘要开头）。

任务：根据 title + excerpt，写一段 60-110 字的**中文摘要**，说清：
  1. 这篇论文解决什么问题 / 提出什么方法
  2. 核心技术思路（模型、训练方式、数据等，能从摘要推断的话）
  3. 关键结果或贡献（有量化指标就保留，如准确率、加速比）

写作风格：
  - 信息密度高，不写"这篇论文…"这种废话开头
  - 中文表达，专业术语 / 模型名 / 方法名保留英文（Transformer、RLHF、CoT、MoE 等）
  - 事实陈述，不夸大、不标题党
  - 信息不足宁可短，不要编造

输出严格 JSON 对象，不要 markdown：
{
  "summaries": [
    { "url": "<原 url，从输入中精确复制>", "summary": "<60-110 字中文摘要>" },
    ...
  ]
}

**引号规则（重要！）**：summary 内的引用一律用中文全角引号「」或""，**绝不**用英文双引号 \" —— 否则会导致 JSON 解析失败。`;

const PAPERS_SYSTEM_PROMPT_EN = `You are an AI-research editor writing **English summaries** of trending HuggingFace papers.

Input: each paper has url, title, and excerpt (start of the English abstract).

Task: from title + excerpt, write a 60-110 word **English summary** covering:
  1. What problem the paper tackles / what method it proposes
  2. The core technical approach (model, training method, data — if inferable)
  3. Key result or contribution (keep quantitative metrics if present)

Style:
  - High information density; avoid "This paper..." filler openings
  - Keep model / method names in original form (Transformer, RLHF, CoT, MoE, etc.)
  - Factual, no hype
  - If info is insufficient, prefer shorter over fabrication

Output STRICTLY a JSON object, no markdown:
{
  "summaries": [
    { "url": "<exact url from input>", "summary": "<60-110 word English summary>" },
    ...
  ]
}

**Quote rule (important!)**: For any quotation INSIDE a summary string, use single quotes ' or curly quotes '" — **never** a raw double quote, which breaks JSON parsing.`;

const POLITICS_SYSTEM_PROMPT_ZH = `你是一名中文国际新闻编辑，为各国时政新闻生成**中文事实摘要**。

输入：每条新闻有 url、title、excerpt 和 source（来源媒体名）。

任务：根据 title + excerpt，生成一段 50-90 字的**中文摘要**：
  - 原文是英文 → 翻译关键信息为中文，抽出事件要点
  - 原文是中文 → 凝练为信息密度更高的中文
  - 必须保留：人物/机构名、国家/地区、关键数字、条约/法令名称
  - 清晰陈述事件核心：谁、什么行动、影响或后果
  - 中性事实陈述，不带立场、不标题党
  - 信息不足时宁可短，不要编造或扩展

输出严格 JSON 对象，不要 markdown 包裹：
{
  "summaries": [
    { "url": "<原 url，从输入中精确复制>", "summary": "<50-90 字中文摘要>" },
    ...
  ]
}

**引号规则（重要！）**：summary 内的引用一律用中文全角引号「」或""，**绝不**用英文双引号 \" —— 否则会导致 JSON 解析失败。`;

const POLITICS_SYSTEM_PROMPT_EN = `You are an English-language international-news editor producing **factual summaries** of world politics.

Input: each news item has url, title, excerpt, and source (publisher name).

Task: from title + excerpt, write a 50-90 word **English summary** covering:
  - Who, what action, what impact or consequence
  - Preserve: people/organization names, countries/regions, key numbers, treaty/act names
  - If the source text is non-English, translate the key information (not word-for-word)
  - Neutral factual tone — no bias, no clickbait
  - If info is insufficient, prefer shorter over fabrication

Output STRICTLY a JSON object, no markdown wrapping:
{
  "summaries": [
    { "url": "<exact url from input>", "summary": "<50-90 word English summary>" },
    ...
  ]
}

**Quote rule (important!)**: For any quotation INSIDE a summary string, use single quotes ' or curly quotes '" — **never** a raw double quote, which breaks JSON parsing.`;

const TRENDING_SYSTEM_PROMPT_ZH = `你是一名中文编辑，负责将英文热搜关键词和帖子标题翻译为中文，并附上简短说明。

输入：每条包含 url、title（英文关键词或标题）、excerpt（可能的说明文字）和 source（来源名称）。

任务：
  - 对于 Google Trends 关键词：将英文关键词翻译为中文，并在摘要中说明该词为何热门（如能推断）。即使 excerpt 为空，也至少有"<中文翻译>热搜词"这样的翻译说明
  - 对于 Reddit 热门帖子：将英文标题翻译为中文，并根据 excerpt 写 30-60 字中文摘要
  - 原文已含中文的条目，直接凝练摘要
  - 必须保留关键数字、人名、产品名、地名
  - 中性事实陈述

**重要：必须为输入的每一条目都生成 summary，不允许遗漏。** 即使只有标题没有说明文字，也要至少给出中文翻译。

输出严格 JSON 对象，不要 markdown 包裹：
{
  "summaries": [
    { "url": "<原 url，从输入中精确复制>", "summary": "<30-80 字中文说明>" },
    ...
  ]
}

**引号规则（重要！）**：summary 内的引用一律用中文全角引号「」或""，**绝不**用英文双引号 " —— 否则会导致 JSON 解析失败。`;

const TRENDING_SYSTEM_PROMPT_EN = `You are an editor producing **English summaries** of trending search keywords and popular posts.

Input: each item has url, title (keyword or post title in English), excerpt (optional description), and source.

Task:
  - For Google Trends keywords: write a brief explanation of what the keyword refers to and why it's trending (if inferable)
  - For Reddit popular posts: write a 30-60 word summary based on title and excerpt
  - Preserve key numbers, names, product names, locations
  - Neutral factual tone

Output STRICTLY a JSON object, no markdown wrapping:
{
  "summaries": [
    { "url": "<exact url from input>", "summary": "<30-80 word English explanation>" },
    ...
  ]
}

**Quote rule (important!)**: For any quotation INSIDE a summary string, use single quotes ' or curly quotes '" — **never** a raw double quote, which breaks JSON parsing.`;

const TAG_SYSTEM_PROMPT_ZH = `你是一名新闻标签提炼师。为每条新闻生成**3-5 个内容标签**。

输入：每条新闻有 url、title、summary（AI 精炼的中文摘要）、source（来源媒体名）。

标签体系为**半自由式**：
1. **基础分类标签（必选，1-2 个）**：从以下高频认知分类中选取最贴切的 1-2 个：
   政治、经济、科技、体育、娱乐、军事、社会、教育、健康、环境、国际、财经、文化
2. **内容精炼标签（自由，2-3 个）**：从内容中自然提炼的具体标签，信息密度高，能区分本条新闻和同类新闻的不同

要求：
  - 基础分类标签在前，内容精炼标签在后
  - 每个标签 1-6 个字
  - 内容精炼标签示例：「中美关税」 「5nm芯片」 「美联储加息」 「俄乌和谈」 「GPT-5」 「TikTok禁令」 「世界杯」 「票房黑马」
  - 不要编造标签，只根据实际内容推断
  - 不要带空格，不要带引号
  - 标签顺序：从广到窄（如：科技 > AI > 开源模型）

输出严格 JSON 对象，不要 markdown：
{
  "items": [
    { "url": "<原 url，从输入中精确复制>", "tags": ["科技", "AI", "开源模型"] },
    ...
  ]
}`;

const TAG_SYSTEM_PROMPT_EN = `You are a news tag refiner. For each news item, generate **3-5 content tags**.

Input: each item has url, title, summary (AI-refined English summary), and source.

Tag system: **semi-structured**.
1. **Base category tags (required, 1-2)**: Pick 1-2 from these widely-recognized categories:
   Politics, Economy, Technology, Sports, Entertainment, Military, Society, Education, Health, Environment, International, Finance, Culture
2. **Content-specific tags (free-form, 2-3)**: Naturally extracted from content, high information density, differentiate this item from others in the same category

Guidelines:
  - Base categories first, specific tags after
  - Each tag 1-4 words
  - Content tag examples: US-China-tariffs, 5nm-chip, Fed-rate-hike, Ukraine-peace, GPT-5, TikTok-ban, World-Cup, blockbuster
  - Don't fabricate — only infer from actual content
  - No spaces, no quotes within tags
  - Order: broad to narrow (e.g., Technology > AI > open-source)

Output STRICTLY a JSON object, no markdown:
{
  "items": [
    { "url": "<exact url from input>", "tags": ["Technology", "AI", "open-source"] },
    ...
  ]
}`;

// Pick the right localized prompt set at module init. Each enricher reaches
// in via PROMPTS.<key> so the call sites stay locale-agnostic.
const PROMPTS =
  REPORT_LOCALE === "en"
    ? { gh: GH_SYSTEM_PROMPT_EN, finance: FINANCE_SYSTEM_PROMPT_EN, politics: POLITICS_SYSTEM_PROMPT_EN, xViral: XVIRAL_SYSTEM_PROMPT_EN, papers: PAPERS_SYSTEM_PROMPT_EN, trending: TRENDING_SYSTEM_PROMPT_EN, tags: TAG_SYSTEM_PROMPT_EN }
    : { gh: GH_SYSTEM_PROMPT_ZH, finance: FINANCE_SYSTEM_PROMPT_ZH, politics: POLITICS_SYSTEM_PROMPT_ZH, xViral: XVIRAL_SYSTEM_PROMPT_ZH, papers: PAPERS_SYSTEM_PROMPT_ZH, trending: TRENDING_SYSTEM_PROMPT_ZH, tags: TAG_SYSTEM_PROMPT_ZH };

const USER_PROMPT_HEADER =
  REPORT_LOCALE === "en"
    ? (n: number) => `Candidate items (${n} entries, JSON array):`
    : (n: number) => `候选条目（共 ${n} 条，JSON 数组）：`;
const USER_PROMPT_FOOTER =
  REPORT_LOCALE === "en"
    ? `Output \`{"summaries": [{"url": ..., "summary": ...}, ...]}\` — url must be copied exactly from input.`
    : `请输出 {"summaries": [{"url": ..., "summary": ...}, ...]}，url 必须精确回填输入值。`;

/**
 * Enrichment timeout — lowered from 240s to 80s because most enrich calls
 * complete in 30-60s. The 240s budget was a major contributor to total
 * pipeline time when multiple enrichments ran serially.
 */
const ENRICH_TIMEOUT_MS = 80_000;

/**
 * Run a single enrichment LLM call with 1 retry and exponential back-off.
 * First attempt: timeout = ENRICH_TIMEOUT_MS. On failure, retry once after
 * 10s delay (to let transient provider errors clear).
 */
async function runEnrichmentOnce(
  payload: unknown[],
  systemPrompt: string,
  userPrompt: string,
  scope: string,
  timeoutMs: number,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  const { text } = await runLlm({
    systemPrompt,
    userPrompt,
    timeoutMs,
  });
  const cleaned = extractJson(text);

  let parsed: { summaries?: Array<{ url?: string; summary?: string }> };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = JSON.parse(jsonrepair(cleaned));
  }

  for (const s of parsed.summaries ?? []) {
    if (s.url && s.summary) result.set(s.url, s.summary.trim());
  }

  // Diagnostic: if we got back substantially fewer entries than asked for,
  // dump the raw LLM output so the cause is visible without re-running.
  if (result.size < payload.length / 2 && payload.length >= 3) {
    try {
      const fs = await import("node:fs");
      fs.mkdirSync("logs", { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const tag = scope.replace(/[^a-z0-9]/gi, "-");
      fs.writeFileSync(
        `logs/enrich-undercount-${tag}-${ts}.txt`,
        `scope=${scope}\nrequested=${payload.length}\nreturned=${result.size}\n\n--- raw LLM output ---\n${text}`,
        "utf8",
      );
      console.warn(
        `[enrich] ${scope}: undercount ${result.size}/${payload.length} — raw dumped to logs/enrich-undercount-${tag}-${ts}.txt`,
      );
    } catch {
      // Can't write log (read-only fs?) — non-fatal, just skip.
    }
  }

  return result;
}

async function runEnrichment(
  payload: unknown[],
  systemPrompt: string,
  scope: string,
): Promise<Map<string, string>> {
  // Sonnet has a strong "match input language" reflex — when items contain
  // English titles + Chinese-tinted source names (or just a Chinese-leaning
  // RLHF default), system-prompt-only language constraints get ignored. Pin
  // the output language as the first line of the *user* prompt for recency.
  const langHeader =
    REPORT_LOCALE === "en"
      ? "**Output language: ENGLISH ONLY.** Every summary string must be written entirely in English, even if the input title or description contains Chinese."
      : "**输出语言：仅中文。** 每个 summary 字段必须全部是中文，即使输入条目是英文。";
  const userPrompt = [
    langHeader,
    "",
    REPORT_LOCALE === "en"
      ? "Every item must contain displayTitle, summary, tags, and importance."
      : "每个 item 必须包含 displayTitle、summary、tags、importance。",
    USER_PROMPT_HEADER(payload.length),
    JSON.stringify(payload),
    "",
    USER_PROMPT_FOOTER,
  ].join("\n");

  // Attempt 1
  try {
    return await runEnrichmentOnce(payload, systemPrompt, userPrompt, scope, ENRICH_TIMEOUT_MS);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[enrich] ${scope} attempt 1 failed: ${msg} — retrying in 10s…`);
  }

  // Retry after 10s back-off
  await new Promise((r) => setTimeout(r, 10_000));
  try {
    return await runEnrichmentOnce(payload, systemPrompt, userPrompt, scope, ENRICH_TIMEOUT_MS);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[enrich] ${scope} attempt 2 also failed: ${msg}`);
  }

  return new Map();
}

/**
 * Generate Chinese summaries for a batch of GitHub Trending repos in
 * a single Claude CLI call. Failures are non-fatal — caller gets an
 * empty map and the rendering simply omits summaries.
 */
export async function enrichGithubTrendingSummaries(
  items: EnrichInput[],
): Promise<Map<string, string>> {
  if (items.length === 0) return new Map();
  const payload = items.map((it) => ({
    url: it.url,
    repo: it.title,
    description: (it.excerpt ?? "").slice(0, 200),
  }));
  return runEnrichment(payload, PROMPTS.gh, "GH summaries");
}

/**
 * Generate Chinese factual summaries for the (up to ~50) finance news
 * items that will be shown in the raw panel. One Sonnet call covers
 * the whole batch.
 */
export async function enrichFinanceNewsSummaries(
  items: EnrichInput[],
): Promise<Map<string, string>> {
  if (items.length === 0) return new Map();
  const payload = items.map((it) => ({
    url: it.url,
    title: it.title,
    source: it.source ?? "",
    excerpt: (it.excerpt ?? "").slice(0, 280),
  }));
  return runEnrichment(payload, PROMPTS.finance, "finance summaries");
}

/**
 * Generate Chinese summaries for viral X posts. Different prompt from
 * finance because X tweets are usually clickbait titles + first-person
 * tutorial / case-study text — the model needs to dig past the headline.
 */
export async function enrichXViralSummaries(
  items: Array<EnrichInput & { author?: string }>,
): Promise<Map<string, string>> {
  if (items.length === 0) return new Map();
  const payload = items.map((it) => ({
    url: it.url,
    title: it.title,
    author: it.author ?? "",
    previewText: (it.excerpt ?? "").slice(0, 280),
  }));
  return runEnrichment(payload, PROMPTS.xViral, "X-viral summaries");
}

/**
 * Generate summaries for trending HuggingFace papers. Separate prompt
 * from finance/GH because papers need a problem/method/result framing
 * and the excerpt is an English research abstract.
 */
export async function enrichTrendingPapersSummaries(
  items: EnrichInput[],
): Promise<Map<string, string>> {
  if (items.length === 0) return new Map();
  const payload = items.map((it) => ({
    url: it.url,
    title: it.title,
    excerpt: (it.excerpt ?? "").slice(0, 300),
  }));
  return runEnrichment(payload, PROMPTS.papers, "papers summaries");
}

/**
 * Generate Chinese summaries for trending content (Google Trends keywords,
 * Reddit popular posts). Translates English keywords/titles to Chinese
 * so the raw panel shows Chinese descriptions alongside original links.
 */
export async function enrichTrendingSummaries(
  items: EnrichInput[],
): Promise<Map<string, string>> {
  if (items.length === 0) return new Map();
  const payload = items.map((it) => ({
    url: it.url,
    title: it.title,
    source: it.source ?? "",
    excerpt: (it.excerpt ?? "").slice(0, 280),
  }));
  return runEnrichment(payload, PROMPTS.trending, "trending summaries");
}

/**
 * Generate Chinese summaries for politics/world-news items. Uses a dedicated
 * politics prompt (rather than the finance prompt) so the LLM treats
 * diplomatic, military, and geopolitical content with appropriate framing.
 */
export async function enrichPoliticsSummaries(
  items: EnrichInput[],
): Promise<Map<string, string>> {
  if (items.length === 0) return new Map();
  const payload = items.map((it) => ({
    url: it.url,
    title: it.title,
    source: it.source ?? "",
    excerpt: (it.excerpt ?? "").slice(0, 280),
  }));
  return runEnrichment(payload, PROMPTS.politics, "politics summaries");
}

/**
 * Batch-tag all articles that already have AI summaries.
 * Uses a single LLM call to generate content attribute tags for every
 * enriched article at once, so the tag set is self-consistent across sources.
 *
 * Each article gets 2-5 tags (e.g. ["政治","外交","中美关系"]) that describe
 * the content's nature, domain, and key attributes — enabling retrieval,
 * filtering, and cross-referencing in an Obsidian knowledge base.
 *
 * Articles without summaries (zh-only sources) are skipped since the LLM
 * has no refined content to classify.
 */
export async function enrichContentTags(
  items: EnrichInput[],
): Promise<Map<string, string[]>> {
  if (items.length === 0) return new Map();
  const payload = items.map((it) => ({
    url: it.url,
    title: it.title,
    summary: (it.excerpt ?? "").slice(0, 200),
    source: it.source ?? "",
  }));

  const langHeader =
    REPORT_LOCALE === "en"
      ? "**Output language: ENGLISH ONLY.** Tags must be in English."
      : "**输出语言：仅中文。** 标签必须全部用中文，不要中英混写。";
  const userPrompt = [
    langHeader,
    "",
    `候选条目（共 ${payload.length} 条，JSON 数组）：`,
    JSON.stringify(payload),
    "",
    '请输出 {"items": [{"url": ..., "tags": [...]}, ...]}，url 必须精确回填输入值，tags 是 2-5 个字符串的数组。',
  ].join("\n");

  const result = new Map<string, string[]>();

  // Attempt 1
  try {
    const { text } = await runLlm({
      systemPrompt: PROMPTS.tags,
      userPrompt,
      timeoutMs: ENRICH_TIMEOUT_MS,
    });
    const cleaned = extractJson(text);

    let parsed: { items?: Array<{ url?: string; tags?: string[] }> };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = JSON.parse(jsonrepair(cleaned));
    }

    for (const s of parsed.items ?? []) {
      if (s.url && s.tags && s.tags.length > 0) {
        result.set(s.url, s.tags.map((t) => t.trim()).filter(Boolean));
      }
    }

    if (result.size < payload.length / 2 && payload.length >= 3) {
      try {
        const fs = await import("node:fs");
        fs.mkdirSync("logs", { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        fs.writeFileSync(
          `logs/enrich-tags-undercount-${ts}.txt`,
          `requested=${payload.length}\nreturned=${result.size}\n\n--- raw LLM output ---\n${text}`,
          "utf8",
        );
        console.warn(
          `[enrich] tags: undercount ${result.size}/${payload.length} — raw dumped to logs/enrich-tags-undercount-${ts}.txt`,
        );
      } catch {
        // non-fatal
      }
    }

    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[enrich] tags attempt 1 failed: ${msg} — retrying in 10s…`);
  }

  // Retry after 10s back-off
  await new Promise((r) => setTimeout(r, 10_000));
  try {
    const { text } = await runLlm({
      systemPrompt: PROMPTS.tags,
      userPrompt,
      timeoutMs: ENRICH_TIMEOUT_MS,
    });
    const cleaned = extractJson(text);

    let parsed: { items?: Array<{ url?: string; tags?: string[] }> };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = JSON.parse(jsonrepair(cleaned));
    }

    for (const s of parsed.items ?? []) {
      if (s.url && s.tags && s.tags.length > 0) {
        result.set(s.url, s.tags.map((t) => t.trim()).filter(Boolean));
      }
    }

    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[enrich] tags attempt 2 also failed: ${msg}`);
  }

  return result;
}

// ----- Category-level summaries -----

const CATEGORY_SUMMARY_SYSTEM_PROMPT_ZH = (categoryName: string) => `你是一名中文编辑，为「${categoryName}」板块撰写今日要点总结。

输入：该板块下所有条目，每条有标题、来源、AI摘要和标签。

任务：写一段 80-150 字的今日要点总结：
  - 提炼 2-3 个最重要的主题或趋势
  - 指出该板块今日的总体方向（如：科技板块以 AI 发布为主、财经板块以加息预期为主等）
  - 语言精炼，不说废话
  - 只基于输入内容，不要编造

输出严格 JSON 对象，不要 markdown：
{
  "summary": "<80-150 字总结>"
}`;

const CATEGORY_SUMMARY_SYSTEM_PROMPT_EN = (categoryName: string) => `You are an editor writing a daily highlights summary for the "${categoryName}" section.

Input: all items in this section, each with title, source, AI summary and tags.

Task: write an 80-150 word highlights summary:
  - Extract 2-3 most important themes or trends
  - Note the overall direction (e.g., "Tech dominated by AI releases", "Finance focused on rate hike expectations")
  - Concise, no filler
  - Based only on the input content

Output STRICTLY a JSON object, no markdown:
{
  "summary": "<80-150 word summary>"
}`;

const CATEGORY_SUMMARY_PROMPTS =
  REPORT_LOCALE === "en" ? CATEGORY_SUMMARY_SYSTEM_PROMPT_EN : CATEGORY_SUMMARY_SYSTEM_PROMPT_ZH;

/**
 * Generate a category-level AI summary/highlights for a given category.
 * Takes all articles in the category (with their AI summaries already set),
 * calls the LLM once to produce a concise 80-150 word/char overview.
 *
 * Returns the summary text, or empty string on failure.
 */
export async function enrichCategorySummary(
  categoryName: string,
  items: EnrichInput[],
): Promise<string> {
  if (items.length === 0) return "";
  try {
    const langHeader =
      REPORT_LOCALE === "en"
        ? "**Output language: ENGLISH ONLY.**"
        : "**输出语言：仅中文。**";
    const userPrompt = [
      langHeader,
      "",
      `以下为今日「${categoryName}」板块的所有条目（共 ${items.length} 条）：`,
      JSON.stringify(items.map((it) => ({
        url: it.url,
        title: it.title,
        source: it.source ?? "",
        summary: (it.excerpt ?? "").slice(0, 200),
      }))),
      "",
      '请输出 {"summary": "<总结内容>"}',
    ].join("\n");

    const { text } = await runLlm({
      systemPrompt: CATEGORY_SUMMARY_PROMPTS(categoryName),
      userPrompt,
      timeoutMs: 30_000,
    });
    const cleaned = extractJson(text);
    const parsed: { summary?: string } = JSON.parse(cleaned);
    return (parsed.summary ?? "").trim();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[enrich] category summary for "${categoryName}" failed: ${msg}`);
    return "";
  }
}

// ----- Consolidated enrichment (replaces 8 separate calls) -----

const CONSOLIDATED_SYSTEM_PROMPT_ZH = `你是一名AI编辑，负责对新闻资讯进行中文优化处理。

输入：每条包含 url、title、excerpt（可能的原文）、source（来源）和 category（分类）。

任务：对每一条目执行以下七项操作：

**1. 精炼摘要（必需）**
- title 和 excerpt 是唯一事实依据；只能重述输入明确提供的信息，不得根据人物常识、外部知识或标题联想补充事实
- 如果原文是英文 → 翻译为中文精炼摘要（50-90字），保留关键数字、人名、机构名、地名
- 如果原文是中文 → 直接精炼摘要（50-90字），提高信息密度
- GitHub 项目 → 说明项目做什么、用什么技术、解决什么问题
- X 推文 → 不照搬标题党 title，以内容为准确认博主的分享点
- 论文 → 说明解决的问题、方法、关键结果
- Google/微博/百度热搜关键词 → 必须回答原始搜索词指什么、来自哪个地区/平台、关联报道或输入背景是什么、为什么在此时走红。禁止只写“成为热搜”“搜索热度上升”
- 热搜走红原因只能依据 excerpt 中的关联报道或描述；证据不足时明确标记信息不足，不得凭常识猜测
- 即使信息不足，也至少有标题的中文翻译，**不允许遗漏任何条目**
- 原文没有提供死亡、逮捕、比分、日期、辞职、停火等细节时，绝对不要写出这些结论

**2. AI 启发式评价（必需）**
- aiAnalysis 用一句 35-70 字中文完成，不重复摘要
- 从用户相关性、行业/市场影响、技术扩散、社会行为、风险与不确定性中选择 1-2 个最有价值维度
- 推断必须使用“可能、意味着、值得关注”等边界词，不得把推断写成事实

**3. 中文展示标题（必需）**
- displayTitle 必须是 12-30 字的中文标题，准确翻译或改写输入 title
- 产品名、公司名、模型名可保留英文；不要保留整句英文标题

**4. 内容标签（必需）**
- 分配 3-5 个内容标签，前 1-2 个为基础分类（政治/经济/科技/体育/娱乐/军事/社会/教育/健康/环境/国际/财经/文化），后 2-3 个为具体内容标签
- 标签从广到窄排序
- 纯中文，不需要空格

**5. 重要度评分（必需）**
- 1-10 分，作为编辑排序参考，不代表事实可信度；综合新闻影响力、时效性、与目标读者的相关性
- 1-3：影响范围有限、信息不足或与读者弱相关；4-6：一般行业动态或区域性关注；7-8：对较多读者有明确、近期影响；9-10：罕见，仅用于已由输入明确支持的重大、广泛且紧迫事件
- Google/微博/百度热搜仅表示关注度变化，上榜本身不得高于 5 分；只有输入明确给出广泛现实影响时才能提高

**6. 国际时政归属（必需）**
- coverageCountries 只能填写标题或原文明确提到的国家/地区，最多 4 个；没有明确提及时返回空数组
- sourceCountry 是媒体所属国，不等于 coverageCountries；不要把媒体所属国当成新闻发生国

**7. 用户兴趣增量（必需）**
- interestMatches 只能从输入 customKeywords 原样选择明确相关的关键词，没有命中则返回空数组

输出严格 JSON 对象，不要 markdown 包裹：
{
  "items": [
    {
      "url": "<原 url，精确复制>",
      "displayTitle": "<12-30 字中文标题>",
      "summary": "<50-90 字中文精炼摘要>",
      "aiAnalysis": "<35-70 字中文启发式评价>",
      "tags": ["科技", "AI", "开源模型"],
      "importance": 7,
      "coverageCountries": [],
      "interestMatches": []
    },
    ...
  ]
}

**引号规则**：summary 内的引用用中文全角引号「」，绝不使用英文双引号。标签不加引号。`;

const CONSOLIDATED_SYSTEM_PROMPT_EN = `You are an AI editor producing English-optimized news summaries.

Input: each item has url, title, excerpt, source, and category.

Task: for each item, do all seven:

**1. Refined summary (required)**
- title and excerpt are the sole evidence; restate only information explicitly present in them, never add outside knowledge or infer facts from a name
- If content is non-English → translate key info to English (50-90 words)
- If already English → condense to higher density (50-90 words)
- Keep: key numbers, people/institution names, locations
- GitHub repos → what it does, tech, problem solved
- X posts → ignore clickbait title, extract the actual claim
- Papers → problem, method, key result
- Google Trends / hot-search keywords → identify what the query means, its region/platform, the associated report or input context, and why interest is rising now. Never output only that it is trending
- Infer a trend cause only from the supplied excerpt or associated coverage; state when evidence is insufficient
- **Do NOT skip any item. Every item must have a summary.**
- If the input does not state a death, arrest, score, date, resignation, or ceasefire, do not assert one.

**2. One-sentence AI analysis (required)**
- aiAnalysis must be 25-55 words and must not repeat the summary
- Select 1-2 useful dimensions: user relevance, industry/market impact, technology diffusion, social behavior, risk, or uncertainty
- Mark inference with boundary language such as may, suggests, or worth watching

**3. Display title (required)**
- displayTitle must be a concise 8-16 word title in English
- Translate non-English titles; retain product, company, and model names where appropriate

**4. Content tags (required)**
- 3-5 tags per item: 1-2 base category (Politics/Economy/Technology/Sports/Entertainment/Military/Society/Education/Health/Environment/International/Finance/Culture) + 2-3 specific tags
- Order: broad to narrow

**5. Importance score (required)**
- 1-10 editorial ranking aid, not factual confidence; combine impact, timeliness, and reader relevance
- 1-3: limited reach, sparse information, or weak relevance; 4-6: routine industry or regional interest; 7-8: clear recent impact on many readers; 9-10: rare, only for major, broad, urgent events explicitly supported by the input
- A Google or social hot-search ranking is only an attention signal and must not score above 5 by itself; raise it only when the input explicitly supports broad real-world impact

**6. World-news geography (required)**
- coverageCountries may contain only countries or regions explicitly present in the title or source text, max 4; use [] when unclear
- sourceCountry is the publisher's country and is not the same as coverageCountries

**7. Incremental user interest (required)**
- interestMatches may only copy clearly relevant values from the input customKeywords; use [] when none match

Output STRICTLY a JSON object, no markdown:
{
  "items": [
    {
      "url": "<exact url from input>",
      "displayTitle": "<8-16 word English title>",
      "summary": "<50-90 word English summary>",
      "aiAnalysis": "<25-55 word one-sentence analysis>",
      "tags": ["Technology", "AI", "open-source"],
      "importance": 7,
      "coverageCountries": [],
      "interestMatches": []
    },
    ...
  ]
}

**Quote rule**: Use single quotes or curly quotes inside summaries — never raw double quotes. No quotes on tags.`;

const CONSOLIDATED_PROMPTS =
  REPORT_LOCALE === "en" ? CONSOLIDATED_SYSTEM_PROMPT_EN : CONSOLIDATED_SYSTEM_PROMPT_ZH;

type ConsolidatedEnrichment = {
  displayTitle?: string;
  summary: string;
  aiAnalysis?: string;
  tags: string[];
  importance: number;
  coverageCountries: string[];
  interestMatches: string[];
};

export type EnrichmentStopReason = "budget" | "empty_response";

export type EnrichmentControl = {
  deadlineAt: number;
  perCallTimeoutMs: number;
  emptyFailureThreshold: number;
  maxAttemptsPerUrl: number;
  consecutiveEmptyFailures: number;
  attemptsByUrl: Map<string, number>;
  circuitOpen: boolean;
  reason?: EnrichmentStopReason;
  now: () => number;
};

type EnrichmentControlOptions = {
  budgetMs?: number;
  perCallTimeoutMs?: number;
  emptyFailureThreshold?: number;
  maxAttemptsPerUrl?: number;
  now?: () => number;
};

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createEnrichmentControl(options: EnrichmentControlOptions = {}): EnrichmentControl {
  const now = options.now ?? Date.now;
  const budgetMs = options.budgetMs
    ?? positiveNumber(process.env.AI_ENRICH_BUDGET_MS, 7 * 60_000);
  return {
    deadlineAt: now() + budgetMs,
    perCallTimeoutMs: options.perCallTimeoutMs
      ?? positiveNumber(process.env.AI_ENRICH_CALL_TIMEOUT_MS, 60_000),
    emptyFailureThreshold: options.emptyFailureThreshold
      ?? positiveNumber(process.env.AI_ENRICH_EMPTY_FAILURES, 3),
    maxAttemptsPerUrl: options.maxAttemptsPerUrl ?? 3,
    consecutiveEmptyFailures: 0,
    attemptsByUrl: new Map(),
    circuitOpen: false,
    now,
  };
}

export type ConsolidatedEnrichOptions = {
  customKeywords?: string[];
  control?: EnrichmentControl;
  /** Test seam; production uses the configured LLM dispatcher. */
  run?: typeof runLlm;
};

export function isLowInformationHotSearch(item: EnrichInput, value: ConsolidatedEnrichment): boolean {
  if (!item.sourceId || !isHotSearchArticle(item.sourceId)) return false;
  const context = item.excerpt?.trim() ?? "";
  const summary = value.summary.trim();
  if (context.length < 20) return true;
  if (/暂无具体内容|具体原因待核验|仅确认搜索热度|成为.{0,12}热搜(?:话题|词)?[，。；]?搜索热度上升?/.test(summary)) return true;
  return summary.length < 35
    || !/(?:因|由于|源于|关联|围绕|报道|发布|比赛|交易|事件|争议|节目|政策|产品|声明|调查)/.test(summary);
}

function needsConsolidatedRepair(item: EnrichInput, value: ConsolidatedEnrichment | undefined): boolean {
  return !value?.displayTitle
    || !value.summary
    || !value.aiAnalysis
    || looksLikeGarbledAiText(value.summary)
    || looksLikeGarbledAiText(value.aiAnalysis)
    || isLowInformationHotSearch(item, value);
}

/**
 * One-pass enrichment for a batch of articles in the same category.
 * Replaces: enrichTrendingSummaries + enrichFinanceNewsSummaries +
 * enrichPoliticsSummaries + enrichGithubTrendingSummaries +
 * enrichTrendingPapersSummaries + enrichXViralSummaries +
 * enrichAiNews + enrichContentTags.
 *
 * Single LLM call handles: translation, refinement, tagging, and importance scoring.
 */
export async function consolidatedEnrich(
  categoryLabel: string,
  items: EnrichInput[],
  options: ConsolidatedEnrichOptions = {},
): Promise<Map<string, ConsolidatedEnrichment>> {
  if (items.length === 0) return new Map();
  const control = options.control ?? createEnrichmentControl();
  const sharedOptions = { ...options, control };
  if (!canStartEnrichment(control)) return new Map();

  const batchSize = 15;
  if (items.length > batchSize) {
    const batched = new Map<string, ConsolidatedEnrichment>();
    for (let i = 0; i < items.length; i += batchSize) {
      if (!canStartEnrichment(control)) break;
      const partial = await consolidatedEnrich(categoryLabel, items.slice(i, i + batchSize), sharedOptions);
      for (const [url, value] of partial) batched.set(url, value);
    }
    return batched;
  }

  const result = new Map<string, ConsolidatedEnrichment>();
  const run = options.run ?? runLlm;
  const merge = (values: Map<string, ConsolidatedEnrichment>) => {
    for (const [url, value] of values) result.set(url, value);
  };

  const langHeader =
    REPORT_LOCALE === "en"
      ? "**Output language: ENGLISH ONLY.** Every displayTitle and summary must be in English."
      : "**输出语言：仅中文。** 每个 displayTitle 和 summary 必须全部是中文。";

  const userPrompt = [
    langHeader,
    "",
    `以下为今日「${categoryLabel}」板块的 ${items.length} 条条目：`,
    JSON.stringify(items.map((it) => ({
      sourceId: it.sourceId ?? "",
      url: it.url,
      title: it.title,
      excerpt: (it.excerpt ?? "").slice(0, 250),
      source: it.source ?? "",
      sourceCountry: it.sourceCountry ?? "",
      customKeywords: options.customKeywords ?? it.customKeywords ?? [],
      category: categoryLabel,
    }))),
    "",
    `请输出 {"items": [{"url": "...", "displayTitle": "...", "summary": "...", "aiAnalysis": "...", "tags": [...], "importance": N, "coverageCountries": [], "interestMatches": []}, ...]}`,
    `必须输出且仅输出 ${items.length} 条，url 精确回填。`,
  ].join("\n");

  // The first request plus at most two targeted repairs gives each URL a
  // strict total budget of three attempts. Successful URLs are never replayed.
  for (let attempt = 1; attempt <= control.maxAttemptsPerUrl; attempt++) {
    const malformed = items.filter((item) =>
      needsConsolidatedRepair(item, result.get(item.url))
      && (control.attemptsByUrl.get(item.url) ?? 0) < control.maxAttemptsPerUrl,
    );
    if (malformed.length === 0 || !canStartEnrichment(control)) break;
    const attemptItems = malformed;
    const repairPrompt = [
      attempt === 1 ? userPrompt : buildConsolidatedPrompt(categoryLabel, attemptItems, langHeader, sharedOptions),
      attempt === 1 ? "" : (REPORT_LOCALE === "en"
        ? "This is a targeted repair. Replace every missing, untranslated, garbled, or low-information field. A hot-search summary must explain the query, context, and evidence-backed cause; aiAnalysis must add a distinct implication."
        : "这是定向修复。请修复缺失、未翻译、乱码或低信息字段；热搜摘要必须解释词义、关联背景和有证据的走红原因，aiAnalysis 必须给出不重复摘要的影响判断。"),
    ].join("\n\n");
    try {
      merge(await runConsolidatedOnce(
        attemptItems,
        CONSOLIDATED_PROMPTS,
        repairPrompt,
        attempt === 1 ? categoryLabel : `${categoryLabel}-repair-${attempt}`,
        run,
        control,
      ));
      if (attempt > 1) console.log(`[enrich] consolidated "${categoryLabel}" targeted repair ${attempt}/${control.maxAttemptsPerUrl}: ${attemptItems.length} item(s)`);
    } catch (e) {
      console.warn(`[enrich] consolidated "${categoryLabel}" attempt ${attempt}/${control.maxAttemptsPerUrl} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  for (const item of items) {
    if (needsConsolidatedRepair(item, result.get(item.url))) result.delete(item.url);
  }
  return result;
}

function canStartEnrichment(control: EnrichmentControl): boolean {
  if (control.circuitOpen) return false;
  if (control.now() < control.deadlineAt) return true;
  control.circuitOpen = true;
  control.reason = "budget";
  return false;
}

function recordUnusableResponse(control: EnrichmentControl): void {
  control.consecutiveEmptyFailures++;
  if (control.consecutiveEmptyFailures >= control.emptyFailureThreshold) {
    control.circuitOpen = true;
    control.reason = "empty_response";
  }
}

function buildConsolidatedPrompt(categoryLabel: string, items: EnrichInput[], langHeader: string, options: ConsolidatedEnrichOptions = {}): string {
  return [
    langHeader,
    "",
    REPORT_LOCALE === "en"
      ? "Every item must contain displayTitle, summary, tags, and importance."
      : "每个 item 必须包含 displayTitle、summary、tags、importance。",
    `以下为今日「${categoryLabel}」板块的 ${items.length} 条条目：`,
    JSON.stringify(items.map((it) => ({
      sourceId: it.sourceId ?? "",
      url: it.url,
      title: it.title,
      excerpt: (it.excerpt ?? "").slice(0, 250),
      source: it.source ?? "",
      sourceCountry: it.sourceCountry ?? "",
      customKeywords: options.customKeywords ?? it.customKeywords ?? [],
      category: categoryLabel,
    }))),
    "",
    `请输出 {"items": [{"url": "...", "displayTitle": "...", "summary": "...", "aiAnalysis": "...", "tags": [...], "importance": N, "coverageCountries": [], "interestMatches": []}, ...]}`,
    `必须输出且仅输出 ${items.length} 条，url 精确回填。`,
  ].join("\n");
}

async function runConsolidatedOnce(
  items: EnrichInput[],
  systemPrompt: string,
  userPrompt: string,
  scope: string,
  run: typeof runLlm,
  control: EnrichmentControl,
): Promise<Map<string, ConsolidatedEnrichment>> {
  const result = new Map<string, ConsolidatedEnrichment>();
  if (!canStartEnrichment(control)) return result;
  const remainingBudget = control.deadlineAt - control.now();
  const timeoutMs = Math.max(1, Math.min(control.perCallTimeoutMs, remainingBudget));
  for (const item of items) {
    control.attemptsByUrl.set(item.url, (control.attemptsByUrl.get(item.url) ?? 0) + 1);
  }

  let text: string;
  try {
    ({ text } = await run({ systemPrompt, userPrompt, timeoutMs }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/LLM_EMPTY_RESPONSE|LLM_TRUNCATED_JSON|LLM_EMPTY_RESULT/.test(message)) {
      recordUnusableResponse(control);
    }
    throw error;
  }
  if (!text.trim()) {
    recordUnusableResponse(control);
    throw new Error("LLM_EMPTY_RESPONSE: enrichment provider returned empty content");
  }
  const cleaned = extractJson(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned) as unknown;
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(cleaned)) as unknown;
    } catch (error) {
      recordUnusableResponse(control);
      throw new Error(`LLM_TRUNCATED_JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let validated: ReturnType<typeof parseConsolidatedResult>;
  try {
    validated = parseConsolidatedResult(parsed, items.map((item) => item.url));
  } catch (error) {
    recordUnusableResponse(control);
    throw new Error(`LLM_INVALID_RESPONSE: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const [url, value] of validated) {
    const item = items.find((candidate) => candidate.url === url);
    const unsupported = item ? hasUnsupportedHighRiskClaim(item, value) : null;
    if (unsupported) {
      console.warn(`[enrich] rejected unsupported ${unsupported} claim for ${url}`);
      if (item) result.set(url, evidenceFallback(item, unsupported));
      continue;
    }
    result.set(url, value);
  }
  if (result.size === 0) {
    recordUnusableResponse(control);
    throw new Error("LLM_EMPTY_RESULT: enrichment response contained no usable requested items");
  }
  control.consecutiveEmptyFailures = 0;

  // Diagnostic for undercount
  if (result.size < items.length / 2 && items.length >= 3) {
    try {
      const fs = await import("node:fs");
      fs.mkdirSync("logs", { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const tag = scope.replace(/[^a-z0-9]/gi, "-");
      fs.writeFileSync(
        `logs/enrich-consolidated-undercount-${tag}-${ts}.txt`,
        `scope=${scope}\nrequested=${items.length}\nreturned=${result.size}\n\n--- raw LLM output ---\n${text}`,
        "utf8",
      );
	      console.warn(`[enrich] consolidated "${scope}": undercount ${result.size}/${items.length}`);
	    } catch { /* non-fatal */ }
	  }

	  return result;
	}

const HIGH_RISK_EVIDENCE_RULES: Array<{ output: RegExp; source: RegExp; label: string }> = [
  {
    output: /病逝|去世|死亡|身亡|遇害|被杀|died|dead|death|killed|passed away|assassinated/i,
    source: /病逝|去世|死亡|身亡|遇害|被杀|died|dead|death|killed|passed away|assassinated/i,
    label: "死亡/遇害",
  },
  {
    output: /逮捕|被捕|拘留|arrested|detained|taken into custody/i,
    source: /逮捕|被捕|拘留|arrested|detained|taken into custody/i,
    label: "逮捕/拘留",
  },
  {
    output: /辞职|下台|被解职|resigned|stepped down|removed from office/i,
    source: /辞职|下台|被解职|resigned|stepped down|removed from office/i,
    label: "辞职/解职",
  },
  {
    output: /\b\d+\s*(?:比|[-:]|to)\s*\d+\b|比分|夺冠|score(?:d)?|won the (?:match|final)/i,
    source: /\b\d+\s*(?:比|[-:]|to)\s*\d+\b|比分|夺冠|score(?:d)?|won the (?:match|final)/i,
    label: "比分/赛果",
  },
];

export function hasUnsupportedHighRiskClaim(item: EnrichInput, value: ConsolidatedValue): string | null {
  const output = `${value.displayTitle ?? ""} ${value.summary} ${value.aiAnalysis ?? ""}`;
  const source = `${item.title} ${item.excerpt ?? ""}`;
  for (const rule of HIGH_RISK_EVIDENCE_RULES) {
    if (rule.output.test(output) && !rule.source.test(source)) return rule.label;
  }
  return null;
}

function evidenceFallback(item: EnrichInput, label: string): ConsolidatedValue {
  const sourceTitle = item.title.trim();
  const summary = REPORT_LOCALE === "en"
    ? "The source does not provide verifiable " + label + " evidence. Title retained for manual review: " + sourceTitle
    : "原文未提供可核验的" + label + "证据，标题保留供人工复核：" + sourceTitle;
  return {
    displayTitle: REPORT_LOCALE === "en" ? sourceTitle : "待核验：" + sourceTitle,
    summary,
    aiAnalysis: REPORT_LOCALE === "en"
      ? "The missing source evidence limits any impact assessment; verify the original report before acting on this item."
      : "原文证据不足会显著限制影响判断，采取行动前应先核验来源正文。",
    tags: REPORT_LOCALE === "en" ? ["manual review"] : ["待核验"],
    importance: 3,
    coverageCountries: [],
    interestMatches: [],
  };
}

// ----- AI Review: quality check before publishing -----

const AI_REVIEW_SYSTEM_PROMPT_ZH = `你是一名日报质量审核编辑。负责审阅即将发布的日报，确保内容质量。

输入：今日日报的摘要结构，包含各板块的条目（原始标题、原文摘录、来源、AI摘要、标签、重要度）。原始标题和原文摘录是唯一事实证据，不得使用外部常识替输入补事实。

审核要点：
1. **覆盖度**：各板块（热搜趋势/技术动态/财经要点/国际时政）是否都有内容？是否有明显缺失的领域？
2. **质量**：摘要是否精炼、信息密度是否足够、是否有明显错误或编造内容？
3. **多样性**：信息来源是否多样化？是否过度依赖某几个源？
4. **重点突出**：重要度高的条目是否正确突出了？
5. **事实核验**：特别检查日期、赛事、比分、人物、国家关系和“热搜词”是否被错误改写成已确认事实；热搜只能说明搜索热度，不能证明事件发生。
6. **国际时政**：媒体所属国与文章涉及国是否区分；同一冲突、声明或行动的重复条目是否应合并。
7. **发布阻断条件**：只有原文不支持的严重事实结论、明显编造、缺少摘要、未翻译或整栏不可用才设 passed=false。
8. **非阻断问题**：重复事件、热搜措辞偏猜测、单条题材关联弱、来源比例不理想，写入 suggestions，不要因此设 passed=false。
只有缺少摘要、展示内容未翻译、存在无依据结论等发布级问题才设 passed=false；轻微文风建议和可优化的重复必须保持 passed=true。

输出严格 JSON 对象：
{
  "passed": true/false,
  "summary": "<50-100 字的整体评价>",
  "issues": ["问题1", "问题2", ...],
  "suggestions": ["建议1", "建议2", ...],
  "blockingScope": "none|items|systemic",
  "blockingItems": [
    { "url": "<输入中该条目的完整 URL>", "category": "<栏目 key>", "reason": "<阻断原因>" }
  ]
}

当 passed=false 且问题只涉及具体条目时，blockingScope 必须为 "items"，
并把输入里的完整 URL 原样复制到 blockingItems；不得猜测、缩短或改写 URL。
当整栏不可用或无法精确定位到输入中的具体条目时，blockingScope 必须为 "systemic"。
当 passed=true 时，blockingScope 必须为 "none" 且 blockingItems 为空数组。

如果全部合格，issues 和 suggestions 可以为空数组。`;

const AI_REVIEW_SYSTEM_PROMPT_EN = `You are a daily report quality reviewer. Review the content before publishing.

Input: each item has the original title and excerpt. Treat them as the sole evidence; do not use outside knowledge to fill gaps.

Check:
1. **Coverage**: Does each section have content? Any obvious gaps?
2. **Quality**: Are summaries concise and accurate? Any fabricated content?
3. **Diversity**: Are sources diverse? Over-reliance on a few sources?
4. **Prioritization**: Are high-importance items properly highlighted?
5. **Fact checking**: Check dates, competitions, scores, people, country relations, and whether trend keywords were incorrectly rewritten as verified events. A trend proves search interest, not that an event happened.
6. **World news attribution**: Are publisher country and covered countries separated? Should duplicate reports about the same conflict, statement, or action be merged?
7. **Publication blockers**: Set passed=false only for unsupported serious factual claims, fabrication, missing summaries, untranslated content, or an unusable section.
An item marked for manual review is an intentional safe fallback after an unsupported claim was rejected; report it as a suggestion, not a blocker for the whole report.
8. **Non-blocking issues**: Duplicate events, tentative trend wording, a weakly related item, or imperfect source balance belong in suggestions and must not set passed=false.

Set passed=false only for publication-blocking issues such as missing summaries,
untranslated display content, or unsupported claims. Duplicate events and minor
scope/style issues are suggestions, not blockers.
Minor stylistic suggestions must keep passed=true.

Output STRICTLY JSON:
{
  "passed": true/false,
  "summary": "<50-100 word overall assessment>",
  "issues": ["issue1", "issue2", ...],
  "suggestions": ["suggestion1", ...],
  "blockingScope": "none|items|systemic",
  "blockingItems": [
    { "url": "<exact item URL from the input>", "category": "<section label>", "reason": "<unsupported claim or other blocker>" }
  ]
}

When passed=false because one or more specific items are unsafe, set
blockingScope="items" and copy each exact URL from the input into
blockingItems. Use blockingScope="systemic" when a whole section is unusable
or the blocker cannot be tied to an exact input item. Never invent or shorten
URLs. Use blockingScope="none" and an empty blockingItems array when passed=true.

Empty arrays if all good.`;

const AI_REVIEW_PROMPTS =
  REPORT_LOCALE === "en" ? AI_REVIEW_SYSTEM_PROMPT_EN : AI_REVIEW_SYSTEM_PROMPT_ZH;

export interface ReviewResult {
  passed: boolean;
  summary: string;
  issues: string[];
  suggestions: string[];
  reviewState: "passed" | "failed" | "unavailable";
  publicationState: "eligible" | "blocked" | "limited";
  failureCodes: string[];
  blockingScope: "none" | "items" | "systemic";
  blockingItems: ReviewBlockingItem[];
  recovery?: {
    suppressedCount: number;
    suppressedItems: ReviewBlockingItem[];
    originalFailureCodes: string[];
  };
}

export interface ReviewBlockingItem {
  url: string;
  category?: string;
  reason: string;
}

export interface ReviewRecoveryResolution {
  recoverable: boolean;
  urls: string[];
  unresolved: ReviewBlockingItem[];
  reason?: "not_failed" | "systemic" | "missing_items" | "unresolved_items";
}

/**
 * Resolves structured review blockers against the exact articles sent to the
 * reviewer. A failed legacy/unstructured response deliberately remains fatal.
 */
export function resolveReviewBlockingItems(
  review: ReviewResult,
  articles: Array<{ url: string; category?: string }>,
): ReviewRecoveryResolution {
  if (review.reviewState !== "failed") {
    return { recoverable: false, urls: [], unresolved: [], reason: "not_failed" };
  }
  if (review.blockingScope === "systemic") {
    return { recoverable: false, urls: [], unresolved: review.blockingItems, reason: "systemic" };
  }
  if (review.blockingScope !== "items" || review.blockingItems.length === 0) {
    return { recoverable: false, urls: [], unresolved: review.blockingItems, reason: "missing_items" };
  }

  const articleByUrl = new Map(articles.map((article) => [article.url, article]));
  const unresolved: ReviewBlockingItem[] = [];
  const urls = new Set<string>();
  for (const blocker of review.blockingItems) {
    const article = articleByUrl.get(blocker.url);
    if (!article) {
      unresolved.push(blocker);
      continue;
    }
    urls.add(article.url);
  }
  return unresolved.length === 0 && urls.size > 0
    ? { recoverable: true, urls: [...urls], unresolved: [] }
    : { recoverable: false, urls: [...urls], unresolved, reason: "unresolved_items" };
}

export type ReviewRunner = typeof runLlm;

/**
 * Final quality check before publishing.
 * Reviews the rendered report for coverage, quality, diversity, and priorities.
 */
export async function aiReview(
  categorySummary: string,
  reviewRunner: ReviewRunner = runLlm,
): Promise<ReviewResult> {
  try {
    const { text } = await reviewRunner({
      systemPrompt: AI_REVIEW_PROMPTS,
      userPrompt: `请审核以下日报内容：\n\n${categorySummary}\n\n请输出 JSON 格式审核报告。`,
      timeoutMs: 30_000,
    });
    const cleaned = extractJson(text);
    let parsed: Partial<ReviewResult>;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = JSON.parse(jsonrepair(cleaned));
    }
    const issues = Array.isArray(parsed.issues) ? parsed.issues.filter((issue): issue is string => typeof issue === "string") : [];
    const blockingItems = Array.isArray(parsed.blockingItems)
      ? parsed.blockingItems.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const candidate = item as Partial<ReviewBlockingItem>;
          if (typeof candidate.url !== "string" || !/^https?:\/\//i.test(candidate.url) || typeof candidate.reason !== "string" || !candidate.reason.trim()) return [];
          return [{
            url: candidate.url,
            category: typeof candidate.category === "string" ? candidate.category : undefined,
            reason: candidate.reason.trim(),
          }];
        })
      : [];
    const hasBlockingIssue = parsed.passed === false || issues.some((issue) => /编造|捏造|幻觉|不实|无依据|事实错误|事实性错误|严重错误|缺少摘要|无摘要|未翻译|unsupported|fabricat|hallucin|false claim/i.test(issue));
    const requestedScope = parsed.blockingScope;
    const blockingScope: ReviewResult["blockingScope"] = !hasBlockingIssue
      ? "none"
      : requestedScope === "items" && blockingItems.length > 0
        ? "items"
        : "systemic";
    return {
      passed: !hasBlockingIssue,
      summary: parsed.summary ?? "",
      issues,
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((suggestion): suggestion is string => typeof suggestion === "string")
        : [],
      reviewState: hasBlockingIssue ? "failed" : "passed",
      publicationState: hasBlockingIssue ? "blocked" : "eligible",
      failureCodes: hasBlockingIssue ? ["AI_REVIEW_BLOCKED"] : [],
      blockingScope,
      blockingItems: hasBlockingIssue ? blockingItems : [],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[enrich] AI review failed: ${msg}`);
    return {
      passed: false,
      summary: "审核服务不可用，尚未通过质量审核。",
      issues: ["AI quality review service unavailable"],
      suggestions: [],
      reviewState: "unavailable",
      publicationState: "blocked",
      failureCodes: ["AI_REVIEW_UNAVAILABLE"],
      blockingScope: "systemic",
      blockingItems: [],
    };
  }
}
