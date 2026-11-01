# Jianwen · 见闻

English | [简体中文](README.zh-CN.md)

**Give an AI something to see and hear before asking it to explain a video.** Jianwen is a local, stdio-based MCP server. It resolves a Bilibili video, collects metadata, subtitles or speech transcripts, and representative frames, then returns an asset manifest to an MCP client such as Pi, Cursor, or Claude Desktop.

The name is platform-neutral; **only Bilibili is implemented today**. Douyin is an idea for a future adapter, not a working integration.

## What it does

| MCP tool | Result |
| --- | --- |
| `resolve_video` | Resolve a Bilibili URL, `b23.tv` short link, BV ID, or av ID to title, first-page duration, author/UID, publication time, engagement counts, and `aid`/`cid`. |
| `fetch_assets` | Fetch available subtitles, optionally transcribe speech and/or extract keyframes; save an `AssetManifest` and local files. |
| `get_cached` | Read a previously saved manifest without re-downloading its media. |
| `summarize` | Optionally send cached text and up to six frames to a configured OpenAI-compatible chat/vision endpoint for a structured summary. |

The workflow is **resolve → fetch → analyze**: the client may analyze the returned text and frame paths itself; `summarize` is optional. `fetch_assets` performs a fresh fetch rather than automatically serving an old manifest; call `get_cached` to reuse one. Neither tool reads or returns comment *content*.

### How Bilibili assets are obtained

