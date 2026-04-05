# 👁️ vision-mcp

**Video understanding MCP server** with multi-provider routing, security hardening, and concurrency control.

An MCP (Model Context Protocol) server that enables AI assistants to "watch" videos by routing requests to multiple vision-language model providers.

## Features

- **Multi-provider routing**: Gemini, DashScope (Qwen/Kimi), with automatic fallback
- **YouTube**: Direct URL pass-through to Gemini (no download needed)
- **Bilibili**: API-based download that bypasses geo-restrictions from overseas servers
- **13 models** across 3 providers, manually selectable or auto-routed
- **Security hardened** (v1.3): command injection prevention, SSRF protection, deterministic file cleanup
- **Concurrency control**: Semaphore-based limit on concurrent heavy tasks
- **SSE_MSG_PATH**: Nginx sub_filter-free architecture via environment variable

## Security (v1.3)

| Protection | Implementation |
|---|---|
| Command injection | `execFile` with argument arrays instead of shell string concatenation |
| SSRF | URL validation blocking internal IPs, cloud metadata, CGNAT ranges |
| File cleanup | Deterministic `try/finally` + `Set` tracking (no `setTimeout`) |
| Filename guessing | `crypto.randomUUID()` instead of `Date.now()` timestamps |
| Large file DoS | `curl --max-filesize` and `yt-dlp --max-filesize` (50MB cap) |
| Resource exhaustion | Semaphore-based concurrency limit (default: 2 concurrent tasks) |
| Startup residue | Automatic cleanup of leftover temp files on process start |

## Supported Models

| Model | Provider | Description |
|---|---|---|
| `gemini-2.5-flash` | Gemini | Free tier, fast and cheap |
| `gemini-2.5-pro` | Gemini | Free tier, stronger reasoning |
| `gemini-3-flash-preview` | Gemini | Latest Flash, frontier-level |
| `gemini-3.1-pro-preview` | Gemini | Strongest Gemini, paid only |
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
git clone https://github.com/qiyun-kxc/vision-mcp.git
cd vision-mcp
npm install

cp config.env.example config.env
# Edit config.env with your API keys

node index.js
# Or with pm2:
pm2 start start.sh --name vision-mcp
```

## Configuration

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Google AI Studio API key |
| `DASHSCOPE_API_KEY_BEIJING` | Yes | Alibaba DashScope Beijing region |
| `DASHSCOPE_API_KEY_SINGAPORE` | Optional | Alibaba DashScope Singapore region |
| `VISION_MCP_PORT` | Optional | Server port (default: 18092) |
| `SSE_MSG_PATH` | Optional | External SSE message path for Nginx routing |

## Nginx Integration

Instead of using fragile `sub_filter` rules, set `SSE_MSG_PATH` in your config to the external path clients will use:

```env
SSE_MSG_PATH=/vision/terminal/messages
```

Then Nginx only needs pure `proxy_pass` — no stream rewriting:

```nginx
location /vision/sse {
    proxy_pass http://127.0.0.1:18092/sse;
    # ... standard SSE proxy headers ...
    # No sub_filter needed!
}

location /vision/terminal/messages {
    proxy_pass http://127.0.0.1:18092/terminal/messages;
    # ... standard proxy headers ...
}
```

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
YouTube URL ──→ Gemini (direct pass-through, no download)
                    ↓ (fallback)
Bilibili URL ─→ API download ─→ ffmpeg compress ─→ nginx serve ─→ Qwen
                                                                    ↓ (fallback)
Other URL ───→ yt-dlp download (SSRF-validated) ─→ ...            Kimi

Local file ──→ copy to public dir ─→ nginx serve ─→ Qwen/Gemini

All paths ─→ Semaphore gate (max 2) ─→ try/finally cleanup
```

## Observability

All stages are logged with timing:
- Download duration and file size
- Compression before/after size and duration
- Model inference duration
- Total request duration
- Concurrency slot acquire/release events

The `/health` endpoint reports real-time concurrency status.

## License

MIT
