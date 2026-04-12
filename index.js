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

// SSE 路径：客户端（经 Nginx）看到的外部路径，消除 sub_filter 依赖
const SSE_MSG_PATH = process.env.SSE_MSG_PATH || "/terminal/messages";

// ========== 并发控制（轻量信号量，零依赖）==========

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

// ========== 启动时清理残留 ==========

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
      if (cleaned > 0) console.log(`🧹 启动清理: ${dir} 删除 ${cleaned} 个残留文件`);
    } catch {}
  }
}
cleanupOnStartup();

// B站 cookie 路径
const BILI_COOKIE_PATH = "/home/ubuntu/bilibili-mcp-server/config.yml";

// ========== 模型目录 ==========

const MODEL_CATALOG = {
  "gemini-2.5-flash":       { provider: "gemini", desc: "免费层主力，快速便宜" },
  "gemini-2.5-pro":         { provider: "gemini", desc: "免费层可用，更强推理" },
  "gemini-3-flash-preview": { provider: "gemini", desc: "最新Flash，frontier级" },
  "gemini-3.1-pro-preview": { provider: "gemini", desc: "最强Gemini，付费专享" },
  "qwen3.5-omni-plus":      { provider: "dashscope", desc: "全模态旗舰，215项SOTA" },
  "qwen3.5-omni-flash":     { provider: "dashscope", desc: "全模态中端" },
  "qwen3.5-omni-light":     { provider: "dashscope", desc: "全模态轻量" },
  "qwen3-vl-plus":          { provider: "dashscope", desc: "视觉旗舰" },
  "qwen3-vl-flash":         { provider: "dashscope", desc: "视觉快速" },
  "qwen3.6-plus":           { provider: "dashscope", desc: "最新旗舰" },
  "qwen3.5-plus":           { provider: "dashscope", desc: "原生多模态" },
  "qwen3.5-flash":          { provider: "dashscope", desc: "原生多模态高性价比" },
  "kimi-k2.5":              { provider: "dashscope", desc: "兜底备选，百炼调用" },
};

const DEFAULTS = {
  gemini: "gemini-2.5-flash",
  dashscope: "qwen3.5-plus",
  fallback: "kimi-k2.5",
};

// ========== 安全校验 ==========

function validateUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("无效的 URL"); }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("仅支持 HTTP/HTTPS 协议");
  }
  const hostname = parsed.hostname.toLowerCase();
  const blocked = [
    /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
    /^0\./, /^localhost$/i, /^::1$/, /^fe80:/i,
    /^169\.254\./, /^metadata\./i,
    /^100\.(6[4-9]|[7-9]\d|1[0-2][0-9]|12[0-7])\./,
  ];
  if (blocked.some(r => r.test(hostname))) {
    throw new Error("不允许访问内网或元数据地址");
  }
}

// ========== 工具函数 ==========

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

// ========== 下载函数（安全版）==========

