const CLASSIFICATION_CN = {
    "Extreme Fear": "极度恐慌",
    Fear: "恐慌",
    Neutral: "中性",
    Greed: "贪婪",
    "Extreme Greed": "极度贪婪",
};
/**
 * Fetch the crypto Fear & Greed Index from alternative.me — free public
 * API, no key, daily updated single value 0-100.
 * https://alternative.me/crypto/fear-and-greed-index/
 */
export async function fetchCryptoFearGreed() {
    try {
        const res = await fetch("https://api.alternative.me/fng/?limit=1", {
            headers: { "User-Agent": "Mozilla/5.0 (DailyBriefBot)" },
        });
        if (!res.ok)
            return null;
        const data = (await res.json());
        const item = data?.data?.[0];
        if (!item?.value)
            return null;
        const value = Number(item.value);
        const classification = item.value_classification ?? "Neutral";
        return {
            value,
            classification,
            classificationCn: CLASSIFICATION_CN[classification] ?? classification,
            timestamp: item.timestamp
                ? new Date(Number(item.timestamp) * 1000).toISOString()
                : new Date().toISOString(),
        };
    }
    catch {
        return null;
    }
}
