import { curlFetch } from "./curl-fetch";
export async function fetchBaiduHot(sourceId, limit = 30) {
    try {
        const json = await curlFetch("https://top.baidu.com/api/board?tab=realtime", {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "application/json, text/plain, */*",
            Referer: "https://top.baidu.com/board?tab=realtime",
            "Accept-Language": "zh-CN,zh;q=0.9",
        }, 15);
        const parsed = JSON.parse(json);
        if (!parsed.success || !parsed.data?.cards) {
            console.warn(`[baidu-hot] API returned no data`);
            return [];
        }
        // Flatten all card contents
        const items = [];
        for (const card of parsed.data.cards) {
            if (card.content)
                items.push(...card.content);
        }
        return items.slice(0, limit).map((item) => {
            const word = item.word ?? item.query ?? "";
            const changeIcon = item.hotChange === "up"
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
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[baidu-hot] fetch failed: ${msg}`);
        return [];
    }
}
function fmtHot(n) {
    if (n >= 10000)
        return `${(n / 10000).toFixed(1)}万`;
    return String(n);
}
