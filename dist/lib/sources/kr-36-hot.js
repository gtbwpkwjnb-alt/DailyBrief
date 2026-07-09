import { curlFetch } from "./curl-fetch";
export async function fetchKr36Hot(sourceId, limit = 30) {
    try {
        const json = await curlFetch("https://36kr.com/api/newsflash?page=1&per_page=30", {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "application/json, text/plain, */*",
            Referer: "https://36kr.com/newsflashes",
            "Accept-Language": "zh-CN,zh;q=0.9",
        }, 15);
        const parsed = JSON.parse(json);
        if (parsed.code !== 0 || !parsed.data?.items) {
            console.warn(`[kr-36-hot] API error: code=${parsed.code}`);
            return [];
        }
        return parsed.data.items.slice(0, limit).map((item) => ({
            sourceId,
            title: item.title.trim(),
            url: item.url
                ? (item.url.startsWith("http") ? item.url : `https://36kr.com${item.url}`)
                : `https://36kr.com/newsflashes/${item.id}`,
            publishedAt: item.created_at ? new Date(item.created_at) : undefined,
            category: "tech",
        }));
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[kr-36-hot] fetch failed: ${msg}`);
        return [];
    }
}
