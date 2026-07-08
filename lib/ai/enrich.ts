import { jsonrepair } from "jsonrepair";
import { runLlm } from "./llm";
import { extractJson } from "./json-util";
import { REPORT_LOCALE } from "../sources/registry";

export interface EnrichInput {
  url: string;
  title: string;
  excerpt?: string;
  source?: string;
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
  - 对于 Google Trends 关键词：将英文关键词翻译为中文，并在摘要中说明该词为何热门（如能推断）
  - 对于 Reddit 热门帖子：将英文标题翻译为中文，并根据 excerpt 写 30-60 字中文摘要
  - 原文已含中文的条目，直接凝练摘要
  - 必须保留关键数字、人名、产品名、地名
  - 中性事实陈述

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
    USER_PROMPT_HEADER(payload.length),
    JSON.stringify(payload),
    "",
    USER_PROMPT_FOOTER,
  ].join("\n");

  const result = new Map<string, string>();

  try {
    const { text } = await runLlm({
      systemPrompt,
      userPrompt,
      timeoutMs: 240_000,
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
    // Common reasons: provider max_tokens too low → truncated JSON, model
    // refused some items, URL field altered so the upstream URL-match drops
    // entries downstream. Without this dump the failure is silent.
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
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[enrich] ${scope} failed: ${msg}`);
  }

  return result;
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

  try {
    const { text } = await runLlm({
      systemPrompt: PROMPTS.tags,
      userPrompt,
      timeoutMs: 240_000,
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
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[enrich] tags failed: ${msg}`);
  }

  return result;
}
