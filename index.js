import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
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

// 先加载敏感配置（API keys），再加载普通配置
dotenv.config({ path: "/opt/vision-mcp/secrets.env", override: true });
dotenv.config({ path: "/opt/vision-mcp/config.env", override: true });

const PORT = parseInt(process.env.VISION_MCP_PORT || "18092");
const TEMP_DIR = process.env.VIDEO_TEMP_DIR || "/tmp/vision-mcp-videos";
const PUB_DIR = "/var/www/html/tmp";
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_CONCURRENCY = 2;

// ========== 并发控制 ==========

class Semaphore {
  constructor(max) { this.max = max; this.active = 0; this.queue = []; }
  acquire() {
    return new Promise(resolve => {
      if (this.active < this.max) { this.active++; resolve(); }
      else { this.queue.push(resolve); }
    });
  }
  release() {
    this.active--;
    if (this.queue.length > 0) { this.active++; this.queue.shift()(); }
  }
  get pending() { return this.queue.length; }
}

const taskSemaphore = new Semaphore(MAX_CONCURRENCY);

// ========== 启动清理 ==========

function cleanupOnStartup() {
  for (const dir of [TEMP_DIR, PUB_DIR]) {
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); continue; }
    try {
      let cleaned = 0;
      for (const f of fs.readdirSync(dir)) {
        if (/\.(mp4|webm|mkv|tmp)$/i.test(f)) {
          try { fs.unlinkSync(path.join(dir, f)); cleaned++; } catch {}
        }
      }
      if (cleaned > 0) console.log(`🧹 启动清理: ${dir} 删除 ${cleaned} 个残留文件`);
    } catch {}
  }
}
cleanupOnStartup();

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

const DEFAULTS = { gemini: "gemini-2.5-flash", dashscope: "qwen3.5-plus", fallback: "kimi-k2.5" };

// ========== 安全校验 ==========

function validateUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("无效的 URL"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("仅支持 HTTP/HTTPS 协议");
  const hostname = parsed.hostname.toLowerCase();
  const blocked = [/^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^localhost$/i, /^::1$/, /^fe80:/i, /^169\.254\./, /^metadata\./i, /^100\.(6[4-9]|[7-9]\d|1[0-2][0-9]|12[0-7])\./];
  if (blocked.some(r => r.test(hostname))) throw new Error("不允许访问内网或元数据地址");
}

// ========== 工具函数 ==========

const isYouTubeUrl = url => /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(url);
const isBilibiliUrl = url => /^https?:\/\/(www\.)?(bilibili\.com|b23\.tv)\//.test(url);
const cleanup = (...fps) => { for (const fp of fps) try { if (fp && fs.existsSync(fp)) fs.unlinkSync(fp); } catch {} };
const cleanupSet = s => { for (const fp of s) cleanup(fp); };

function getBiliCookie() {
  try {
    const yml = fs.readFileSync(BILI_COOKIE_PATH, "utf-8");
    const match = yml.match(/^Cookie:\s*(.+)$/m);
    return match ? match[1].trim() : null;
  } catch { return null; }
}

const extractBvid = url => { const m = url.match(/BV[a-zA-Z0-9]+/); return m ? m[0] : null; };

// ========== 下载函数 ==========

