import * as cheerio from "cheerio";
import { httpFetch } from "./http";
import type { RawArticle } from "./types";

const HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (compatible; DailyBriefBot/1.0; +https://github.com/)",
  Accept: "application/rss+xml, application/xml, text/xml, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

type CheerioApi = ReturnType<typeof cheerio.load>;
type CheerioSelection = ReturnType<CheerioApi>;

function textOf(scope: CheerioSelection, selector: string): string {
  return scope.find(selector).first().text().replace(/\s+/g, " ").trim();
}

export function parseGoogleTrendsXml(sourceId: string, feedUrl: string, xml: string, limit = 30): RawArticle[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  return $("item").slice(0, limit).map((_, element) => {
    const item = $(element);
    const title = item.children("title").first().text().trim();
    const traffic = textOf(item, "ht\\:approx_traffic");
    const related = item.find("ht\\:news_item").slice(0, 3).map((__, newsElement) => {
      const news = $(newsElement);
      return {
        title: textOf(news, "ht\\:news_item_title"),
        url: textOf(news, "ht\\:news_item_url"),
        source: textOf(news, "ht\\:news_item_source"),
      };
    }).get().filter((news) => news.title);
    const relatedContext = related.map((news) =>
      `关联报道：${news.title}${news.source ? `（${news.source}）` : ""}`,
    );
    const excerpt = [traffic ? `搜索量约 ${traffic}` : "", ...relatedContext]
      .filter(Boolean)
      .join("；")
      .slice(0, 600);
    const publishedText = item.children("pubDate").first().text().trim();
    const publishedAt = publishedText ? new Date(publishedText) : undefined;
    return {
      sourceId,
      title,
      url: related.find((news) => /^https?:\/\//i.test(news.url))?.url
        || item.children("link").first().text().trim()
        || feedUrl,
      excerpt,
      publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : undefined,
      category: "trending" as const,
    };
  }).get().filter((article) => article.title && article.url);
}

export async function fetchGoogleTrends(sourceId: string, feedUrl: string, limit = 30): Promise<RawArticle[]> {
  const response = await httpFetch(feedUrl, { headers: HEADERS }, 12_000);
  return parseGoogleTrendsXml(sourceId, feedUrl, await response.text(), limit);
}
