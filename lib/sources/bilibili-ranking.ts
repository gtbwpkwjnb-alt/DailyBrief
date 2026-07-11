import { curlFetch } from "./curl-fetch";
import type { RawArticle } from "./types";

/**
 * Bilibili 排行榜抓取。
 *
 * Bilibili 公开 API /x/web-interface/popular 返回全站热门视频列表，
 * 按热度排序。使用 curl 抓取（Bilibili 对 Node.js fetch 有 TLS/UA 检测）。
 *
 * API 响应示例：
 *   code=0, data.list[{ title, owner.name, stat.{view,like,reply}, short_link_v2, bvid }]
 */
interface BiliPopularItem {
  title: string;
  bvid: string;
  owner: { name: string; mid: number };
  stat: {
    view: number;
    like: number;
    reply: number;
    coin: number;
    favorite: number;
    share: number;
    danmaku: number;
  };
  short_link_v2: string;
  pic: string;
  desc: string;
  pubdate: number;
}

interface BiliPopularResponse {
  code: number;
  data?: { list?: BiliPopularItem[] };
}

export async function fetchBilibiliRanking(
  sourceId: string,
  limit = 30,
): Promise<RawArticle[]> {
  try {
    const json = await curlFetch(
      "https://api.bilibili.com/x/web-interface/popular?ps=30",
      {
        Referer: "https://www.bilibili.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Origin: "https://www.bilibili.com",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      15,
    );
    const parsed: BiliPopularResponse = JSON.parse(json);
    if (parsed.code !== 0 || !parsed.data?.list) {
      throw new Error(`Bilibili ranking API error: code=${parsed.code}`);
    }

    return parsed.data.list.slice(0, limit).map((item) => {
      const stats = [
        item.stat.view ? `👁 ${fmtCount(item.stat.view)}` : "",
        item.stat.like ? `👍 ${fmtCount(item.stat.like)}` : "",
        item.stat.reply ? `💬 ${fmtCount(item.stat.reply)}` : "",
      ]
        .filter(Boolean)
        .join(" · ");

      return {
        sourceId,
        title: item.title.replace(/<[^>]+>/g, "").trim(),
        url: item.short_link_v2
          ? `https://b23.tv/${item.short_link_v2.replace(/^https?:\/\/b23\.tv\//, "")}`
          : `https://www.bilibili.com/video/${item.bvid}`,
        excerpt: stats || (item.owner?.name ? `UP: ${item.owner.name}` : undefined),
        meta: item.owner?.name ? `UP: ${item.owner.name}` : undefined,
        publishedAt: item.pubdate ? new Date(item.pubdate * 1000) : undefined,
        category: "tech",
      };
    });
  } catch (error) {
    throw new Error("Bilibili ranking fetch failed", { cause: error });
  }
}

function fmtCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
