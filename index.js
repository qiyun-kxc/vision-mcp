import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: process.env.CONFIG_PATH || path.join(process.cwd(), "config.env") });

const PORT = parseInt(process.env.VISION_MCP_PORT || "18092");
const TEMP_DIR = process.env.VIDEO_TEMP_DIR || "/tmp/vision-mcp-videos";
const PUBLIC_DIR = process.env.PUBLIC_DIR || "/var/www/html/tmp";
const PUBLIC_URL_BASE = process.env.PUBLIC_URL_BASE || "";
const BILI_COOKIE_PATH = process.env.BILI_COOKIE_PATH || "";

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
if (PUBLIC_DIR && !fs.existsSync(PUBLIC_DIR)) {
  try { fs.mkdirSync(PUBLIC_DIR, { recursive: true }); } catch {}
}

// ========== Model Catalog ==========
const MODEL_CATALOG = {
  "gemini-2.5-flash":       { provider: "gemini", desc: "Free tier, fast and cheap" },
  "gemini-2.5-pro":         { provider: "gemini", desc: "Free tier, stronger reasoning" },
  "gemini-3-flash-preview": { provider: "gemini", desc: "Latest Flash, frontier-level" },
  "gemini-3-pro-preview":   { provider: "gemini", desc: "Strongest Gemini, paid only" },
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

// ========== Utilities ==========

function isYouTubeUrl(url) {
  return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(url);
}
function isBilibiliUrl(url) {
  return /^https?:\/\/(www\.)?(bilibili\.com|b23\.tv)\//.test(url);
}
function cleanup(fp) {
  try { if (fp && fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
}

function getBiliCookie() {
  if (!BILI_COOKIE_PATH) return null;
  try {
    const content = fs.readFileSync(BILI_COOKIE_PATH, "utf-8");
    const match = content.match(/^Cookie:\s*(.+)$/m);
    return match ? match[1].trim() : null;
  } catch { return null; }
}

function extractBvid(url) {
  const m = url.match(/BV[a-zA-Z0-9]+/);
  return m ? m[0] : null;
}

// Serve a local file via public URL (for DashScope which can't handle large base64)
function servePublicly(localPath) {
  if (!PUBLIC_DIR || !PUBLIC_URL_BASE) return null;
  const fname = "v_" + Date.now() + ".mp4";
  const pubPath = path.join(PUBLIC_DIR, fname);
  fs.copyFileSync(localPath, pubPath);
  setTimeout(() => cleanup(pubPath), 60000);
  return PUBLIC_URL_BASE + "/" + fname;
}

// ========== Bilibili Download ==========

function downloadBilibili(url) {
  const bvid = extractBvid(url);
  if (!bvid) throw new Error("Cannot extract BV ID from URL");

  const cookie = getBiliCookie();
  if (!cookie) throw new Error("Bilibili cookie not available");

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0";
  const curlBase = `curl -s -H "Cookie: ${cookie}" -H "User-Agent: ${UA}" -H "Referer: https://www.bilibili.com/"`;

  const infoJson = execSync(`${curlBase} "https://api.bilibili.com/x/web-interface/view?bvid=${bvid}"`, { timeout: 15000 }).toString();
  const info = JSON.parse(infoJson);
  if (info.code !== 0) throw new Error(`Bilibili info failed: ${info.message}`);

  const { cid, title, duration } = info.data;
  console.log(`📺 Bilibili: ${title} (${duration}s)`);

  const playJson = execSync(`${curlBase} "https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=32&fnval=1"`, { timeout: 15000 }).toString();
  const play = JSON.parse(playJson);
  if (play.code !== 0 || !play.data?.durl?.[0]) throw new Error("Bilibili playurl failed");

  const videoUrl = play.data.durl[0].url;
  const filepath = path.join(TEMP_DIR, `bili_${bvid}_${Date.now()}.mp4`);
  execSync(`curl -s -L -o "${filepath}" -H "Referer: https://www.bilibili.com/" -H "User-Agent: ${UA}" "${videoUrl}"`, { timeout: 180000 });

  const stats = fs.statSync(filepath);
  if (stats.size > 2 * 1024 * 1024) {
    const maxDur = Math.min(duration, 300);
    const compressed = path.join(PUBLIC_DIR || TEMP_DIR, `bili_${bvid}_${Date.now()}.mp4`);
    execSync(`ffmpeg -i "${filepath}" -t ${maxDur} -vf "scale=320:-2" -b:v 200k -an -y "${compressed}" 2>/dev/null`, { timeout: 120000 });
    fs.unlinkSync(filepath);
    return compressed;
  }

  return filepath;
}

function downloadOther(url) {
  const filename = `video_${Date.now()}.mp4`;
  const filepath = path.join(TEMP_DIR, filename);
  execSync(
    `yt-dlp -f "bestvideo[height<=480]+bestaudio/best[height<=480]/best" ` +
    `--merge-output-format mp4 -o "${filepath}" "${url}" --no-playlist --quiet`,
    { timeout: 180000 }
  );
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
  return result.text || "(No response)";
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

async function callDashScope(source, prompt, model, isFile, region) {
  // Serve local files via public URL to avoid base64 timeout
  if (isFile) {
    const pubUrl = servePublicly(source);
    if (pubUrl) {
      source = pubUrl;
      isFile = false;
    }
  }
  // Files in PUBLIC_DIR can also be served
  if (isFile && PUBLIC_DIR && source.startsWith(PUBLIC_DIR)) {
    const fname = path.basename(source);
    if (PUBLIC_URL_BASE) {
      source = PUBLIC_URL_BASE + "/" + fname;
      isFile = false;
      setTimeout(() => cleanup(path.join(PUBLIC_DIR, fname)), 60000);
    }
  }

  const client = getDashScopeClient(region);

  let videoContent;
  if (isFile) {
    const data = fs.readFileSync(source);
    const b64 = data.toString("base64");
    videoContent = { type: "video_url", video_url: { url: `data:video/mp4;base64,${b64}` } };
  } else {
    videoContent = { type: "video_url", video_url: { url: source } };
  }

  const resp = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: [videoContent, { type: "text", text: prompt }] }],
  });

  return resp.choices?.[0]?.message?.content || "(No response)";
}

