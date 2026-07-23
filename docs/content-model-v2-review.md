# DailyBrief 内容模型 v2 开发前评审

> 状态：待评审，未实现
>
> 依据：`DailyBrief-Web-完整执行方案.md` v1.4
>
> 范围：只确认信息获取、事件聚类、证据、评分、精炼、公开输出和快照逻辑。本文不代表数据库、Worker、API、管理后台或用户前端已经完成。

## 1. 评审目标与边界

本轮先用静态评审稿确认内容模型、筛选逻辑和公开字段。确认后，才将同一契约实现到数据库、Worker、API 和前端。

现有连续信息流的渐进加载、栏目定位、阅读位置恢复和新版本提示可以继续作为 UI 行为基线，但现有内容生产链路不能原样迁移为 Web 平台事实源。

静态评审建议产物为冻结样本的 `review-v2.json` 和 `review-v2.html`，并与现有日报左右对照。静态文件只用于确认信息层级、证据说明、摘要密度和来源展示，不得被表述为“内容模型 v2 已实现”。

本地生成命令：

```powershell
npm.cmd run render:review
```

输出位于 `daily_reports/review-model-v2/index.html` 和 `daily_reports/review-model-v2/review-v2.json`。HTML 顶部会明确标记“评审样本”，避免与真实日报混淆。

## 2. 现状问题

### 2.1 获取完整性不足

- `lib/sources/rss.ts` 和 `lib/sources/reader.ts` 将正文或摘要截断到约 300 字符。
- 后续模型可能只拿到标题和短摘录，却仍被要求生成确定性摘要。
- 当前没有 `content_completeness`，无法区分全文、部分正文、Feed 摘录和仅标题。

### 2.2 去重会丢失来源关系

- `scripts/daily.ts` 以 URL 和规范化标题直接删除重复条目。
- 同一事件的第二家报道、转载链和独立交叉来源可能在形成事件对象之前被删除。
- 当前 Digest Prompt 要求合并同主题新闻并写“多家报道”，但输出只有一个 `url` 和一个 `source`，无法展开具体来源。

### 2.3 AI 任务耦合过重

- `lib/ai/enrich.ts` 的合并调用同时完成翻译、摘要、标签、重要度、涉及国家和用户兴趣匹配。
- 事实抽取、证据判断、评分、写作和回验没有独立的输出 Schema 与阶段边界。
- 固定摘要长度可能优先满足字数，而不是保留主体、时间、数字、单位、引述归属和不确定性。

### 2.4 单一重要度不可解释

- `SourceDef.priority` 表示抓取优先级，`RawArticle.importance` 表示模型给出的 1-10 编辑重要度，`interestMatches` 表示用户兴趣。
- 当前页面把 `importance` 直接显示为高、中、低，无法解释条目因影响、证据、时效、关注度、多样性还是用户兴趣入选。
- 外部热度和来源品牌不能直接提高事件证据等级。

### 2.5 发布回验与风险门禁不足

- 当前高风险正则只覆盖死亡、逮捕、辞职和比分等少数类型。
- AI Review 调用失败时会返回 `passed: true`，高风险内容存在失去回验后继续发布的路径。
- `MIN_ENRICHMENT_COVERAGE` 只确认展示标题和摘要是否存在，没有区分“处理完成”和“满足发布门禁”。

### 2.6 输出会被原地覆盖

- 日报 JSON、HTML 和 Sidecar 使用同日期路径写入。
- 单源补抓、摘要补全和交易重生成会直接修改既有文件。
- 当前缺少固定绑定的规则版本、Prompt 版本、模型、来源快照和内容修订版本，不能证明历史输出不可变。

### 2.7 来源健康门禁过粗

- 当前主要使用全局来源成功率，可能出现总体达到阈值、但核心来源或整个关键分类缺失的情况。
- 来源的 `priority` 只能继续作为 `fetch_priority`，不能充当来源质量画像。

## 3. 目标五层模型

### 3.1 第一层：来源快照 `source_snapshot`

```text
source_snapshot_id
source_id
publisher
canonical_url
source_profile_version
source_quality: score, reason_codes, evidence_refs, reviewed_at
publisher_country
content_type
ownership
editorial_policy
correction_policy
fetch_priority
```

来源质量 `Q` 是版本化画像，不代表该来源的每一条报道都是真实事实。外部评级只能作为参考证据，不能直接决定真假。

### 3.2 第二层：文章版本 `article_version`

```text
article_id
article_version_id
source_id
original_url
canonical_url
original_title
author_or_publisher
published_at
updated_at
fetched_at
language
publisher_country
content_hash
raw_version
content_completeness: full | partial | feed_only | title_only
```

