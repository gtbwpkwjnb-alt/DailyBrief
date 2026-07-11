import { curlFetch } from "./curl-fetch";
import type { RawArticle } from "./types";

/**
 * 微博热搜抓取。
 *
 * Weibo 有一个半公开的 JSON 接口 /ajax/side/hotSearch，返回实时热搜榜。
 * 使用 curl 抓取（Weibo 对 Node.js fetch 的 TLS 指纹有检测）。
 */
interface WeiboHotItem {
  word: string;           // 热搜词
  raw_hot?: number;       // 热度值
  label_name?: string;    // 标签（"荐"、"沸"、"爆"、"新" 等）
  url?: number;           // 话题页 ID（非完整 URL）
  icon_desc?: string;     // 图标描述（"热"、"沸"、"爆"、"新"）
}

interface WeiboHotResponse {
  data?: {
    realtime?: WeiboHotItem[];
  };
}

export async function fetchWeiboHot(
  sourceId: string,
  limit = 30,
): Promise<RawArticle[]> {
  try {
    const json = await curlFetch(
      "https://weibo.com/ajax/side/hotSearch",
      {
        Referer: "https://weibo.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      15,
    );
    const parsed: WeiboHotResponse = JSON.parse(json);
    const items = parsed.data?.realtime ?? [];
    return items.slice(0, limit).map((item, i) => {
      const label = item.icon_desc ?? item.label_name ?? "";
      const hotTag = label ? `[${label}] ` : "";
      return {
        sourceId,
        title: `${hotTag}${item.word}`,
        url: `https://s.weibo.com/weibo?q=${encodeURIComponent(item.word)}`,
        excerpt: item.raw_hot ? `热度值: ${item.raw_hot}` : undefined,
        publishedAt: new Date(),
        category: "trending",
      };
    });
  } catch (error) {
    throw new Error("Weibo hot-search fetch failed", { cause: error });
  }
}
