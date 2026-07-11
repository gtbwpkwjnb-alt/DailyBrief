import { fetchAttentionVc } from "./attentionvc";
import { fetchBilibiliRanking } from "./bilibili-ranking";
import { fetchBaiduHot } from "./baidu-hot";
import { fetchGithubTrending } from "./github-trending";
import { fetchHackerNews } from "./hackernews";
import { fetchHuggingfacePapers } from "./huggingface-papers";
import { fetchKr36Hot } from "./kr-36-hot";
import { fetchLinuxDo } from "./linuxdo";
import { fetchRss } from "./rss";
import { fetchReader } from "./reader";
import { fetchV2ex } from "./v2ex";
import { fetchWeiboHot } from "./weibo-hot";
import type { RawArticle, SourceDef } from "./types";

/**
 * Single dispatcher used by daily.ts, dry-run.ts, and the cron route.
 * Add a new branch here when introducing a non-RSS fetcher.
 */
export async function fetchSource(source: SourceDef): Promise<RawArticle[]> {
  if (source.type === "reader") return fetchReader(source);
  if (source.id === "hackernews") return fetchHackerNews(source.id);
  if (source.id === "github-trending") return fetchGithubTrending(source.id);
  if (source.id === "v2ex-hot") return fetchV2ex(source.id);
  if (source.id === "linuxdo") return fetchLinuxDo(source.id);
  if (source.id === "attentionvc-ai") return fetchAttentionVc(source.id);
  if (source.id === "huggingface-papers") return fetchHuggingfacePapers(source.id, source.keywords);
  if (source.id === "weibo-hot-search") return fetchWeiboHot(source.id);
  if (source.id === "baidu-hot-search") return fetchBaiduHot(source.id);
  if (source.id === "kr-36-hotlist") return fetchKr36Hot(source.id);
  if (source.id === "bilibili-ranking") return fetchBilibiliRanking(source.id);
  return fetchRss(source.id, source.url, source.category, {
    useCurl: source.useCurl,
  });
}