无法取得发布时间时允许 `published_at = null`，但必须保留 `fetched_at`。`feed_only` 和 `title_only` 不得生成伪装成全文结论的确定性长摘要。

### 3.3 第三层：事件、来源与声明 `story + claims`

```text
story_id
story_revision

source_refs[]:
  source_ref_id
  source_id
  article_version_id
  role
  canonical_url
  original_title
  published_at
  evidence_snippets[]
  independence_group

claims[]:
  claim_id
  claim_type: confirmed_fact | attributed_claim | estimate | opinion | prediction | unknown
  text
  entities[]
  numbers[]
  quotes[]
  uncertainties[]
  source_refs[]
  evidence_snippets[]
```

来源角色固定为：

```text
primary_report
official_statement
independent_corroboration
analysis
community_signal
reprint
```

`independence_group` 或等价字段是必需项。两个页面若来自同一通讯稿、转载链或同一原始材料，不得被计算为两个独立来源。

### 3.4 第四层：分项评分与选稿 `scores + selection`

```text
scores:
  Q, E, I, A, U, N, F, R
  每项包含 score, reason_codes, evidence_refs, confidence

selection:
  rule_set_id
  rule_set_version
  priority_level: P0 | P1 | P2 | P3 | P4
  reason_codes[]
  diversity_gain_D
  context_value_C
```

含义：

- `Q`：来源质量画像。
- `E`：当前事件证据等级。
- `I`：公共影响。
- `A`：外部关注度，只表示讨论规模和增速。
- `U`：用户明确兴趣相关度，只影响个人镜像。
- `N`：新颖度。
- `F`：时效性。
- `R`：内容风险。
- `D`：简报内多样性增益，只在末端选稿时计算。
- `C`：背景解释价值，只在需要上下文的规则包中计算。

不再生成或公开一个含义不清的 `importance: 1-10` 代替上述分项。

### 3.5 第五层：公开条目与不可变快照 `public_item + snapshot`

```text
public_item:
  item_id
  story_id
  stable_order
  display_title
  what_happened
  why_it_matters
  key_details[]
  uncertainties[]
  summary_short
  summary_expanded
  sentence_source_refs[]
  omitted_low_priority_facts[]
  priority_level
  reason_codes[]
  evidence_state
  evidence_note
  primary_source_ref_id
  source_refs[]
  tags[]
  revision

snapshot:
  brief_id
  brief_variant_id
  snapshot_id
  rule_set_version
  prompt_versions[]
  model_ids[]
  source_snapshot_id
  generated_at
  total_items
```

同一快照内 `stable_order` 固定。内容修订、规则切换、Prompt 变化或重新生成都必须产生新版本和新快照，不得覆盖旧快照。

## 4. 公开字段与禁止公开字段

### 4.1 简报级公开字段

```text
brief_id
snapshot_id
brief_variant_id
rule_set_name
rule_set_version
generated_at
total_items
source_count
ai_assistance_notice
revision_notice
```

### 4.2 单条内容公开字段

```text
item_id
story_id
stable_order
category
subcategory
display_title
priority_level
reason_codes[]
evidence_state
evidence_note
summary_short
summary_expanded
uncertainties[]
tags[]
primary_source_ref_id
source_refs[]: publisher, canonical_url, original_title, published_at, role
revision
```

前端必须能显示主来源、补充来源数量、全部具体来源、证据状态、1-3 个入选原因、AI 精炼标记和修订记录。

### 4.3 禁止进入公开输出

- 原始正文和加密前正文。
- 系统 Prompt 全文和内部 Prompt 模板。
- 模型密钥、连接器密钥和用户凭据。
- AI 成本、内部预算、风控阈值和来源内部备注。
- 其他用户的关键词、实验分组和阅读行为。

## 5. 开发前建议确认的七项逻辑

以下是评审版建议默认值，尚未视为用户确认。每项都补充了实现时不可省略的约束：

