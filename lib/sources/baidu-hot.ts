import { curlFetch } from "./curl-fetch";
import type { RawArticle } from "./types";

/**
 * 百度热搜抓取。
 *
 * 百度热搜实时榜有 JSON API 接口 /api/board?tab=realtime，
 * 返回结构化数据，比 HTML 解析更可靠。
 *
 * 命中示例：
 *  {
 *    "success": true,
 *    "data": { "cards": [{
 *      "component": "hotList",
 *      "content": [{
 *        "word": "热搜词",
 *        "desc": "描述文字",
 *        "hotScore": 1234567,
 *        "appUrl": "https://www.baidu.com/s?wd=...",
 *        "hotChange": "same" | "up" | "down"
 *      }]
 *    }] }
 *  }
 */
interface BaiduHotItem {
  word?: string;
  query?: string;
  desc?: string;
  hotScore?: number;
  appUrl?: string;
  hotChange?: string;
}

interface BaiduHotCard {
  component?: string;
  content?: BaiduHotItem[];
}

interface BaiduHotResponse {
  success?: boolean;
  data?: { cards?: BaiduHotCard[] };
}

export async function fetchBaiduHot(
  sourceId: string,
  limit = 30,
): Promise<RawArticle[]> {
  try {
    const json = await curlFetch(
      "https://top.baidu.com/api/board?tab=realtime",
      {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        Referer: "https://top.baidu.com/board?tab=realtime",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
      15,
    );

    const parsed: BaiduHotResponse = JSON.parse(json);
    if (!parsed.success || !parsed.data?.cards) {
      throw new Error("Baidu hot-search API returned no data");
    }

    // Flatten all card contents
    const items: BaiduHotItem[] = [];
    for (const card of parsed.data.cards) {
      if (card.content) items.push(...card.content);
    }

    return items.slice(0, limit).map((item) => {
      const word = item.word ?? item.query ?? "";
      const changeIcon =
        item.hotChange === "up"
          ? "↑"
          : item.hotChange === "down"
            ? "↓"
            : "→";
      const excerpt = [
        item.desc ?? "",
        item.hotScore ? `热度: ${fmtHot(item.hotScore)} ${changeIcon}` : "",
      ]
        .filter(Boolean)
        .join(" — ");

      return {
        sourceId,
        title: word,
        url: item.appUrl?.includes("baidu.com")
          ? item.appUrl
          : `https://www.baidu.com/s?wd=${encodeURIComponent(word)}`,
        excerpt,
        publishedAt: new Date(),
        category: "trending",
      };
    });
  } catch (error) {
    throw new Error("Baidu hot-search fetch failed", { cause: error });
  }
}

function fmtHot(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(n);
}