// ========== Smart Router ==========

async function watchVideo(source, prompt, model) {
  let localFile = null;
  const isFileInput = !source.startsWith("http");

  try {
    if (!isFileInput) {
      if (isBilibiliUrl(source)) {
        console.log("📥 Bilibili URL, downloading via API...");
        localFile = downloadBilibili(source);
      } else if (!isYouTubeUrl(source)) {
        console.log("📥 Other URL, downloading via yt-dlp...");
        localFile = downloadOther(source);
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
          { fn: () => callDashScope(actualSource, prompt, model, isFile, "beijing"), label: `${model} (Beijing)` },
          { fn: () => callDashScope(actualSource, prompt, model, isFile, "singapore"), label: `${model} (Singapore)` },
        ];
      }
    } else {
      if (isYouTubeUrl(source) && !localFile) {
        attempts = [
          { fn: () => callGemini(actualSource, prompt, DEFAULTS.gemini, false), label: DEFAULTS.gemini },
          { fn: () => callDashScope(actualSource, prompt, DEFAULTS.dashscope, false, "beijing"), label: `${DEFAULTS.dashscope} (Beijing)` },
          { fn: () => callDashScope(actualSource, prompt, DEFAULTS.dashscope, false, "singapore"), label: `${DEFAULTS.dashscope} (Singapore)` },
          { fn: () => callDashScope(actualSource, prompt, DEFAULTS.fallback, false, "beijing"), label: `${DEFAULTS.fallback} (Beijing)` },
        ];
      } else {
        attempts = [
          { fn: () => callDashScope(actualSource, prompt, DEFAULTS.dashscope, isFile, "beijing"), label: `${DEFAULTS.dashscope} (Beijing)` },
          { fn: () => callDashScope(actualSource, prompt, DEFAULTS.dashscope, isFile, "singapore"), label: `${DEFAULTS.dashscope} (Singapore)` },
          { fn: () => callGemini(actualSource, prompt, DEFAULTS.gemini, isFile), label: DEFAULTS.gemini },
          { fn: () => callDashScope(actualSource, prompt, DEFAULTS.fallback, isFile, "beijing"), label: `${DEFAULTS.fallback} (Beijing)` },
        ];
      }
    }

    for (const { fn, label } of attempts) {
      try {
        console.log(`👁️ ${label}...`);
        const result = await fn();
        return { result, usedModel: label };
      } catch (err) {
        console.log(`⚠️ ${label}: ${err.message}`);
      }
    }

    throw new Error("All providers unavailable");
  } finally {
    cleanup(localFile);
  }
}