async function downloadBilibili(url) {
  const bvid = extractBvid(url);
  if (!bvid) throw new Error("无法从URL中提取BV号");
  const cookie = getBiliCookie();
  if (!cookie) throw new Error("B站 cookie 不可用");

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0";
  const commonArgs = ["-s", "-H", `Cookie: ${cookie}`, "-H", `User-Agent: ${UA}`, "-H", "Referer: https://www.bilibili.com/"];
  const t0 = Date.now();

  const { stdout: infoJson } = await execFileAsync("curl", [...commonArgs, `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`], { timeout: 15000 });
  const info = JSON.parse(infoJson);
  if (info.code !== 0) throw new Error(`B站视频信息获取失败: ${info.message}`);
  const { cid, title, duration } = info.data;
  console.log(`📺 B站: ${title} (${duration}秒)`);

  const { stdout: playJson } = await execFileAsync("curl", [...commonArgs, `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=32&fnval=1`], { timeout: 15000 });
  const play = JSON.parse(playJson);
  if (play.code !== 0 || !play.data?.durl?.[0]) throw new Error("B站播放地址获取失败");

  const videoUrl = play.data.durl[0].url;
  const uid = crypto.randomUUID();
  const filepath = path.join(TEMP_DIR, `bili_${uid}.mp4`);

  await execFileAsync("curl", ["-s", "-L", "--max-filesize", String(MAX_DOWNLOAD_BYTES), "-o", filepath, "-H", "Referer: https://www.bilibili.com/", "-H", `User-Agent: ${UA}`, videoUrl], { timeout: 180000 });

  const stats = fs.statSync(filepath);
  console.log(`📥 B站下载完成: ${(stats.size / 1024 / 1024).toFixed(1)}MB, 耗时 ${Date.now() - t0}ms`);

  if (stats.size > 2 * 1024 * 1024) {
    const compressed = path.join(PUB_DIR, `v_${uid}.mp4`);
    const t1 = Date.now();
    await execFileAsync("ffmpeg", ["-i", filepath, "-t", String(Math.min(duration, 300)), "-vf", "scale=320:-2", "-b:v", "200k", "-an", "-y", compressed], { timeout: 120000 });
    fs.unlinkSync(filepath);
    console.log(`🗜️ 压缩完成: ${(stats.size / 1024 / 1024).toFixed(1)}MB → ${(fs.statSync(compressed).size / 1024 / 1024).toFixed(1)}MB, 耗时 ${Date.now() - t1}ms`);
    return compressed;
  }
  return filepath;
}

async function downloadOther(url) {
  validateUrl(url);
  const uid = crypto.randomUUID();
  const filepath = path.join(TEMP_DIR, `video_${uid}.mp4`);
  const t0 = Date.now();
  await execFileAsync("/home/ubuntu/.local/bin/yt-dlp", ["-f", "bestvideo[height<=480]+bestaudio/best[height<=480]/best", "--merge-output-format", "mp4", "-o", filepath, url, "--no-playlist", "--quiet", "--max-filesize", `${MAX_DOWNLOAD_BYTES}`], { timeout: 180000, env: { ...process.env, PATH: process.env.PATH + ":/home/ubuntu/.local/bin" } });
  console.log(`📥 yt-dlp 下载完成: ${(fs.statSync(filepath).size / 1024 / 1024).toFixed(1)}MB, 耗时 ${Date.now() - t0}ms`);
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
    while (file.state === "PROCESSING") { await new Promise(r => setTimeout(r, 3000)); file = await ai.files.get({ name: file.name }); }
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
  const baseURL = region === "singapore" ? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" : "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const apiKey = process.env[keyEnv];
  if (!apiKey || apiKey.startsWith("YOUR_")) throw new Error(`百炼 ${region} 未配置`);
  return new OpenAI({ apiKey, baseURL });
}

async function callDashScope(source, prompt, model, isFile, region, filesToClean) {
  if (isFile) {
    let pubPath;
    if (!source.startsWith(PUB_DIR)) { const uid = crypto.randomUUID(); pubPath = path.join(PUB_DIR, `ds_${uid}.mp4`); fs.copyFileSync(source, pubPath); }
    else { pubPath = source; }
    filesToClean.add(pubPath);
    source = `https://qiyun.cloud/tmp/${path.basename(pubPath)}`;
  }
  const client = getDashScopeClient(region);
  const resp = await client.chat.completions.create({ model, messages: [{ role: "user", content: [{ type: "video_url", video_url: { url: source } }, { type: "text", text: prompt }] }] });
  return resp.choices?.[0]?.message?.content || "(未返回内容)";
}

// ========== 混元图片理解 ==========

function getHunyuanClient() {
  const apiKey = process.env.HUNYUAN_API_KEY;
  if (!apiKey || apiKey.startsWith("YOUR_")) throw new Error("混元 未配置");
  return new OpenAI({ apiKey, baseURL: "https://api.hunyuan.cloud.tencent.com/v1" });
}