async function downloadBilibili(url) {
  const bvid = extractBvid(url);
  if (!bvid) throw new Error("无法从URL中提取BV号");

  const cookie = getBiliCookie();
  if (!cookie) throw new Error("B站 cookie 不可用");

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0";
  const commonArgs = ["-s", "-H", `Cookie: ${cookie}`, "-H", `User-Agent: ${UA}`, "-H", "Referer: https://www.bilibili.com/"];

  const t0 = Date.now();

  const { stdout: infoJson } = await execFileAsync("curl", [
    ...commonArgs,
    `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`
  ], { timeout: 15000 });

  const info = JSON.parse(infoJson);
  if (info.code !== 0) throw new Error(`B站视频信息获取失败: ${info.message}`);

  const { cid, title, duration } = info.data;
  console.log(`📺 B站: ${title} (${duration}秒)`);

  const { stdout: playJson } = await execFileAsync("curl", [
    ...commonArgs,
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=32&fnval=1`
  ], { timeout: 15000 });

  const play = JSON.parse(playJson);
  if (play.code !== 0 || !play.data?.durl?.[0]) throw new Error("B站播放地址获取失败");

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
  console.log(`📥 B站下载完成: ${(stats.size / 1024 / 1024).toFixed(1)}MB, 耗时 ${dlMs}ms`);

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
    console.log(`🗜️ 压缩完成: ${(stats.size / 1024 / 1024).toFixed(1)}MB → ${(compStats.size / 1024 / 1024).toFixed(1)}MB, 耗时 ${Date.now() - t1}ms`);
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
  console.log(`📥 yt-dlp 下载完成: ${(stats.size / 1024 / 1024).toFixed(1)}MB, 耗时 ${Date.now() - t0}ms`);
  return filepath;
}

// ========== Gemini ==========

async function callGemini(source, prompt, model, isFile) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.startsWith("YOUR_")) throw new Error("Gemini 未配置");

  const ai = new GoogleGenAI({ apiKey });
  const parts = [];

  if (isFile) {
    const uploadResult = await ai.files.upload({ file: source, config: { mimeType: "video/mp4" } });
    let file = uploadResult;
    while (file.state === "PROCESSING") {
      await new Promise(r => setTimeout(r, 3000));
      file = await ai.files.get({ name: file.name });
    }
    if (file.state === "FAILED") throw new Error("Gemini 文件处理失败");
    parts.push({ fileData: { fileUri: file.uri, mimeType: "video/mp4" } });
  } else if (isYouTubeUrl(source)) {
    parts.push({ fileData: { fileUri: source, mimeType: "video/mp4" } });
  } else {
    throw new Error("Gemini 只支持 YouTube URL 或本地文件");
  }

  parts.push({ text: prompt });
  const result = await ai.models.generateContent({ model, contents: [{ role: "user", parts }] });
  return result.text || "(Gemini 未返回内容)";
}

// ========== DashScope ==========

function getDashScopeClient(region) {
  const keyEnv = region === "singapore" ? "DASHSCOPE_API_KEY_SINGAPORE" : "DASHSCOPE_API_KEY_BEIJING";
  const baseURL = region === "singapore"
    ? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
    : "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const apiKey = process.env[keyEnv];
  if (!apiKey || apiKey.startsWith("YOUR_")) throw new Error(`百炼 ${region} 未配置`);
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

  return resp.choices?.[0]?.message?.content || "(未返回内容)";
}

// ========== 混元图片理解（专用于看图片，便宜）==========

function getHunyuanClient() {
  const apiKey = process.env.HUNYUAN_API_KEY;
  if (!apiKey || apiKey.startsWith("YOUR_")) throw new Error("混元 未配置");
  return new OpenAI({
    apiKey,
    baseURL: "https://api.hunyuan.cloud.tencent.com/v1",
  });
}

async function callHunyuanImage(imageUrl, prompt, model) {
  const client = getHunyuanClient();
  const useModel = model || process.env.HUNYUAN_IMAGE_MODEL || "hunyuan-vision";

  // 策略：优先直传URL，失败后fallback到base64（兼容防盗链/签名URL场景）
  try {
    console.log("🖼️ 混元直传URL尝试...");
    const result = await client.chat.completions.create({
      model: useModel,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageUrl } },
          { type: "text", text: prompt },
        ],
      }],
    });
    const text = result.choices?.[0]?.message?.content;
    if (text) return text;
  } catch (urlErr) {
    console.log(`⚠️ 混元URL直传失败: ${urlErr.message}, 回退到base64...`);
  }

  // fallback: 下载图片转base64
  let base64Data;
  try {
    const resp = await fetch(imageUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0) throw new Error("下载内容为空");
    base64Data = buf.toString("base64");
  } catch (err) {
    throw new Error(`图片下载失败(base64 fallback): ${err.message}`);
  }

  const ext = imageUrl.split("?")[0].split("!")[0].split(".").pop().toLowerCase();
  const mimeMap = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
  const mime = mimeMap[ext] || "image/jpeg";

  const result = await client.chat.completions.create({
    model: useModel,
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: `data:${mime};base64,${base64Data}` } },
        { type: "text", text: prompt },
      ],
    }],
  });
  return result.choices?.[0]?.message?.content || "(混元未返回内容)";
}

// ========== 智能路由 ==========

async function watchVideo(source, prompt, model) {
  // 图片检测：Content-Type优先，正则启发式兜底
  if (source.startsWith("http")) {
    let isImage = false;
    const useModel = process.env.HUNYUAN_IMAGE_MODEL || "hunyuan-vision";

    // 方法1: HEAD请求检查Content-Type（最可靠）
    try {
      const headResp = await fetch(source, { method: "HEAD", signal: AbortSignal.timeout(5000) });
      const ct = (headResp.headers.get("content-type") || "").toLowerCase();
      if (ct.startsWith("image/")) {
        isImage = true;
        console.log(`🖼️ HEAD检测到图片 (${ct})`);
      }
    } catch {
      // HEAD失败，退回正则检测
    }

    // 方法2: 扩展名/域名启发式（兜底）
    if (!isImage && (/\.(jpe?g|png|gif|webp|bmp)(\?|$|!)/i.test(source) || /xhscdn\.com/i.test(source))) {
      isImage = true;
      console.log("🖼️ 正则启发式检测到图片URL");
    }

    if (isImage) {
      const t0 = Date.now();
      const result = await callHunyuanImage(source, prompt, useModel);
      console.log(`✅ 混元图片理解完成, 耗时 ${Date.now() - t0}ms`);
      return { result, usedModel: `${useModel} (图片)` };
    }
  }

  const filesToClean = new Set();
  const isFileInput = !source.startsWith("http");
  const totalT0 = Date.now();

  try {
    let localFile = null;

    if (!isFileInput) {
      if (isBilibiliUrl(source)) {
        console.log("📥 B站链接，走API下载...");
        localFile = await downloadBilibili(source);
        filesToClean.add(localFile);
      } else if (!isYouTubeUrl(source)) {
        console.log("📥 其他链接，走yt-dlp...");
        localFile = await downloadOther(source);
        filesToClean.add(localFile);
      }
    }

    const actualSource = localFile || source;
    const isFile = localFile !== null || isFileInput;

    let attempts = [];

    if (model !== "auto") {
      const info = MODEL_CATALOG[model];
      if (!info) throw new Error(`未知模型: ${model}`);
      if (info.provider === "gemini") {
        attempts = [{ fn: () => callGemini(actualSource, prompt, model, isFile), label: model }];
      } else {
        attempts = [
          { fn: () => callDashScope(actualSource, prompt, model, isFile, "singapore", filesToClean), label: `${model} (新加坡)` },
          { fn: () => callDashScope(actualSource, prompt, model, isFile, "beijing", filesToClean), label: `${model} (北京)` },
        ];
      }
    } else {
      if (isYouTubeUrl(source) && !localFile) {
        attempts = [
          { fn: () => callGemini(actualSource, prompt, DEFAULTS.gemini, false), label: DEFAULTS.gemini },
          { fn: () => callDashScope(actualSource, prompt, DEFAULTS.dashscope, false, "singapore", filesToClean), label: `${DEFAULTS.dashscope} (新加坡)` },
          { fn: () => callDashScope(actualSource, prompt, DEFAULTS.dashscope, false, "beijing", filesToClean), label: `${DEFAULTS.dashscope} (北京)` },
          { fn: () => callDashScope(actualSource, prompt, DEFAULTS.fallback, false, "beijing", filesToClean), label: `${DEFAULTS.fallback} (北京)` },
        ];
      } else {
        attempts = [
          { fn: () => callDashScope(actualSource, prompt, DEFAULTS.dashscope, isFile, "singapore", filesToClean), label: `${DEFAULTS.dashscope} (新加坡)` },
          { fn: () => callDashScope(actualSource, prompt, DEFAULTS.dashscope, isFile, "beijing", filesToClean), label: `${DEFAULTS.dashscope} (北京)` },
          { fn: () => callGemini(actualSource, prompt, DEFAULTS.gemini, isFile), label: DEFAULTS.gemini },
          { fn: () => callDashScope(actualSource, prompt, DEFAULTS.fallback, isFile, "beijing", filesToClean), label: `${DEFAULTS.fallback} (北京)` },
        ];
      }
    }

    for (const { fn, label } of attempts) {
      try {
        console.log(`👁️ 尝试 ${label}...`);
        const t0 = Date.now();
        const result = await fn();
        console.log(`✅ ${label} 完成, 推理耗时 ${Date.now() - t0}ms, 总耗时 ${Date.now() - totalT0}ms`);
        return { result, usedModel: label };
      } catch (err) {
        console.log(`⚠️ ${label} 失败: ${err.message}`);
      }
    }

    throw new Error("所有视频理解服务均不可用");

  } finally {
    cleanupSet(filesToClean);
  }
}

// ========== MCP 工具注册 ==========

const MODEL_NAMES = ["auto", ...Object.keys(MODEL_CATALOG)];

function registerTools(s) {
  s.registerTool(
    "watch",
    {
      title: "看",
      description: `小克的眼睛。传入URL（视频/图片均可）或文件路径 + prompt，自动识别类型并返回内容描述。\n图片URL（.jpg/.png/.webp等）自动走混元图片理解。\nauto=自动路由，也可指定具体模型。\nB站视频通过API下载，YouTube直传Gemini。\n并发上限: ${MAX_CONCURRENCY}，超出排队等待。`,
      inputSchema: {
        source: z.string().describe("视频/图片URL 或本地文件路径"),
        prompt: z.string().default("请详细描述这个视频的内容，包括画面、声音、文字等信息。").describe("想了解什么"),
        model: z.enum(MODEL_NAMES).default("auto").describe("指定模型，auto=自动路由"),
      },
    },
    async ({ source, prompt, model }) => {
      const queuePos = taskSemaphore.pending;
      if (queuePos > 0) {
        console.log(`⏳ 排队中... 前方 ${queuePos} 个任务，活跃 ${taskSemaphore.active}/${taskSemaphore.max}`);
      }

      await taskSemaphore.acquire();
      console.log(`🔓 获取执行槽 (${taskSemaphore.active}/${taskSemaphore.max} 活跃, ${taskSemaphore.pending} 排队)`);

      try {
        const { result, usedModel } = await watchVideo(source, prompt, model);
        return { content: [{ type: "text", text: `👁️ [${usedModel}]\n\n${result}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ 视频理解失败: ${err.message}` }], isError: true };
      } finally {
        taskSemaphore.release();
        console.log(`🔓 释放执行槽 (${taskSemaphore.active}/${taskSemaphore.max} 活跃, ${taskSemaphore.pending} 排队)`);
      }
    }
  );

  s.registerTool(
    "vision_status",
    {
      title: "视觉服务状态",
      description: "检查各视频理解服务的配置状态和可用模型列表。",
      inputSchema: {},
    },
    async () => {
      const ok = k => {
        const v = process.env[k];
        return v && !v.startsWith("YOUR_") ? "✅" : "❌";
      };
      const biliOk = getBiliCookie() ? "✅" : "❌";
      const ytdlpOk = fs.existsSync("/home/ubuntu/.local/bin/yt-dlp") ? "✅" : "❌";
      let ffmpegOk;
      try { await execFileAsync("which", ["ffmpeg"]); ffmpegOk = "✅"; } catch { ffmpegOk = "❌"; }
      const lines = [
        "👁️ 小克的眼睛 — 服务状态",
        "",
        `Gemini:        ${ok("GEMINI_API_KEY")}`,
        `百炼 北京区:   ${ok("DASHSCOPE_API_KEY_BEIJING")}  (Qwen + Kimi)`,
        `百炼 新加坡区: ${ok("DASHSCOPE_API_KEY_SINGAPORE")}`,
        `混元 (图片):  ${ok("HUNYUAN_API_KEY")}  模型: ${process.env.HUNYUAN_IMAGE_MODEL || "hunyuan-vision"}`,
        `B站 Cookie:    ${biliOk}`,
        "",
        "📋 可用模型:",
        ...Object.entries(MODEL_CATALOG).map(([name, { desc }]) => `  ${name} — ${desc}`),
        "",
        `yt-dlp:  ${ytdlpOk}`,
        `ffmpeg:  ${ffmpegOk}`,
        `并发控制: ${taskSemaphore.active}/${MAX_CONCURRENCY} 活跃, ${taskSemaphore.pending} 排队`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

// ========== SSE Transport ==========

function createServer() {
  const s = new McpServer({ name: "vision-mcp-server", version: "1.4.0" });
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
    name: "小克的眼睛",
    version: "1.4.0",
    models: Object.keys(MODEL_CATALOG).length,
    concurrency: { active: taskSemaphore.active, max: MAX_CONCURRENCY, queued: taskSemaphore.pending },
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`👁️ 小克的眼睛 v1.4 — 视频+图片理解MCP启动: http://0.0.0.0:${PORT}`);
  console.log(`   可用模型: ${Object.keys(MODEL_CATALOG).length} 个`);
  console.log(`   B站Cookie: ${getBiliCookie() ? "✅" : "❌"}`);
  console.log(`   安全: SSRF防护 ✅ | 命令注入防护 ✅ | 确定性清理 ✅`);
  console.log(`   并发控制: 最大 ${MAX_CONCURRENCY} 并发，超出排队`);
  console.log(`   SSE路径: ${SSE_MSG_PATH}`);
  console.log(`   工具: watch, vision_status`);
});
