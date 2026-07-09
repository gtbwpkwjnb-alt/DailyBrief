/**
 * Local dev server for DailyBrief.
 *
 * Provides:
 *   - Static file serving from daily_reports/
 *   - POST /api/refetch/:sourceId — single-source manual refetch
 *
 * Usage: npm run serve
 */
import "./_env";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllSources } from "../lib/sources/registry";
import { fetchSource } from "../lib/sources/dispatch";
import { renderHtml } from "../lib/output/render";
import { groupRaw } from "../lib/output/render";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PORT = parseInt(process.env.SERVE_PORT || "3456", 10);
const REPORTS_DIR = path.resolve(PROJECT_ROOT, "daily_reports");
/**
 * Find the latest report date directory.
 */
function latestDateDir() {
    if (!fs.existsSync(REPORTS_DIR))
        return null;
    const dirs = fs.readdirSync(REPORTS_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
    return dirs[0] ?? null;
}
/**
 * Load the latest report + articles sidecar.
 */
function loadLatest() {
    const dateDir = latestDateDir();
    if (!dateDir)
        return null;
    const base = path.join(REPORTS_DIR, dateDir, dateDir);
    const reportJson = `${base}.json`;
    const articlesJson = `${base}-articles.json`;
    if (!fs.existsSync(reportJson) || !fs.existsSync(articlesJson))
        return null;
    const report = JSON.parse(fs.readFileSync(reportJson, "utf8"));
    const sidecar = JSON.parse(fs.readFileSync(articlesJson, "utf8"));
    return { report, articles: sidecar.articles, date: dateDir, failedSources: sidecar.failedSources };
}
/**
 * Load all source defs so we can look up a source by ID.
 */
const allSources = loadAllSources();
const sourceById = new Map(allSources.map((s) => [s.id, s]));
const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".css": "text/css",
    ".js": "application/javascript",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
};
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);
    // ---- API: single-source refetch ----
    if (url.pathname.startsWith("/api/refetch/") && req.method === "POST") {
        const sourceId = decodeURIComponent(url.pathname.slice("/api/refetch/".length));
        const source = sourceById.get(sourceId);
        if (!source) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: `Unknown source: ${sourceId}` }));
            return;
        }
        try {
            console.log(`[serve] refetching ${sourceId}…`);
            // Use a longer timeout for manual refetch (30s vs 8s for RSS)
            const items = await fetchSource(source);
            console.log(`[serve] ${sourceId}: got ${items.length} items`);
            // Merge new items into the latest articles sidecar
            const latest = loadLatest();
            if (latest) {
                const existingUrls = new Set(latest.articles.map((a) => a.url));
                const newItems = items.filter((it) => !existingUrls.has(it.url));
                if (newItems.length > 0) {
                    latest.articles.push(...newItems.map((it) => ({ ...it, source: source.name })));
                    // Re-render HTML with updated data
                    const raw = groupRaw(latest.articles, allSources);
                    const dateDir = latest.date;
                    const base = path.join(REPORTS_DIR, dateDir, dateDir);
                    // Remove failed source from list if it succeeded
                    latest.failedSources = (latest.failedSources ?? []).filter((f) => f.id !== sourceId);
                    const html = renderHtml(latest.report, raw, latest.date, latest.failedSources);
                    fs.writeFileSync(`${base}.html`, html, "utf8");
                    fs.writeFileSync(`${base}-articles.json`, JSON.stringify({ date: latest.date, articles: latest.articles, failedSources: latest.failedSources }, null, 2), "utf8");
                    console.log(`[serve] merged ${newItems.length} new items, re-rendered HTML`);
                }
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, count: items.length, newCount: items.length }));
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[serve] refetch ${sourceId} failed: ${msg}`);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: msg }));
        }
        return;
    }
    // ---- Static file serving ----
    let urlPath = url.pathname === "/" ? "/index.html" : url.pathname;
    // Remove leading slash for path.join
    let filePath = urlPath.slice(1);
    // If requesting a date like /2026-07-08, serve the HTML for that date
    if (/^\d{4}-\d{2}-\d{2}\/?$/.test(urlPath)) {
        const dateDir = urlPath.replace(/\/$/, "");
        filePath = `${dateDir}/${dateDir}.html`;
    }
    const fullPath = path.resolve(REPORTS_DIR, filePath).replace(/\\/g, "/");
    const reportsDirNorm = REPORTS_DIR.replace(/\\/g, "/");
    console.log(`[serve] GET ${url.pathname} → filePath=${filePath} → fullPath=${fullPath} → reportsDir=${reportsDirNorm} → startsWith=${fullPath.startsWith(reportsDirNorm)} → exists=${fs.existsSync(fullPath)}`);
    // Security: prevent directory traversal
    if (!fullPath.startsWith(reportsDirNorm)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
        res.writeHead(404);
        res.end(`Not found: ${fullPath}`);
        return;
    }
    const ext = path.extname(fullPath);
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    const content = fs.readFileSync(fullPath);
    res.writeHead(200, { "Content-Type": mime });
    res.end(content);
});
server.listen(PORT, () => {
    console.log(`[serve] DailyBrief dev server running at http://localhost:${PORT}`);
    const latest = latestDateDir();
    if (latest) {
        console.log(`[serve] Latest report: http://localhost:${PORT}/${latest}`);
    }
    else {
        console.log(`[serve] No reports found in ${REPORTS_DIR}`);
    }
});