async function callHunyuanImage(imageUrl, prompt, model) {
  const client = getHunyuanClient();
  const useModel = model || process.env.HUNYUAN_IMAGE_MODEL || "hunyuan-vision";

  try {
    console.log(`🖼️ 混元直传URL尝试...`);
    const result = await client.chat.completions.create({ model: useModel, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: imageUrl } }, { type: "text", text: prompt }] }] });
    const text = result.choices?.[0]?.message?.content;
    if (text) return text;
  } catch (urlErr) {
    console.log(`⚠️ 混元URL直传失败: ${urlErr.message}, 回退到base64...`);
  }

  let base64Data;
  try {
    const resp = await fetch(imageUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0) throw new Error("下载内容为空");
    base64Data = buf.toString("base64");
  } catch (err) { throw new Error(`图片下载失败: ${err.message}`); }

  const ext = imageUrl.split("?")[0].split("!")[0].split(".").pop().toLowerCase();
  const mime = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" }[ext] || "image/jpeg";

  const result = await client.chat.completions.create({ model: useModel, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:${mime};base64,${base64Data}` } }, { type: "text", text: prompt }] }] });
  return result.choices?.[0]?.message?.content || "(混元未返回内容)";
}

// ========== 智能路由 ==========

async function watchVideo(source, prompt, model) {
  if (source.startsWith("http")) {
    let isImage = false;
    const useModel = process.env.HUNYUAN_IMAGE_MODEL || "hunyuan-vision";

    try {
      const headResp = await fetch(source, { method: "HEAD", signal: AbortSignal.timeout(5000) });
      const ct = (headResp.headers.get("content-type") || "").toLowerCase();
      if (ct.startsWith("image/")) { isImage = true; console.log(`🖼️ HEAD检测到图片 (${ct})`); }
    } catch {}

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
      if (isBilibiliUrl(source)) { console.log("📥 B站链接，走API下载..."); localFile = await downloadBilibili(source); filesToClean.add(localFile); }
      else if (!isYouTubeUrl(source)) { console.log("📥 其他链接，走yt-dlp..."); localFile = await downloadOther(source); filesToClean.add(localFile); }
    }

    const actualSource = localFile || source;
    const isFile = localFile !== null || isFileInput;
    let attempts = [];

    if (model !== "auto") {
      const info = MODEL_CATALOG[model];
      if (!info) throw new Error(`未知模型: ${model}`);
      if (info.provider === "gemini") { attempts = [{ fn: () => callGemini(actualSource, prompt, model, isFile), label: model }]; }
      else { attempts = [{ fn: () => callDashScope(actualSource, prompt, model, isFile, "singapore", filesToClean), label: `${model} (新加坡)` }, { fn: () => callDashScope(actualSource, prompt, model, isFile, "beijing", filesToClean), label: `${model} (北京)` }]; }
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
      } catch (err) { console.log(`⚠️ ${label} 失败: ${err.message}`); }
    }
    throw new Error("所有视频理解服务均不可用");
  } finally { cleanupSet(filesToClean); }
}

// ========== MCP 工具注册 ==========

const MODEL_NAMES = ["auto", ...Object.keys(MODEL_CATALOG)];

function registerTools(s) {
  s.registerTool("watch", {
    title: "看视频",
    description: `小克的眼睛。传入URL（视频/图片均可）或文件路径 + prompt，自动识别类型并返回内容描述。\n图片URL自动走混元图片理解。\nauto=自动路由。B站API下载，YouTube直传Gemini。\n并发上限: ${MAX_CONCURRENCY}。`,
    inputSchema: {
      source: z.string().describe("视频URL或本地文件路径"),
      prompt: z.string().default("请详细描述这个视频的内容，包括画面、声音、文字等信息。").describe("想了解什么"),
      model: z.enum(MODEL_NAMES).default("auto").describe("指定模型，auto=自动路由"),
    },
  }, async ({ source, prompt, model }) => {
    if (taskSemaphore.pending > 0) console.log(`⏳ 排队中... 前方 ${taskSemaphore.pending} 个任务`);
    await taskSemaphore.acquire();
    console.log(`🔓 获取执行槽 (${taskSemaphore.active}/${taskSemaphore.max} 活跃)`);
    try {
      const { result, usedModel } = await watchVideo(source, prompt, model);
      return { content: [{ type: "text", text: `👁️ [${usedModel}]\n\n${result}` }] };
    } catch (err) { return { content: [{ type: "text", text: `❌ 视频理解失败: ${err.message}` }], isError: true }; }
    finally { taskSemaphore.release(); console.log(`🔓 释放执行槽`); }
  });

  s.registerTool("vision_status", {
    title: "视觉服务状态",
    description: "检查各视频理解服务的配置状态和可用模型列表。",
    inputSchema: {},
  }, async () => {
    const ok = k => { const v = process.env[k]; return v && !v.startsWith("YOUR_") ? "✅" : "❌"; };
    const biliOk = getBiliCookie() ? "✅" : "❌";
    const ytdlpOk = fs.existsSync("/home/ubuntu/.local/bin/yt-dlp") ? "✅" : "❌";
    let ffmpegOk; try { await execFileAsync("which", ["ffmpeg"]); ffmpegOk = "✅"; } catch { ffmpegOk = "❌"; }
    const lines = [
      "👁️ 小克的眼睛 — 服务状态", "",
      `Gemini:        ${ok("GEMINI_API_KEY")}`,
      `百炼 北京区:   ${ok("DASHSCOPE_API_KEY_BEIJING")}  (Qwen + Kimi)`,
      `百炼 新加坡区: ${ok("DASHSCOPE_API_KEY_SINGAPORE")}`,
      `混元 (图片):  ${ok("HUNYUAN_API_KEY")}  模型: ${process.env.HUNYUAN_IMAGE_MODEL || "hunyuan-vision"}`,
      `B站 Cookie:    ${biliOk}`, "",
      "📋 可用模型:", ...Object.entries(MODEL_CATALOG).map(([name, { desc }]) => `  ${name} — ${desc}`), "",
      `yt-dlp:  ${ytdlpOk}`, `ffmpeg:  ${ffmpegOk}`,
      `传输协议: Streamable HTTP (2025-03-26)`,
      `并发控制: ${taskSemaphore.active}/${MAX_CONCURRENCY} 活跃, ${taskSemaphore.pending} 排队`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });
}

// ========== Streamable HTTP Transport ==========

function createServer() {
  const s = new McpServer({ name: "vision-mcp-server", version: "1.5.0" });
  registerTools(s);
  return s;
}

const app = express();
app.use(express.json());

const transports = {};

app.all("/mcp", async (req, res) => {
  console.log(`📨 ${req.method} /mcp`);
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: sid => { console.log(`🆕 新会话: ${sid}`); transports[sid] = transport; }
      });
      transport.onclose = () => { const sid = transport.sessionId; if (sid && transports[sid]) { console.log(`👋 会话关闭: ${sid}`); delete transports[sid]; } };
      await createServer().connect(transport);
    } else {
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session ID" }, id: null });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("❌ 错误:", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});

app.get("/health", (_, res) => {
  res.json({
    status: "ok", name: "小克的眼睛", version: "1.5.0",
    transport: "Streamable HTTP (2025-03-26)",
    models: Object.keys(MODEL_CATALOG).length,
    sessions: Object.keys(transports).length,
    concurrency: { active: taskSemaphore.active, max: MAX_CONCURRENCY, queued: taskSemaphore.pending },
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`👁️ 小克的眼睛 v1.5.0 — 视频理解MCP启动: http://0.0.0.0:${PORT}`);
  console.log(`   传输协议: Streamable HTTP (2025-03-26)`);
  console.log(`   端点: /mcp`);
  console.log(`   可用模型: ${Object.keys(MODEL_CATALOG).length} 个`);
  console.log(`   B站Cookie: ${getBiliCookie() ? "✅" : "❌"}`);
  console.log(`   安全: SSRF防护 ✅ | 命令注入防护 ✅`);
  console.log(`   并发控制: 最大 ${MAX_CONCURRENCY} 并发`);
});

process.on("SIGINT", async () => {
  console.log("🛑 正在关闭...");
  for (const sid in transports) try { await transports[sid].close(); delete transports[sid]; } catch {}
  process.exit(0);
});
