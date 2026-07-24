/**
 * Local dev server for DailyBrief (v2).
 *
 * Provides:
 *   - Static file serving from daily_reports/
 *   - POST /api/run — start a local run with optional incremental keywords
 *   - GET /api/run/status — live local run state and recent logs
 *   - POST /api/refetch/:sourceId — single-source manual refetch
 *
 * Usage: npm run serve
 */
import "./_env";

console.log("[serve] loading serve.ts v2");

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadAllSources } from "../lib/sources/registry";
import { fetchSource } from "../lib/sources/dispatch";
import { filterFreshArticles } from "../lib/sources/freshness";
import { renderHtml } from "../lib/output/render";
import { groupRaw } from "../lib/output/render";
import type { FilterProfile, RunStats } from "../lib/output/render";
import { parseReportSidecar } from "../lib/output/sidecar";
import type { DailyReport, ArticleInput } from "../lib/ai/pipeline";
import { normalizeCustomKeywords } from "../lib/editorial/context";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PORT = parseInt(process.env.SERVE_PORT || "3456", 10);
const HOST = process.env.SERVE_HOST || "127.0.0.1";
const REPORTS_DIR = path.resolve(PROJECT_ROOT, "daily_reports");

type RunState = {
  status: "idle" | "running" | "success" | "error";
  stage: string;
  progress: number;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  logs: string[];
  stats?: RunStats;
  filterProfile?: FilterProfile;
};

let runState: RunState = { status: "idle", stage: "等待运行", progress: 0, logs: [] };

function stageFromLine(line: string): { stage: string; progress: number } | null {
  if (line.includes("network preflight")) return { stage: "网络预检", progress: 5 };
  if (line.includes("fetching sources")) return { stage: "收集信息源", progress: 10 };
  if (line.includes("source health")) return { stage: "来源质量检查", progress: 35 };
  if (line.includes("consolidated AI enrichment")) return { stage: "翻译与精炼", progress: 42 };
  if (line.includes("enrichment done")) return { stage: "翻译与精炼", progress: 60 };
  if (line.includes("analyzing watchlist")) return { stage: "市场数据分析", progress: 68 };
  if (line.includes("generating digest")) return { stage: "生成每日摘要", progress: 76 };
  if (line.includes("category summaries")) return { stage: "整理栏目观点", progress: 86 };
  if (line.includes("quality review")) return { stage: "质量审核", progress: 93 };
  if (line.includes("wrote daily_reports")) return { stage: "写入报告", progress: 98 };
  if (line.includes("[daily] done")) return { stage: "完成", progress: 100 };
  return null;
}

function appendRunOutput(chunk: string): void {
  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    runState.logs.push(line);
    if (runState.logs.length > 30) runState.logs.splice(0, runState.logs.length - 30);
    const next = stageFromLine(line);
    if (next && next.progress >= runState.progress) {
      runState.stage = next.stage;
      runState.progress = next.progress;
    }
  }
}

