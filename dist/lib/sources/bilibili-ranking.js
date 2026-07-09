import { curlFetch } from "./curl-fetch";
export async function fetchBilibiliRanking(sourceId, limit = 30) {
    try {
        const json = await curlFetch("https://api.bilibili.com/x/web-interface/popular?ps=30", {
            Referer: "https://www.bilibili.com/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Origin: "https://www.bilibili.com",
            Accept: "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        }, 15);
        const parsed = JSON.parse(json);
        if (parsed.code !== 0 || !parsed.data?.list) {
            console.warn(`[bilibili-ranking] API error: code=${parsed.code}`);
            return [];
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
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[bilibili-ranking] fetch failed: ${msg}`);
        return [];
    }
}
function fmtCount(n) {
    if (n >= 10000)
        return `${(n / 10000).toFixed(1)}万`;
    if (n >= 1000)
        return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}
