const HN_BASE = "https://hacker-news.firebaseio.com/v0";
function stripHtml(s) {
    return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
export async function fetchHackerNews(sourceId, limit = 30) {
    const ids = (await fetch(`${HN_BASE}/topstories.json`).then((r) => r.json()));
    const slice = ids.slice(0, limit);
    const items = await Promise.all(slice.map((id) => fetch(`${HN_BASE}/item/${id}.json`)
        .then((r) => r.json())
        .catch(() => null)));
    return items
        .filter((it) => Boolean(it && it.title))
        .map((it) => ({
        sourceId,
        title: it.title ?? "",
        url: it.url ?? `https://news.ycombinator.com/item?id=${it.id}`,
        excerpt: it.text
            ? stripHtml(it.text).slice(0, 300)
            : `${it.score ?? 0} points · ${it.descendants ?? 0} comments`,
        publishedAt: it.time ? new Date(it.time * 1000) : undefined,
        category: "tech",
    }));
}