function startDailyRun(customKeywords: string[]): void {
  runState = {
    status: "running",
    stage: "启动任务",
    progress: 2,
    startedAt: new Date().toISOString(),
    logs: [],
  };
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npmCommand, ["run", "daily"], {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    env: { ...process.env, DAILY_CUSTOM_KEYWORDS_JSON: JSON.stringify(customKeywords) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => appendRunOutput(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => appendRunOutput(chunk.toString("utf8")));
  child.on("error", (error) => {
    appendRunOutput(`启动失败: ${error.message}`);
    runState = { ...runState, status: "error", stage: "启动失败", finishedAt: new Date().toISOString() };
  });
  child.on("close", (code) => {
    const success = code === 0;
    const latest = success ? loadLatest() : null;
    runState = {
      ...runState,
      status: success ? "success" : "error",
      stage: success ? "运行完成" : "运行失败",
      progress: success ? 100 : runState.progress,
      exitCode: code ?? undefined,
      finishedAt: new Date().toISOString(),
      stats: latest?.runStats,
      filterProfile: latest?.filterProfile,
    };
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isTrustedMutation(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * Find the latest report date directory.
 */
function latestDateDir(): string | null {
  if (!fs.existsSync(REPORTS_DIR)) return null;
  const dirs = fs.readdirSync(REPORTS_DIR)
    .filter((date) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
      const base = path.join(REPORTS_DIR, date, date);
      return fs.existsSync(`${base}.html`)
        && fs.existsSync(`${base}.json`)
        && fs.existsSync(`${base}-articles.json`);
    })
    .sort()
    .reverse();
  return dirs[0] ?? null;
}

/**
 * Load the latest report + articles sidecar.
 */
function loadLatest(): { report: DailyReport; articles: ArticleInput[]; date: string; failedSources?: Array<{ id: string; name: string; reason: string }>; runStats?: RunStats; filterProfile?: FilterProfile } | null {
  const dateDir = latestDateDir();
  if (!dateDir) return null;
  const base = path.join(REPORTS_DIR, dateDir, dateDir);
  const reportJson = `${base}.json`;
  const articlesJson = `${base}-articles.json`;
  if (!fs.existsSync(reportJson) || !fs.existsSync(articlesJson)) return null;
  const report = JSON.parse(fs.readFileSync(reportJson, "utf8")) as DailyReport;
  const sidecar = parseReportSidecar(JSON.parse(fs.readFileSync(articlesJson, "utf8")));
  return { report, articles: sidecar.articles, date: dateDir, failedSources: sidecar.failedSources, runStats: sidecar.runStats, filterProfile: sidecar.filterProfile };
}

/**
 * Load all source defs so we can look up a source by ID.
 */
const allSources = loadAllSources();
const sourceById = new Map(allSources.map((s) => [s.id, s]));

const MIME_TYPES: Record<string, string> = {
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

  if (url.pathname === "/api/run/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(runState));
    return;
  }

  if (url.pathname === "/api/run" && req.method === "POST") {
    if (!isTrustedMutation(req)) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Forbidden origin" }));
      return;
    }
    if (runState.status === "running") {
      res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(runState));
      return;
    }
    let body: { keywords?: unknown } = {};
    try {
      body = await readJsonBody(req) as { keywords?: unknown };
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "invalid request" }));
      return;
    }
    const keywords = normalizeCustomKeywords(Array.isArray(body.keywords) ? body.keywords.map(String) : typeof body.keywords === "string" ? body.keywords : undefined);
    startDailyRun(keywords);
    res.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(runState));
    return;
  }

  // ---- API: single-source refetch ----
  if (url.pathname.startsWith("/api/refetch/") && req.method === "POST") {
    if (!isTrustedMutation(req)) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
      return;
    }
    const sourceId = decodeURIComponent(url.pathname.slice("/api/refetch/".length));
    const source = sourceById.get(sourceId);
    if (!source) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: `Unknown source: ${sourceId}` }));
      return;
    }
    try {
      console.log(`[serve] refetching ${sourceId}…`);
      const items = await fetchSource(source);
      console.log(`[serve] ${sourceId}: got ${items.length} items`);

      // Merge new items into the latest articles sidecar
      const latest = loadLatest();
      if (latest) {
        const existingUrls = new Set(latest.articles.map((a) => a.url));
        const newItems = items.filter((it) => !existingUrls.has(it.url));
        if (newItems.length > 0) {
          latest.articles.push(...newItems.map((it) => ({ ...it, source: source.name })));
          const freshness = filterFreshArticles(latest.articles, allSources);
          latest.articles = freshness.articles;
          if (latest.runStats) latest.runStats = { ...latest.runStats, ...freshness.stats };
          // Re-render HTML with updated data
          const raw = groupRaw(latest.articles, allSources, { customKeywords: latest.filterProfile?.customKeywords });
          const dateDir = latest.date;
          const base = path.join(REPORTS_DIR, dateDir, dateDir);
          // Remove failed source from list if it succeeded
          latest.failedSources = (latest.failedSources ?? []).filter((f) => f.id !== sourceId);
          const html = renderHtml(latest.report, raw, latest.date, latest.failedSources, undefined, undefined, latest.runStats, latest.filterProfile);
          fs.writeFileSync(`${base}.html`, html, "utf8");
          fs.writeFileSync(`${base}-articles.json`, JSON.stringify({ date: latest.date, articles: latest.articles, failedSources: latest.failedSources, runStats: latest.runStats, filterProfile: latest.filterProfile }, null, 2), "utf8");
          console.log(`[serve] merged ${newItems.length} new items, re-rendered HTML`);
        }
        if (items.length > 0) {
          latest.failedSources = (latest.failedSources ?? []).filter((f) => f.id !== sourceId);
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, count: items.length, newCount: items.length }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[serve] refetch ${sourceId} failed: ${msg}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return;
  }

  // ---- Static file serving ----
  let urlPath = url.pathname === "/" ? "/index.html" : url.pathname;
  // Remove leading slash
  let filePath = urlPath.slice(1);

  // If requesting a date like /2026-07-08, serve the HTML for that date
  if (/^\d{4}-\d{2}-\d{2}\/?$/.test(filePath)) {
    const dateDir = filePath.replace(/\/$/, "");
    filePath = `${dateDir}/${dateDir}.html`;
  }

  const fullPath = path.resolve(REPORTS_DIR, filePath).replace(/\\/g, "/");
  const reportsDirNorm = REPORTS_DIR.replace(/\\/g, "/");
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

server.listen(PORT, HOST, () => {
  console.log(`[serve] DailyBrief dev server running at http://${HOST}:${PORT}`);
  const latest = latestDateDir();
  if (latest) {
    console.log(`[serve] Latest report: http://${HOST}:${PORT}/${latest}`);
  } else {
    console.log(`[serve] No reports found in ${REPORTS_DIR}`);
  }
});
