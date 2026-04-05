import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { execFile } from "child_process";
import { promisify } from "util";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

const execFileAsync = promisify(execFile);

dotenv.config({ path: "/opt/vision-mcp/config.env" });

const PORT = parseInt(process.env.VISION_MCP_PORT || "18092");
const TEMP_DIR = process.env.VIDEO_TEMP_DIR || "/tmp/vision-mcp-videos";
const PUB_DIR = "/var/www/html/tmp";
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50MB
const MAX_CONCURRENCY = 2;

// SSE path: the external path clients see (through Nginx), eliminates sub_filter dependency
const SSE_MSG_PATH = process.env.SSE_MSG_PATH || "/terminal/messages";

// ========== Concurrency control (lightweight semaphore, zero deps) ==========

class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  acquire() {
    return new Promise(resolve => {
      if (this.active < this.max) {
        this.active++;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }
  release() {
    this.active--;
    if (this.queue.length > 0) {
      this.active++;
      const next = this.queue.shift();
      next();
    }
  }
  get pending() { return this.queue.length; }
}

const taskSemaphore = new Semaphore(MAX_CONCURRENCY);

// ========== Startup cleanup ==========

function cleanupOnStartup() {
  for (const dir of [TEMP_DIR, PUB_DIR]) {
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); continue; }
    try {
      const files = fs.readdirSync(dir);
      let cleaned = 0;
      for (const f of files) {
        if (/\.(mp4|webm|mkv|tmp)$/i.test(f)) {
          try { fs.unlinkSync(path.join(dir, f)); cleaned++; } catch {}
        }
      }
      if (cleaned > 0) console.log(`\uD83E\uDDF9 Startup cleanup: ${dir} removed ${cleaned} leftover files`);
    } catch {}
  }
}
cleanupOnStartup();

const BILI_COOKIE_PATH = "/home/ubuntu/bilibili-mcp-server/config.yml";

// ========== Model catalog ==========

const MODEL_CATALOG = {
  "gemini-2.5-flash":       { provider: "gemini", desc: "Free tier, fast and cheap" },
  "gemini-2.5-pro":         { provider: "gemini", desc: "Free tier, stronger reasoning" },
  "gemini-3-flash-preview": { provider: "gemini", desc: "Latest Flash, frontier-level" },
  "gemini-3.1-pro-preview": { provider: "gemini", desc: "Strongest Gemini, paid only" },
  "qwen3.5-omni-plus":      { provider: "dashscope", desc: "Omnimodal flagship, 215 SOTA" },
  "qwen3.5-omni-flash":     { provider: "dashscope", desc: "Omnimodal mid-tier" },
  "qwen3.5-omni-light":     { provider: "dashscope", desc: "Omnimodal lightweight" },
  "qwen3-vl-plus":          { provider: "dashscope", desc: "Vision flagship" },
  "qwen3-vl-flash":         { provider: "dashscope", desc: "Vision fast" },
  "qwen3.6-plus":           { provider: "dashscope", desc: "Latest flagship" },
  "qwen3.5-plus":           { provider: "dashscope", desc: "Native multimodal" },
  "qwen3.5-flash":          { provider: "dashscope", desc: "Native multimodal, cost-effective" },
  "kimi-k2.5":              { provider: "dashscope", desc: "Fallback via DashScope" },
};

const DEFAULTS = {
  gemini: "gemini-2.5-flash",
  dashscope: "qwen3.5-plus",
  fallback: "kimi-k2.5",
};

// ========== Security ==========

function validateUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("Invalid URL"); }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only HTTP/HTTPS protocols allowed");
  }
  const hostname = parsed.hostname.toLowerCase();
  const blocked = [
    /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
    /^0\./, /^localhost$/i, /^::1$/, /^fe80:/i,
    /^169\.254\./, /^metadata\./i,
    /^100\.(6[4-9]|[7-9]\d|1[0-2][0-9]|12[0-7])\./,
  ];
  if (blocked.some(r => r.test(hostname))) {
    throw new Error("Access to internal/metadata addresses is not allowed");
  }
}