1. Video metadata comes from Bilibili's web endpoint `GET https://api.bilibili.com/x/web-interface/view?bvid=BV...` (or `aid=...`). `publishedAt` is UTC ISO 8601; `stats.comments` maps to `stat.reply` (a count). Stats are snapshots taken at request time, not live counters. Multi-part videos currently use **the first page's** `cid` and duration.
2. When requested, subtitles come from the player API. If subtitles are available, requesting ASR skips transcription. Many videos have no exposed subtitles.
3. Keyframes first come from the videoshot storyboard: the server crops **up to six** tiles across the first 90% of the video without downloading the whole video. If unavailable, it downloads media and uses ffmpeg to sample frames; this fallback can produce more than six frames depending on the interval.
4. When ASR is explicitly requested and no subtitle was found, it prefers an audio-only stream via `yt-dlp` (or Bilibili's playurl fallback), converts audio to mono 16 kHz WAV with ffmpeg, then runs local whisper.cpp or sends audio to an explicitly configured compatible ASR API. If an audio stream is unavailable, it may download video instead.

Default `fetch_assets` options are `wantSubtitles: true`, `wantAsr: false`, `wantKeyframes: true`, and `keyframeIntervalSec: 10`. Local transcription is **opt-in**. Storyboard frames are thumbnails, not full-resolution frames; AI-generated interpretations and ASR text should be checked against the source.

## Requirements and installation

- Node.js **20+** and npm.
- `ffmpeg` on `PATH` for ASR audio conversion or downloaded-video frame extraction (not needed for metadata or storyboard-only frames).
- `yt-dlp` on `PATH` is recommended for reliable public-media downloads; the project also has a public playurl fallback.
- For local ASR only: whisper.cpp `whisper-cli` and a compatible multilingual `ggml-*.bin` model. For cloud ASR or `summarize`, configure the corresponding provider/API key.

```sh
# From the project directory (after downloading the source):
npm ci
npm run build
npm test
```

The stdio entry point is `node dist/index.js`. `npm ci` installs and builds via the package's `prepare` script; the explicit build above also verifies TypeScript. Do not run the entry point as a web server: it speaks MCP over standard input/output.

### Get whisper.cpp working (only for local ASR)

The upstream repository is **[ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp)**. Download executables from its [Releases](https://github.com/ggml-org/whisper.cpp/releases) and a GGML model from [ggerganov/whisper.cpp on Hugging Face](https://huggingface.co/ggerganov/whisper.cpp). **The executable and model are separate downloads**; `npm ci` does not install either. Neither is needed if you do not request local ASR.

1. **Choose a binary:** On Windows x64, download a suitable CPU archive from Releases and keep `whisper-cli.exe` **together with its DLLs** (for example under `Release/whisper-cpu-windows-x64/`). For NVIDIA GPUs use a CUDA build targeting your GPU architecture; a build merely labeled CUDA is not necessarily compatible. On macOS/Linux use a build for your system. Alternatively, follow the [upstream build instructions](https://github.com/ggml-org/whisper.cpp#readme).
2. **Get a model:** Download the multilingual `ggml-large-v3-turbo.bin` (~1.6 GB) to `Release/models/ggml-large-v3-turbo.bin`, or choose another multilingual GGML model and use its actual path. English-only `.en` models are not suitable for Chinese audio. If you have the whisper.cpp source, its [Windows model download script](https://github.com/ggml-org/whisper.cpp/blob/master/models/download-ggml-model.cmd) can be run in PowerShell from that source directory with `& .\models\download-ggml-model.cmd large-v3-turbo`; then move the model to your chosen location.
3. **Point the MCP client at both files:** set `VIDEO_MCP_ASR_PROVIDER=whisper_local`, `VIDEO_MCP_WHISPER_BIN=<absolute path to whisper-cli>`, and `VIDEO_MCP_WHISPER_MODEL=<absolute path to the model>` in the client `env` (example below). Restart the client, put ffmpeg on `PATH`, and call `fetch_assets` with `wantAsr: true` on a video without available subtitles; set `wantKeyframes: false` if you only want text.

[`Release/README.md`](Release/README.md) explains the locally prepared Windows x64 CPU and CUDA 13.2 GPU builds. The binaries and model are **git-ignored**: a source checkout does not contain them, so substitute your own actual installation paths. The prepared GPU build targets SM 75/86/89/120 (RTX 20/30/40/50 architectures); only RTX 5060 Ti was tested here. It still needs a compatible GPU driver, sufficient VRAM, and the Microsoft Visual C++ runtime. CUDA Toolkit is not required on the destination PC when the packaged redistributable CUDA DLLs are included. GTX 10, macOS, Linux, and Windows ARM64 require a suitable other build; there is **no automatic CPU/GPU switching**. Observe third-party licenses when distributing binaries and models.

## Configure an MCP client

Replace `PATH_TO_JIANWEN` with the **absolute path** of your checkout. On Windows you can use forward slashes in JSON paths (for example `D:/Code/Jianwen/dist/index.js`). Ensure `node` is on the client's `PATH`, or use its absolute executable path.

For Cursor/Claude Desktop, put this server entry into the client's `mcp.json` (Claude Desktop on Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "jianwen": {
      "command": "node",
      "args": ["PATH_TO_JIANWEN/dist/index.js"],
      "env": { "VIDEO_MCP_ASR_PROVIDER": "none" }
    }
  }
}
```

For **Pi**, add the same entry to the user-level `~/.pi/agent/mcp.json` (Windows: `%USERPROFILE%\.pi\agent\mcp.json`), optionally setting `"timeout": 300` and `"exposure": "codemode"`. Preserve other entries in an existing file. Run `pi mcp list` to check the connection and `/reload` in an already open Pi session after changing the config. Progress-aware Pi requests can stay alive during longer `fetch_assets` calls; configure client timeouts for your own environment rather than assuming a fixed limit always suffices.

To enable **local transcription**, change the `env` object in the client config, for example on Windows:

```json
{
  "VIDEO_MCP_ASR_PROVIDER": "whisper_local",
  "VIDEO_MCP_WHISPER_BIN": "PATH_TO_JIANWEN/Release/whisper-cpu-windows-x64/whisper-cli.exe",
  "VIDEO_MCP_WHISPER_MODEL": "PATH_TO_JIANWEN/Release/models/ggml-large-v3-turbo.bin",
  "VIDEO_MCP_WHISPER_LANGUAGE": "auto"
}
```

For a compatible NVIDIA GPU replace `VIDEO_MCP_WHISPER_BIN` with `PATH_TO_JIANWEN/Release/whisper-cuda13.2-rtx20-50-windows-x64/whisper-cli.exe` **if you have supplied that build**. On other operating systems point it at your own whisper.cpp executable. This setting selects the binary; the MCP server does not detect hardware and switch automatically.

### Environment variables

The historical `VIDEO_MCP_` prefix is retained for compatibility with older configurations.

| Variable | Use |
| --- | --- |
| `VIDEO_MCP_CACHE_DIR` | Cache root; default `<project>/cache`. |
| `VIDEO_MCP_ASR_PROVIDER` | `none` (default), `whisper_local`, or `openai_compatible`. |
| `VIDEO_MCP_WHISPER_BIN` / `VIDEO_MCP_WHISPER_MODEL` | whisper.cpp executable (default `whisper-cli` on `PATH`) and **required** model path when using local ASR. |
| `VIDEO_MCP_WHISPER_LANGUAGE` | Whisper language; default `auto`, or e.g. `zh`. |
| `VIDEO_MCP_ASR_BASE_URL` / `VIDEO_MCP_ASR_API_KEY` / `VIDEO_MCP_ASR_MODEL` | Compatible speech-transcription API (`MODEL` defaults to `whisper-1`). **Audio is sent to this service.** |
| `VIDEO_MCP_SUMMARY_BASE_URL` / `VIDEO_MCP_SUMMARY_API_KEY` / `VIDEO_MCP_SUMMARY_MODEL` | Compatible chat-completions API for `summarize`. **Text and available frame images may be sent to this service.** |
| `VIDEO_MCP_BILIBILI_UA` | Override the Bilibili request User-Agent. |

If the summary provider is unset, `summarize` returns `SUMMARY_UNSET`; the other three tools work independently. Avoid committing credentials. Cached audio, WAV, frames, subtitles and the manifest remain on disk until you delete them; normal MCP results include text and **local paths**, not embedded frame images.

## Example calls and timeouts

```json
resolve_video  { "url": "https://www.bilibili.com/video/BV1VqsQ6KEoy" }
fetch_assets   { "id": "BV1VqsQ6KEoy", "wantKeyframes": false }
fetch_assets   { "id": "BV1VqsQ6KEoy", "wantAsr": true, "wantKeyframes": false }
get_cached     { "id": "BV1VqsQ6KEoy" }
```

The second call asks for subtitles without downloading media if they are present; a video without subtitles will have no transcript unless `wantAsr: true` and an ASR provider is configured. Do not infer what the video says from its title alone. `fetch_assets` stores files under `<cache>/bilibili/<BV-ID>/` (`manifest.json`, optional `subtitle.txt`, `asr.txt`, `audio_16k.wav`, `keyframes/`, etc.). If content has changed, call `fetch_assets` again for a fresh metadata snapshot.

Local Whisper process timeout is estimated from the first-page duration in seconds: `min(86400, max(300, ceil(durationSec * 3 + 120)))`; unknown/invalid duration defaults to **1800 seconds**. Override via `fetch_assets` argument `asrTimeoutSec` (integer **30–86400**). This only bounds the **local Whisper subprocess**, not resolution, downloading, ffmpeg, cloud ASR, or the MCP client's own timeout. If the client provides a progress token, `fetch_assets` reports progress at stage changes and about every **20 seconds**; clients that reset their timeout on progress (including Pi) can keep waiting. Cancellation stops active ffmpeg/Whisper subprocesses, but may not immediately interrupt downloading.

On the maintainer's test machine, the example BV above yielded six storyboard frames without downloading video and a local transcript when ASR was requested. A separate **2397-second** video (`BV1fKeg6mEY4`) completed GPU transcription in about **94 seconds**, with eight progress notifications. That is one environment-specific observation, **not** proof that every client will survive a 300-second request or that every long video finishes in this time.

## Troubleshooting and limits

- **Verify the upstream API:** in Postman, send `GET https://api.bilibili.com/x/web-interface/view` with Params `bvid=BV1VqsQ6KEoy`. Inspect both HTTP status and JSON `code` (`0` means success). `data.pubdate` is Unix seconds, `data.owner.mid` is the UID, `data.stat.reply` is a count, not comment text. This is a Bilibili web endpoint used by this code, **not** an MCP HTTP endpoint or a guaranteed official Open Platform contract. Access and rate limits can change; avoid aggressive retries.
- **No transcript?** Some videos expose no subtitles. Explicitly enable ASR and install ffmpeg/Whisper or configure a compatible provider. `wantAsr` defaults to false.
- **No frames?** Storyboard may be unavailable; the fallback needs media access, ffmpeg, and sometimes yt-dlp. Paywalled, VIP, or login-only material is unsupported; the server does not use cookies.
- **No cache?** `get_cached` returns `CACHE_MISS` until `fetch_assets` has written a manifest. A cached manifest does not update its engagement counts automatically.
- **Long operations?** Raise the client's request timeout as needed; the Whisper timeout override alone does not extend it. A freshly edited Pi MCP config may require `/reload`.
- **Platform scope:** only Bilibili is registered in `src/adapters/registry.ts`. Douyin currently has no implementation; its authorized APIs and public-page/cookie restrictions differ from Bilibili.

To add another platform, implement `PlatformAdapter` in `src/adapters/` and register it in `src/adapters/registry.ts`. Run `npm test` and `npm run build` after changes. For a more detailed Chinese walkthrough, see [README.zh-CN.md](README.zh-CN.md) and [Windows Cursor setup](INSTALL_CN.md).

## License

MIT (see `package.json`). Third-party model/binary licenses apply separately.