1. 公共简报默认采用 `evidence_first A`，`balanced_daily B` 只做主要对照。公共快照强制 `U = 0`；方案规则包中的 `U5` 只适用于公共快照生成后的个人镜像排序，不得改变公共事实、证据状态或快照哈希。
2. 固定处理顺序为 `claim_valid -> Q/R policy -> E policy -> eligible_pool -> I/A/N/F ranking -> D/C rerank`。`Q`、`R` 和 `E` 未通过时，`D`、`C` 或总热度不得把条目救回可发布池。
3. “多源确认”按独立来源家族计算。内部来源关系至少记录 `origin_family_id`、`family_basis`、`assignment_confidence` 和人工覆写审计；`unknown`、转载、聚合页和同一通讯稿不增加独立来源数。
4. 无法取得发布时间时允许 `published_at = null`，但 `fetched_at timestamptz NOT NULL`。同时保留原始时间文本和解析置信度；禁止用 `fetched_at` 冒充发布时间或事件时间计算时效分。
5. 定义显式 `publish_decision`：`R >= high && verifier_status != pass` 必须 `blocked`。低风险内容仅在 `claims_validation = pass` 时允许结构化模板降级。人工放行属于单独的授权、留痕和修订路径。此规则用于收紧方案 18.9 与 21.5 中未按风险分流的“回验失败后模板降级”。
6. 热搜和社区帖默认是 `community_signal`，只能生成“某讨论/某声明存在”的带归属 claim；不能单独生成 `confirmed_fact` 或 `independent_corroboration`。高 `A` 不能提高 `E`，跨平台热度也必须按原始作者或原始证据家族去重。
7. 分别记录候选的 `processing_state`、`publication_state` 和失败码。处理覆盖率以进入流水线的候选为分母；可发布率以完成处理的候选为分母；`placeholder` 和 `blocked` 不计入可发布数，公开页面不得把占位项报告为正常摘要。

上述七项未全部确认前，不进入内容模型 v2 的数据库和 Worker 实现。

## 6. 最小验收用例

1. 两个仅追踪参数不同的 URL 指向同一事件：形成一个 `story_id`，保留两个 `source_refs`，不删除来源关系。
2. 官方声明加两家同源转载：只能证明主体作出声明，不得标记为 `multi_source_confirmed`。
3. 高关注、低证据热搜：`A` 可高、`E` 必须低，只能进入 `P3` 发展中或观察池。
4. `feed_only` 或 `title_only`：不得生成确定性 `summary_expanded`，必须显示信息有限或进入观察池。
5. 摘要新增输入未出现的死亡、伤亡、数字、单位、日期、引语或主客体关系：独立回验必须失败。
6. 回验模型超时或返回无效 Schema：高风险内容不得发布；低风险内容只能使用验证过的事实模板。
7. 同一冻结输入重复执行：不重复文章、来源关系、事件簇和快照条目。
8. 修改规则、Prompt 或摘要：生成新 `snapshot_id` 和 `revision`，旧快照内容与哈希保持不变。
9. 同一事件显示“多源确认”时：必须能展开至少两个独立、具体、可访问的来源，而不是只写“多家报道”。
10. 用户关键词只改变个人镜像的 `U`；公共简报顺序、`Q`、`E` 和事实内容不变，刷新 AI 调用数为零。
11. 全局来源成功率达到阈值、但核心来源或某关键分类全部失败：发布门禁必须阻断或明确降级，不得显示完整日报状态。
12. 公开 JSON 不包含原始正文、Prompt 全文、密钥、成本、内部阈值和其他用户数据。
13. 规则包 A-E 在同一冻结数据集上可重复回放；相同版本得到稳定结果，切换规则不覆盖历史快照。
14. 离线基准至少包含 300 个事件和 60 个高风险样本；强制实体、数字、日期、单位和引述归属保留率目标不低于 98%。
15. 事件聚类错误合并率目标低于 2%，漏合并率目标低于 5%，边界样本进入人工复核。
16. 现有连续信息流仍通过 `12 -> 24 -> 36 -> 48` 渐进加载、栏目定位、刷新恢复、新快照提示，以及 390px、768px、1440px 无横向溢出验收。
17. 将同一通讯稿的两个转载域名标成不同来源：Schema 或门禁必须拒绝 `multi_source_confirmed`。
18. `published_at = null` 且有 `fetched_at` 时可以入库；缺失 `fetched_at`、未来异常时间或时区不明时必须进入失败或人工复核状态。
19. 同一公共冻结输入分别带入两个用户的兴趣配置：公共快照内容和哈希必须完全一致，个人镜像只能重排已有条目。
20. 100 条候选中 99 条处理失败、1 条可发布：必须分别报告处理状态和可发布状态，不得以占位摘要把覆盖率显示为正常。

## 7. 评审通过条件

评审通过必须同时满足：

- 七项待确认逻辑有明确结论。
- 五层模型字段及空值策略确认。
- 静态 `review-v2.json` 通过 Schema 校验。
- 静态 `review-v2.html` 能清楚展示层级、证据、来源、摘要和不确定性。
- 冻结样本完成现有输出与 v2 输出逐条 Diff。
- 验收用例有可执行测试计划和明确失败条件。

评审通过只代表开发契约冻结，不代表任何生产逻辑、数据库、后台任务、API 或前端已经实现。只有代码、迁移、测试和真实回放全部通过后，才能将对应阶段标记为完成。