// ========== Utilities ==========

function isYouTubeUrl(url) {
  return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(url);
}
function isBilibiliUrl(url) {
  return /^https?:\/\/(www\.)?(bilibili\.com|b23\.tv)\//.test(url);
}
function cleanup(...fps) {
  for (const fp of fps) {
    try { if (fp && fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
  }
}
function cleanupSet(s) {
  for (const fp of s) cleanup(fp);
}

function getBiliCookie() {
  try {
    const yml = fs.readFileSync(BILI_COOKIE_PATH, "utf-8");
    const match = yml.match(/^Cookie:\s*(.+)$/m);
    return match ? match[1].trim() : null;
  } catch { return null; }
}

function extractBvid(url) {
  const m = url.match(/BV[a-zA-Z0-9]+/);
  return m ? m[0] : null;
}

// ========== Download (secure: execFile + arg arrays, no shell injection) ==========

async function downloadBilibili(url) {
  const bvid = extractBvid(url);
  if (!bvid) throw new Error("Cannot extract BV ID from URL");

  const cookie = getBiliCookie();
  if (!cookie) throw new Error("Bilibili cookie not available");

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0";
  const commonArgs = ["-s", "-H", `Cookie: ${cookie}`, "-H", `User-Agent: ${UA}`, "-H", "Referer: https://www.bilibili.com/"];

  const t0 = Date.now();

  const { stdout: infoJson } = await execFileAsync("curl", [
    ...commonArgs,
    `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`
  ], { timeout: 15000 });

  const info = JSON.parse(infoJson);
  if (info.code !== 0) throw new Error(`Bilibili API error: ${info.message}`);

  const { cid, title, duration } = info.data;
  console.log(`\uD83D\uDCFA Bilibili: ${title} (${duration}s)`);

  const { stdout: playJson } = await execFileAsync("curl", [
    ...commonArgs,
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=32&fnval=1`
  ], { timeout: 15000 });

  const play = JSON.parse(playJson);
  if (play.code !== 0 || !play.data?.durl?.[0]) throw new Error("Bilibili playurl failed");

  const videoUrl = play.data.durl[0].url;
  const uid = crypto.randomUUID();
  const filepath = path.join(TEMP_DIR, `bili_${uid}.mp4`);

  await execFileAsync("curl", [
    "-s", "-L",
    "--max-filesize", String(MAX_DOWNLOAD_BYTES),
    "-o", filepath,
    "-H", "Referer: https://www.bilibili.com/",
    "-H", `User-Agent: ${UA}`,
    videoUrl
  ], { timeout: 180000 });

  const dlMs = Date.now() - t0;
  const stats = fs.statSync(filepath);
  console.log(`\uD83D\uDCE5 Bilibili download: ${(stats.size / 1024 / 1024).toFixed(1)}MB, ${dlMs}ms`);

  if (stats.size > 2 * 1024 * 1024) {
    const compressed = path.join(PUB_DIR, `v_${uid}.mp4`);
    const maxDur = Math.min(duration, 300);
    const t1 = Date.now();
    await execFileAsync("ffmpeg", [
      "-i", filepath,
      "-t", String(maxDur),
      "-vf", "scale=320:-2",
      "-b:v", "200k",
      "-an", "-y",
      compressed
    ], { timeout: 120000 });

    fs.unlinkSync(filepath);
    const compStats = fs.statSync(compressed);
    console.log(`\uD83D\uDDDC\uFE0F Compressed: ${(stats.size / 1024 / 1024).toFixed(1)}MB -> ${(compStats.size / 1024 / 1024).toFixed(1)}MB, ${Date.now() - t1}ms`);
    return compressed;
  }

  return filepath;
}

async function downloadOther(url) {
  validateUrl(url);
  const uid = crypto.randomUUID();
  const filepath = path.join(TEMP_DIR, `video_${uid}.mp4`);

  const t0 = Date.now();
  const ytdlpPath = "/home/ubuntu/.local/bin/yt-dlp";
  await execFileAsync(ytdlpPath, [
    "-f", "bestvideo[height<=480]+bestaudio/best[height<=480]/best",
    "--merge-output-format", "mp4",
    "-o", filepath,
    url,
    "--no-playlist",
    "--quiet",
    "--max-filesize", `${MAX_DOWNLOAD_BYTES}`
  ], { timeout: 180000, env: { ...process.env, PATH: process.env.PATH + ":/home/ubuntu/.local/bin" } });

  const stats = fs.statSync(filepath);
  console.log(`\uD83D\uDCE5 yt-dlp download: ${(stats.size / 1024 / 1024).toFixed(1)}MB, ${Date.now() - t0}ms`);
  return filepath;
}

// ========== Gemini ==========

async function callGemini(source, prompt, model, isFile) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.startsWith("YOUR_")) throw new Error("Gemini not configured");

  const ai = new GoogleGenAI({ apiKey });
  const parts = [];

  if (isFile) {
    const uploadResult = await ai.files.upload({ file: source, config: { mimeType: "video/mp4" } });
    let file = uploadResult;
    while (file.state === "PROCESSING") {
      await new Promise(r => setTimeout(r, 3000));
      file = await ai.files.get({ name: file.name });
    }
    if (file.state === "FAILED") throw new Error("Gemini file processing failed");
    parts.push({ fileData: { fileUri: file.uri, mimeType: "video/mp4" } });
  } else if (isYouTubeUrl(source)) {
    parts.push({ fileData: { fileUri: source, mimeType: "video/mp4" } });
  } else {
    throw new Error("Gemini only supports YouTube URLs or local files");
  }

  parts.push({ text: prompt });
  const result = await ai.models.generateContent({ model, contents: [{ role: "user", parts }] });
  return result.text || "(No response from Gemini)";
}

// ========== DashScope ==========

function getDashScopeClient(region) {
  const keyEnv = region === "singapore" ? "DASHSCOPE_API_KEY_SINGAPORE" : "DASHSCOPE_API_KEY_BEIJING";
  const baseURL = region === "singapore"
    ? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
    : "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const apiKey = process.env[keyEnv];
  if (!apiKey || apiKey.startsWith("YOUR_")) throw new Error(`DashScope ${region} not configured`);
  return new OpenAI({ apiKey, baseURL });
}

async function callDashScope(source, prompt, model, isFile, region, filesToClean) {
  if (isFile) {
    let pubPath;
    if (!source.startsWith(PUB_DIR)) {
      const uid = crypto.randomUUID();
      pubPath = path.join(PUB_DIR, `ds_${uid}.mp4`);
      fs.copyFileSync(source, pubPath);
    } else {
      pubPath = source;
    }
    filesToClean.add(pubPath);
    source = `https://qiyun.cloud/tmp/${path.basename(pubPath)}`;
    isFile = false;
  }

  const client = getDashScopeClient(region);
  const videoContent = { type: "video_url", video_url: { url: source } };

  const resp = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: [videoContent, { type: "text", text: prompt }] }],
  });

  return resp.choices?.[0]?.message?.content || "(No response)";
}