// ========== MCP Tools ==========

const MODEL_NAMES = ["auto", ...Object.keys(MODEL_CATALOG)];

function registerTools(s) {
  s.registerTool(
    "watch_video",
    {
      title: "Watch Video",
      description: "Watch a video and get a text description. Supports YouTube (direct), Bilibili (API download), and local files.\nauto = smart routing, or specify a model.",
      inputSchema: {
        source: z.string().describe("Video URL (YouTube/Bilibili/other) or local file path"),
        prompt: z.string().default("Describe this video in detail, including visuals, audio, and text.").describe("What to look for"),
        model: z.enum(MODEL_NAMES).default("auto").describe("Model to use, auto = smart routing"),
      },
    },
    async ({ source, prompt, model }) => {
      try {
        const { result, usedModel } = await watchVideo(source, prompt, model);
        return { content: [{ type: "text", text: `👁️ [${usedModel}]\n\n${result}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `❌ Failed: ${err.message}` }], isError: true };
      }
    }
  );

  s.registerTool(
    "vision_status",
    {
      title: "Vision Status",
      description: "Check provider configuration and available models.",
      inputSchema: {},
    },
    async () => {
      const ok = k => {
        const v = process.env[k];
        return v && !v.startsWith("YOUR_") ? "✅" : "❌";
      };
      const biliOk = getBiliCookie() ? "✅" : "❌";
      const lines = [
        "👁️ Vision MCP — Status",
        "",
        `Gemini:             ${ok("GEMINI_API_KEY")}`,
        `DashScope Beijing:  ${ok("DASHSCOPE_API_KEY_BEIJING")}`,
        `DashScope Singapore:${ok("DASHSCOPE_API_KEY_SINGAPORE")}`,
        `Bilibili Cookie:    ${biliOk}`,
        `Public URL:         ${PUBLIC_URL_BASE || "(not configured)"}`,
        "",
        "Available models:",
        ...Object.entries(MODEL_CATALOG).map(([name, { desc }]) => `  ${name} — ${desc}`),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

// ========== SSE Transport ==========

function createServer() {
  const s = new McpServer({ name: "vision-mcp-server", version: "1.1.0" });
  registerTools(s);
  return s;
}

const app = express();
const sessions = {};

app.get("/sse", async (req, res) => {
  const srv = createServer();
  const transport = new SSEServerTransport("/terminal/messages", res);
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
  res.json({ status: "ok", name: "vision-mcp", version: "1.1.0", models: Object.keys(MODEL_CATALOG).length });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`👁️ Vision MCP v1.1 started: http://0.0.0.0:${PORT}`);
  console.log(`   Models: ${Object.keys(MODEL_CATALOG).length}`);
  console.log(`   Bilibili: ${getBiliCookie() ? "✅" : "❌"}`);
  console.log(`   Public URL: ${PUBLIC_URL_BASE || "(not configured)"}`);
  console.log(`   Tools: watch_video, vision_status`);
});
