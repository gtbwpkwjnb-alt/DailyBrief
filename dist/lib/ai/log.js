import fs from "node:fs";
const LOG_PATH = "logs/llm-calls.jsonl";
export function logLlmCall(record) {
    try {
        fs.mkdirSync("logs", { recursive: true });
        fs.appendFileSync(LOG_PATH, JSON.stringify(record) + "\n", "utf8");
    }
    catch {
        // Logging failures must never break the actual LLM pipeline.
    }
}
const QUOTA_PATTERN = /(rate.?limit|usage.?limit|quota|429|too many requests|credit.?balance|insufficient.?balance)/i;
const AUTH_PATTERN = /(401|403|unauthorized|invalid.?api.?key|authentication|forbidden)/i;
export function classifyError(blob) {
    if (!blob.trim())
        return null;
    if (/timeout|timed out|etimedout/i.test(blob))
        return "timeout";
    if (QUOTA_PATTERN.test(blob))
        return "quota";
    if (AUTH_PATTERN.test(blob))
        return "auth";
    return "other";
}