// ========== Smart routing ==========

async function watchVideo(source, prompt, model) {
  const filesToClean = new Set();
  const isFileInput = !source.startsWith("http");
  const totalT0 = Date.now();

  try {
    let localFile = null;

    if (!isFileInput) {
      if (isBilibiliUrl(source)) {
        console.log("\uD83D\uDCE5 Bilibili URL, downloading via API...");
        localFile = await downloadBilibili(source);
        filesToClean.add(localFile);
      } else if (!isYouTubeUrl(source)) {
        console.log("\uD83D\uDCE5 Other URL, downloading via yt-dlp...");
        localFile = await downloadOther(source);
        filesToClean.add(localFile);
      }
    }

    const actualSource = localFile || source;
    const isFile = localFile !== null || isFileInput;

    let attempts = [];

    if (model !== "auto") {
      const info = MODEL_CATALOG[model];
      if (!info) throw new Error(`Unknown model: ${model}`);
      if (info.provider === "gemini") {
        attempts = [{ fn: () => callGemini(actualSource, prompt, model, isFile), label: model }];
      } else {
        attempts = [
          { fn: () => callDashScope(actualSource, prompt, model, isFile, "beijing", filesToClean), label: `${model} (Beijing)` },
          { fn: () => callDashScope(actualSource, prompt, model, isFile, "singapore", filesToClean), label: `${model} (Singapore)` },
        ];
      }
    } else {
      if (isYouTubeUrl(source) && !localFile) {
        attempts = [
          { fn: () => callGemini(actualSource, prompt, DEFAULTS.gemini, false), label: DEFAULTS.gemini },
          { fn: () => callDashScope(actualSource, prompt, DEFAULTS.dashscope, false, "beijing", filesToClean), label: `${DEFAULTS.dashscope} (Beijing)` },
          { fn: () => callDashScope(actualSource, prompt, DEFAULTS.dashscope, false, "singapore", filesToClean), label: `${DEFAULTS.dashscope} (Singapore)` },
          { fn: () => callDashScope(actualSource, prompt, DEFAULTS.fallback, false, "beijing", filesToClean), label: `${DEFAULTS.fallback} (Beijing)` },
        ];
      } else {
        attempts = [
          { fn: () => callDashScope(actualSource, prompt, DEFAULTS.dashscope, isFile, "beijing", filesToClean), label: `${DEFAULTS.dashscope} (Beijing)` },
          { fn: () => callDashScope(actualSource, prompt, DEFAULTS.dashscope, isFile, "singapore", filesToClean), label: `${DEFAULTS.dashscope} (Singapore)` },
          { fn: () => callGemini(actualSource, prompt, DEFAULTS.gemini, isFile), label: DEFAULTS.gemini },
          { fn: () => callDashScope(actualSource, prompt, DEFAULTS.fallback, isFile, "beijing", filesToClean), label: `${DEFAULTS.fallback} (Beijing)` },
        ];
      }
    }

    for (const { fn, label } of attempts) {
      try {
        console.log(`\uD83D\uDC41\uFE0F Trying ${label}...`);
        const t0 = Date.now();
        const result = await fn();
        console.log(`\u2705 ${label} done, inference ${Date.now() - t0}ms, total ${Date.now() - totalT0}ms`);
        return { result, usedModel: label };
      } catch (err) {
        console.log(`\u26A0\uFE0F ${label} failed: ${err.message}`);
      }
    }

    throw new Error("All video understanding services unavailable");

  } finally {
    cleanupSet(filesToClean);
  }
}

