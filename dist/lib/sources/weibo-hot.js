import { curlFetch } from "./curl-fetch";
export async function fetchWeiboHot(sourceId, limit = 30) {
    try {
        const json = await curlFetch("https://weibo.com/ajax/side/hotSearch", {
            Referer: "https://weibo.com/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        }, 15);
        const parsed = JSON.parse(json);
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
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[weibo-hot] fetch failed: ${msg}`);
        return [];
    }
}
