# 👁️ vision-mcp

**小克的眼睛** — Video understanding MCP server with multi-provider routing.

An MCP (Model Context Protocol) server that enables AI assistants to "watch" videos by routing requests to multiple vision-language model providers.

## Features

- **Multi-provider routing**: Gemini, DashScope (Qwen/Kimi), with automatic fallback
- **YouTube**: Direct URL pass-through to Gemini (no download needed)
- **Bilibili**: API-based download that bypasses geo-restrictions from overseas servers
- **Local files**: Served via public URL to avoid base64 timeout issues
- **13 models** across 3 providers, manually selectable or auto-routed
- **Smart routing**: YouTube → Gemini, Bilibili/local → Qwen, with cascading fallback

## Supported Models

| Model | Provider | Description |
|---|---|---|
| `gemini-2.5-flash` | Gemini | Free tier, fast and cheap |
| `gemini-2.5-pro` | Gemini | Free tier, stronger reasoning |
| `gemini-3-flash-preview` | Gemini | Latest Flash, frontier-level |
| `gemini-3-pro-preview` | Gemini | Strongest Gemini, paid only |
| `qwen3.5-omni-plus` | DashScope | Omnimodal flagship, 215 SOTA |
| `qwen3.5-omni-flash` | DashScope | Omnimodal mid-tier |
| `qwen3.5-omni-light` | DashScope | Omnimodal lightweight |
| `qwen3-vl-plus` | DashScope | Vision flagship |
| `qwen3-vl-flash` | DashScope | Vision fast |
| `qwen3.6-plus` | DashScope | Latest flagship |
| `qwen3.5-plus` | DashScope | Native multimodal |
| `qwen3.5-flash` | DashScope | Native multimodal, cost-effective |
| `kimi-k2.5` | DashScope | Fallback via DashScope |

## Prerequisites

- Node.js >= 18
- `ffmpeg` (for video compression)
- `yt-dlp` (for non-YouTube/Bilibili downloads)
- A public-facing web server (nginx) for serving temp video files to DashScope

## Setup

```bash
# Clone
git clone https://github.com/qiyun-kxc/vision-mcp.git
cd vision-mcp

# Install dependencies
npm install

# Configure API keys
cp config.env.example config.env
# Edit config.env with your API keys

# Start
node index.js
# Or with pm2:
pm2 start start.sh --name vision-mcp
```

## Configuration

Copy `config.env.example` to `config.env` and fill in your API keys:

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Google AI Studio API key |
| `DASHSCOPE_API_KEY_BEIJING` | Yes | Alibaba DashScope Beijing region |
| `DASHSCOPE_API_KEY_SINGAPORE` | Optional | Alibaba DashScope Singapore region |
| `BILI_COOKIE_PATH` | Optional | Path to file containing Bilibili cookies |
| `PUBLIC_URL_BASE` | Optional | Base URL for serving temp video files |
| `PUBLIC_DIR` | Optional | Directory for temp video files served by nginx |
| `VISION_MCP_PORT` | Optional | Server port (default: 18092) |

## MCP Tools

### `watch_video`

Watch a video and get a text description.

- `source` (required): Video URL (YouTube/Bilibili/other) or local file path
- `prompt` (optional): What to look for in the video
- `model` (optional): Specific model to use, or `auto` for smart routing

### `vision_status`

Check the configuration status of all providers and list available models.

## Architecture

```
YouTube URL ──→ Gemini (direct pass-through)
                    ↓ (fallback)
Bilibili URL ─→ API download ─→ ffmpeg compress ─→ nginx serve ─→ Qwen
                                                                    ↓ (fallback)
Other URL ───→ yt-dlp download ─→ ...                            Kimi
                                                                    
Local file ──→ copy to public dir ─→ nginx serve ─→ Qwen/Gemini
```

## Bilibili Support

Bilibili videos are downloaded using the Bilibili API instead of yt-dlp, which bypasses geo-restrictions that block direct access from overseas servers. The flow:

1. Extract BV ID from URL
2. Fetch video info (cid) via Bilibili API
3. Get stream URL via playurl API
4. Download from Akamai CDN (globally accessible)
5. Compress with ffmpeg if needed
6. Serve via nginx public URL

Requires a valid Bilibili cookie file (can be shared from bilibili-mcp).

## License

MIT