// ========== MCP tool registration ==========

const MODEL_NAMES = ["auto", ...Object.keys(MODEL_CATALOG)];

function registerTools(s) {
  s.registerTool(
    "watch_video",
    {
      title: "Watch Video",
      description: `Video understanding via multi-provider routing.\nauto = smart routing, or specify a model.\nBilibili via API download, YouTube direct to Gemini.\nConcurrency limit: ${MAX_CONCURRENCY}, excess requests queued.`,
      inputSchema: {
        source: z.string().describe("Video URL (YouTube/Bilibili/etc) or local file path"),
        prompt: z.string().default("Describe this video in detail, including visuals, audio, and text.").describe("What to look for"),
        model: z.enum(MODEL_NAMES).default("auto").describe("Model to use, auto = smart routing"),
      },
    },
    async ({ source, prompt, model }) => {
      const queuePos = taskSemaphore.pending;
      if (queuePos > 0) {
        console.log(`\u23F3 Queued... ${queuePos} ahead, ${taskSemaphore.active}/${taskSemaphore.max} active`);
      }

      await taskSemaphore.acquire();
      console.log(`\uD83D\uDD13 Acquired slot (${taskSemaphore.active}/${taskSemaphore.max} active, ${taskSemaphore.pending} queued)`);

      try {
        const { result, usedModel } = await watchVideo(source, prompt, model);
        return { content: [{ type: "text", text: `\uD83D\uDC41\uFE0F [${usedModel}]\n\n${result}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `\u274C Video understanding failed: ${err.message}` }], isError: true };
      } finally {
        taskSemaphore.release();
        console.log(`\uD83D\uDD13 Released slot (${taskSemaphore.active}/${taskSemaphore.max} active, ${taskSemaphore.pending} queued)`);
      }
    }
  );

  s.registerTool(
    "vision_status",
    {
      title: "Vision Status",
      description: "Check configuration status of all providers and list available models.",
      inputSchema: {},
    },
    async () => {
      const ok = k => {
        const v = process.env[k];
        return v && !v.startsWith("YOUR_") ? "\u2705" : "\u274C";
      };
      const biliOk = getBiliCookie() ? "\u2705" : "\u274C";
      const ytdlpOk = fs.existsSync("/home/ubuntu/.local/bin/yt-dlp") ? "\u2705" : "\u274C";
      let ffmpegOk;
      try { await execFileAsync("which", ["ffmpeg"]); ffmpegOk = "\u2705"; } catch { ffmpegOk = "\u274C"; }
      const lines = [
        "Vision MCP — Service Status",
        "",
        `Gemini:        ${ok("GEMINI_API_KEY")}`,
        `DashScope BJ:  ${ok("DASHSCOPE_API_KEY_BEIJING")}  (Qwen + Kimi)`,
        `DashScope SG:  ${ok("DASHSCOPE_API_KEY_SINGAPORE")}`,
        `Bilibili:      ${biliOk}`,
        "",
        "Available models:",
        ...Object.entries(MODEL_CATALOG).map(([name, { desc }]) => `  ${name} — ${desc}`),
        "",
        `yt-dlp:  ${ytdlpOk}`,
        `ffmpeg:  ${ffmpegOk}`,
        `Concurrency: ${taskSemaphore.active}/${MAX_CONCURRENCY} active, ${taskSemaphore.pending} queued`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

// ========== SSE Transport ==========

function createServer() {
  const s = new McpServer({ name: "vision-mcp-server", version: "1.3.0" });
  registerTools(s);
  return s;
}

const app = express();
const sessions = {};

app.get("/sse", async (req, res) => {
  const srv = createServer();
  const transport = new SSEServerTransport(SSE_MSG_PATH, res);
  sessions[transport.sessionId] = { transport, server: srv };
  res.on("close", () => { srv.close(); delete sessions[transport.sessionId]; });
  await srv.connect(transport);
});

app.post("/terminal/messages", async (req, res) => {
  const sid = req.query.sessionId;
  const entry = sessions[sid];
  if (!entry) return res.status(400).json({ error: "Unknown session" });
  await entry.transport.handlePostMessage(req, res);
});

app.get("/health", (_, res) => {
  res.json({
    status: "ok",
    name: "vision-mcp",
    version: "1.3.0",
    models: Object.keys(MODEL_CATALOG).length,
    concurrency: { active: taskSemaphore.active, max: MAX_CONCURRENCY, queued: taskSemaphore.pending },
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Vision MCP v1.3 started: http://0.0.0.0:${PORT}`);
  console.log(`  Models: ${Object.keys(MODEL_CATALOG).length}`);
  console.log(`  Bilibili cookie: ${getBiliCookie() ? "OK" : "N/A"}`);
  console.log(`  Security: SSRF \u2705 | Injection \u2705 | Cleanup \u2705`);
  console.log(`  Concurrency: max ${MAX_CONCURRENCY}, excess queued`);
  console.log(`  SSE path: ${SSE_MSG_PATH}`);
  console.log(`  Tools: watch_video, vision_status`);
});
