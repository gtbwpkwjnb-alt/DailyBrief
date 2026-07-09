import Parser from "rss-parser";
import { curlFetch } from "./curl-fetch";
const parser = new Parser({
    timeout: 8000,
    headers: {
        "User-Agent": "Mozilla/5.0 (compatible; DailyBriefBot/1.0; +https://github.com/)",
    },
});
const CURL_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};
function stripHtml(s) {
    return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
export async function fetchRss(sourceId, url, category, options = {}) {
    const limit = options.limit ?? 30;
    let feed;
    if (options.useCurl) {
        const xml = await curlFetch(url, CURL_HEADERS);
        feed = await parser.parseString(xml);
    }
    else {
        feed = await parser.parseURL(url);
    }
    return (feed.items ?? [])
        .slice(0, limit)
        .map((item) => ({
        sourceId,
        title: (item.title ?? "").trim(),
        url: (item.link ?? "").trim(),
        excerpt: stripHtml(item.contentSnippet ?? item.content ?? "").slice(0, 300),
        publishedAt: item.isoDate ? new Date(item.isoDate) : undefined,
        category,
    }))
        .filter((a) => a.title && a.url);
}
