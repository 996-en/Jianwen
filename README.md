# Jianwen · 见闻

English | [简体中文](README.zh-CN.md)

**Give an AI something to see and hear before asking it to explain a video.** Jianwen is a local, stdio-based MCP server. It resolves a Bilibili or Douyin video, collects metadata, subtitles or speech transcripts, and representative frames, then returns an asset manifest to an MCP client such as Pi, Cursor, or Claude Desktop.

The name is platform-neutral; **Bilibili and Douyin are implemented**. Douyin needs browser-issued guest cookies, because its detail endpoint rejects requests without a browser identity signature (see below). Other platforms are not implemented.

## What it does

| MCP tool | Result |
| --- | --- |
| `resolve_video` | Resolve a Bilibili URL, `b23.tv` short link, BV ID, or av ID to title, first-page duration, author/UID, publication time, engagement counts, and `aid`/`cid`. Also resolves a Douyin video URL, `v.douyin.com` share link, or aweme id to title, duration, author, publication time and interaction counts. |
| `fetch_assets` | Fetch available subtitles, optionally transcribe speech and/or extract keyframes; save an `AssetManifest` and local files. Text only by default; frames must be asked for. |
| `get_cached` | Read a previously saved manifest without re-downloading its media. |
| `summarize` | Optionally send cached text and up to six frames to a configured OpenAI-compatible chat/vision endpoint for a structured summary. |

The workflow is **resolve → fetch → analyze**: the client may analyze the returned text and frame paths itself; `summarize` is optional. `fetch_assets` performs a fresh fetch rather than automatically serving an old manifest; call `get_cached` to reuse one. Neither tool reads or returns comment *content*.

### How Bilibili assets are obtained

1. Video metadata comes from Bilibili's web endpoint `GET https://api.bilibili.com/x/web-interface/view?bvid=BV...` (or `aid=...`). `publishedAt` is UTC ISO 8601; `stats.comments` maps to `stat.reply` (a count). Stats are snapshots taken at request time, not live counters. Multi-part videos currently use **the first page's** `cid` and duration.
2. When requested, subtitles come from the player API. If subtitles are available, requesting ASR skips transcription. Many videos have no exposed subtitles.
3. Keyframes first come from the videoshot storyboard: the server crops **up to six** tiles across the first 90% of the video without downloading the whole video. If unavailable, it downloads media and uses ffmpeg to sample frames; this fallback can produce more than six frames depending on the interval.
4. When ASR is explicitly requested and no subtitle was found, it prefers an audio-only stream via `yt-dlp` (or Bilibili's playurl fallback), converts audio to mono 16 kHz WAV with ffmpeg, then runs local whisper.cpp or sends audio to an explicitly configured compatible ASR API. If an audio stream is unavailable, it may download video instead.
5. Local whisper.cpp output is post-processed before it is written: Traditional Chinese is converted to Simplified with OpenCC, consecutive segments repeated by background music are collapsed, and segments are merged into paragraphs at pauses or at a character limit instead of one line per segment. The timestamped raw segments stay next to `asr.txt` as `asr.json`.

Default `fetch_assets` options are `wantSubtitles: true`, `wantKeyframes: false`, and `keyframeIntervalSec: 10`, so an optionless call returns **text only** — platform subtitles, or a transcript — and never downloads a video just to sample it. `wantAsr` is **on by default whenever `VIDEO_MCP_ASR_PROVIDER` is configured** (it is skipped automatically when the platform already provides subtitles) and only an explicit `false` turns it off. Pass `wantKeyframes: true` when the model needs to see the picture; storyboard tiles are then cropped without downloading the video (Douyin has no storyboard, so it downloads the mp4), and after extraction or transcription that mp4 is deleted unless `VIDEO_MCP_KEEP_MEDIA=1`. Storyboard frames are thumbnails, not full-resolution frames; AI-generated interpretations and ASR text should be checked against the source.

### How Douyin assets are obtained

1. Input can be a `https://www.douyin.com/video/<aweme_id>` URL, a `v.douyin.com/...` share link (the share text from the app works too — the short link is followed to get the aweme id), or a bare 19-digit aweme id. Image/note posts (`/note/...`) are rejected with `UNSUPPORTED_URL`.
2. Metadata comes from the web detail endpoint `GET https://www.douyin.com/aweme/v1/web/aweme/detail/`. That endpoint rejects bare requests: it needs a browser-issued guest identity (`UIFID`, `ttwid`, …) **and** a query signature. The server therefore reads cookies in this order — `VIDEO_MCP_DOUYIN_COOKIES` (raw `Cookie` header) → `VIDEO_MCP_DOUYIN_COOKIE_FILE` (Netscape `cookies.txt`) → the repo-root `.douyin-cookies.txt`, which is the default and usually makes `env` unnecessary — and signs the query itself with `x-secsdk-web-signature`, whose formula is documented at the top of `src/adapters/douyin-sign.ts` and matches the browser byte for byte.
3. Missing or invalid cookies produce `COOKIE_REQUIRED`. Cookies must come from **one browser session** — the guest `UIFID` and `ttwid` are issued as a set, so a hand-built or fabricated `UIFID` gets `403 Blocked by ArgusSecurityPlugin`. `a_bogus` and `msToken` are not needed.
4. Douyin exposes **no subtitle tracks and no storyboard**. If ASR or frames are requested, the server downloads the complete `play_addr` mp4 (h264 + aac) — the `bit_rate[*].play_addr` entries are usually video-only DASH streams without an audio track — and then reuses the normal pipeline: ffmpeg → mono 16 kHz WAV for ASR, ffmpeg frame sampling for keyframes.
   **Transcript only (no frames):** this is the default path, and ffmpeg reads the CDN URL directly instead of downloading the whole file — the CDN answers `206 Partial Content` and keeps `moov` at the start, so ffmpeg pulls only the audio bytes (~10 MB instead of ~35 MB for an 11-minute video) and writes the 16 kHz WAV in one pass. Any failure (no ffmpeg, CDN refusing ranges, expired signature) silently falls back to the full download, so results never change — only the transfer size does. Set `VIDEO_MCP_DOUYIN_FAST_AUDIO=0` to force the old behaviour. Wall time is unchanged because Whisper dominates.
5. Douyin's web API usually reports `play_count` as 0, so `stats.views` is omitted rather than reported as zero. Author ids are `sec_uid` strings, which do not fit the numeric `authorId` field; they are returned in `extras.authorSecUid`.

How to get cookies: open the target video in your browser, then export `cookies.txt` for `douyin.com` with any cookie-export extension, or copy the `Cookie` request header from DevTools (Network → the `aweme/detail` request). Keep `VIDEO_MCP_DOUYIN_UA` equal to the browser's own User-Agent; a mismatch can trigger an empty response.

If [browser-harness](https://github.com/browser-use/browser-harness) is installed locally and Chrome can open Douyin, export straight from the running browser instead — no extension needed:

```powershell
npm run douyin:cookies                  # writes <repo>/.douyin-cookies.txt
npm run douyin:cookies -- --guest-only  # drop login cookies, keep guest identity only
npm run douyin:cookies -- --out D:/path/cookies.txt
```

Cookies expire in weeks-to-months; the failure modes are `COOKIE_REQUIRED` or a `200` with an empty body. Re-run the command to refresh. `scripts/douyin-cookies.mjs` is a local convenience script only — it is not part of the MCP runtime and is never bundled into `dist`.

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

### Layout

```text
src/                         production code; `npm run build` compiles only this (→ dist/)
  index.ts                   MCP entry: defines and registers the four tools
                             (resolve_video / fetch_assets / get_cached / summarize) and
                             starts the stdio transport
  resolve.ts                 input normalisation: url, id, "platform:id" or a full VideoRef → VideoRef
  types.ts                   shared types: VideoRef, VideoStats, AssetManifest, VideoMcpError codes
  config.ts                  reads VIDEO_MCP_* variables; project root, default cookie file,
                             per-platform user agents, ASR and summary settings
  summarize.ts               calls an OpenAI-compatible chat completions endpoint and turns
                             metadata + subtitle/ASR text + keyframe list into a chaptered summary
  adapters/                  one group of files per platform
    types.ts                 PlatformAdapter contract (platform / canHandle / resolve / fetchMedia)
                             and MediaFetchResult
    registry.ts              registry: findAdapter(input) picks an adapter in order,
                             adapterByPlatform(name) serves cache reuse
    bilibili.ts              Bilibili: URL/BV/av parsing, view + player metadata, subtitles, download
    bilibili-storyboard.ts   Bilibili storyboard: videoshot sprite API + sharp cropping;
                             bilibili.ts falls back to downloading the whole video if it fails
    douyin.ts                Douyin: short-link resolution, cookie session, signed detail request,
                             media candidate download
    douyin-sign.ts           Douyin query signature x-secsdk-web-signature and the fixed web
                             parameters (pure functions)
  cache/
    store.ts                 cache root, <platform>/<id>/ layout, manifest.json read/write
  pipeline/
    assets.ts                post-download work: ffmpeg → 16 kHz mono WAV, ASR (local whisper or
                             cloud API), keyframe extraction, manifest write-back
    asr-text.ts              whisper.cpp JSON → Simplified Chinese, dedup, paragraph merge
tests/                       tests mirroring src/; `npm test` runs these, never built into dist
  config.test.ts             default paths and env precedence (including the default Douyin cookie file)
  adapters/bilibili.test.ts  Bilibili parsing, metadata, subtitles, download (mocked fetch)
  adapters/bilibili-storyboard.test.ts  storyboard cropping and the fallback path
  adapters/douyin.test.ts    Douyin input detection, cookie file parsing, resolve field mapping,
                             error codes, media candidates (mocked fetch)
  adapters/douyin-sign.test.ts  offline regression for the signature algorithm (no network)
  cache/store.test.ts        cache directories and manifest round-trip
  pipeline/assets.test.ts    transcode/ASR/keyframe orchestration (mocked external commands)
scripts/
  douyin-cookies.mjs         exports Douyin cookies from the real browser managed by
                             browser-harness (npm run douyin:cookies); not in dist
dist/                        build output; entry point is node dist/index.js (not committed)
cache/                       runtime cache, one subdirectory per video (not committed)
Release/                     whisper.cpp binaries and GGML models (not committed; README.md only)
```

`npm run build` compiles `src/` into `dist/`; `npm test` first type-checks `src/` and `tests/` together through `tsconfig.test.json`, then runs the tests. That keeps test files out of `dist/` while still failing on a type error.

Repository-root files:

| File | Purpose |
| --- | --- |
| `package.json` | Dependencies, `main`/`bin` entry, scripts (`build`, `test`, `douyin:cookies`), `prepare: npm run build`, `engines.node >= 20` |
| `tsconfig.json` | Build config: `src/` → `dist/`. |
| `tsconfig.test.json` | Same options with `noEmit` and `rootDir: "."` so `npm test` can type-check `src/` and `tests/` together. |
| `.gitignore` | Ignores `node_modules/`, `dist/`, `cache/`, binaries under `Release/`, `*.log`, `.env`, `*cookies*.txt`, `.playwright-mcp/` |
| `README.md` / `README.zh-CN.md` | English / Chinese documentation (this file) |
| `INSTALL_CN.md` | Chinese Windows + Cursor install walkthrough |
| `.douyin-cookies.txt` | Douyin cookies written by `npm run douyin:cookies`; the server reads this by default (not committed) |
| `Release/README.md` | Where to put local whisper.cpp binaries and models (the binaries themselves are not committed) |

### Get whisper.cpp working (only for local ASR)

The upstream repository is **[ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp)**. Download executables from its [Releases](https://github.com/ggml-org/whisper.cpp/releases) and a GGML model from [ggerganov/whisper.cpp on Hugging Face](https://huggingface.co/ggerganov/whisper.cpp). **The executable and model are separate downloads**; `npm ci` does not install either. Neither is needed if you do not request local ASR.

1. **Choose a binary:** On Windows x64, download a suitable CPU archive from Releases and keep `whisper-cli.exe` **together with its DLLs** (for example under `Release/whisper-cpu-windows-x64/`). For NVIDIA GPUs use a CUDA build targeting your GPU architecture; a build merely labeled CUDA is not necessarily compatible. On macOS/Linux use a build for your system. Alternatively, follow the [upstream build instructions](https://github.com/ggml-org/whisper.cpp#readme).
2. **Get a model:** Download the multilingual `ggml-large-v3-turbo.bin` (~1.6 GB) to `Release/models/ggml-large-v3-turbo.bin`, or choose another multilingual GGML model and use its actual path. English-only `.en` models are not suitable for Chinese audio. If you have the whisper.cpp source, its [Windows model download script](https://github.com/ggml-org/whisper.cpp/blob/master/models/download-ggml-model.cmd) can be run in PowerShell from that source directory with `& .\models\download-ggml-model.cmd large-v3-turbo`; then move the model to your chosen location.
3. **Drop it into `Release/` (recommended) or set paths:** if the binaries and model from the package below already live in `Release/`, **no environment variables are needed** — the server discovers `Release/whisper-*/whisper-cli.exe` and `Release/models/ggml-*.bin` itself (preferring the CUDA build when an NVIDIA GPU is present, otherwise CPU). To use a different binary or model, set `VIDEO_MCP_WHISPER_BIN` / `VIDEO_MCP_WHISPER_MODEL`; they always win over auto-detection. Restart the client, put ffmpeg on `PATH`, then call `fetch_assets` on a video without available subtitles — it transcribes automatically and returns text only; add `wantKeyframes: true` if you also want frames.

**Windows x64 package download:** [Quark share](https://pan.quark.cn/s/3f1f83689bec?pwd=CSxJ), extraction code `CSxJ`. The share contains `models/`, `whisper-cpu-windows-x64/`, and `whisper-cuda13.2-rtx20-50-windows-x64/`. Download the model and the CPU or CUDA executable folder, and place them under this project's `Release/` directory without renaming them. It contains Whisper binaries and a model, **not this project's source code or npm dependencies**.

[`Release/README.md`](Release/README.md) explains the locally prepared Windows x64 CPU and CUDA 13.2 GPU builds. The binaries and model are **git-ignored**: a source checkout does not contain them, so substitute your own actual installation paths. The prepared GPU build targets SM 75/86/89/120 (RTX 20/30/40/50 architectures); only RTX 5060 Ti was tested here. It still needs a compatible GPU driver, sufficient VRAM, and the Microsoft Visual C++ runtime. CUDA Toolkit is not required on the destination PC when the packaged redistributable CUDA DLLs are included. GTX 10, macOS, Linux, and Windows ARM64 require a suitable other build. The server auto-detects `Release/`: **the CUDA build is preferred when a usable NVIDIA GPU is present, otherwise the CPU build**; environment variables always override detection. Observe third-party licenses when distributing binaries and models.

## Configure an MCP client

Replace `PATH_TO_JIANWEN` with the **absolute path** of your checkout. On Windows you can use forward slashes in JSON paths (for example `D:/Code/Jianwen/dist/index.js`). Ensure `node` is on the client's `PATH`, or use its absolute executable path.

For Cursor/Claude Desktop, put this server entry into the client's `mcp.json` (Claude Desktop on Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "jianwen": {
      "command": "node",
      "args": ["PATH_TO_JIANWEN/dist/index.js"]
    }
  }
}
```

Leave `env` out unless you need an override: local ASR is discovered from `Release/` on its own, and Douyin cookies are read from `<repo>/.douyin-cookies.txt` by default. The environment-variable table below lists every knob.

For **Pi**, add the same entry to the user-level `~/.pi/agent/mcp.json` (Windows: `%USERPROFILE%\.pi\agent\mcp.json`), optionally setting `"timeout": 300` and `"exposure": "codemode"`. Preserve other entries in an existing file. Run `pi mcp list` to check the connection and `/reload` in an already open Pi session after changing the config. Progress-aware Pi requests can stay alive during longer `fetch_assets` calls; configure client timeouts for your own environment rather than assuming a fixed limit always suffices.

### Smoke test without a client

Before wiring a client, validate the server from a terminal:

```bash
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

In the Inspector's **Tools** tab:

1. `resolve_video` with `{ "id": "BV1GJ411x7h7" }` (use a BV id you know is public) — expect metadata plus a `pageUrl`.
2. `fetch_assets` with the same video and no other options — expect transcript text only. Frames are off by default; pass `"wantKeyframes": true` to get JPEG paths, which needs `ffmpeg`.
3. `get_cached` with the same id — expect the manifest that step 2 wrote.
4. `summarize` — returns `SUMMARY_UNSET` until `VIDEO_MCP_SUMMARY_*` is configured; the other three tools keep working.

The same steps work for Douyin (a 19-digit id, a `douyin.com/video/<id>` link, a `v.douyin.com` short link, or a whole share message) once `<repo>/.douyin-cookies.txt` exists.

**Point at a different Whisper binary or model (optional):** nothing is needed while they sit in `Release/`; to override auto-detection, add an `env` object to the client config, for example on Windows:

```json
{
  "VIDEO_MCP_ASR_PROVIDER": "whisper_local",
  "VIDEO_MCP_WHISPER_BIN": "PATH_TO_JIANWEN/Release/whisper-cpu-windows-x64/whisper-cli.exe",
  "VIDEO_MCP_WHISPER_MODEL": "PATH_TO_JIANWEN/Release/models/ggml-large-v3-turbo.bin",
  "VIDEO_MCP_WHISPER_LANGUAGE": "auto"
}
```

Measured on an RTX 5060 Ti: a **667-second** Douyin video took **33 seconds** for download + keyframes + `large-v3-turbo` transcription, producing **4520 characters** of Chinese transcript.

### Environment variables

The historical `VIDEO_MCP_` prefix is retained for compatibility with older configurations.

| Variable | Use |
| --- | --- |
| `VIDEO_MCP_CACHE_DIR` | Cache root; default `<project>/cache`. |
| `VIDEO_MCP_ASR_PROVIDER` | Unset means **auto**: `whisper_local` when a whisper binary and model are found under `Release/`, otherwise `none`. May also be set explicitly to `whisper_local`, `openai_compatible`, or `none`. Any non-`none` value makes `fetch_assets` transcribe automatically unless `wantAsr: false` is passed. |
| `VIDEO_MCP_WHISPER_BIN` / `VIDEO_MCP_WHISPER_MODEL` | Local binary and model paths. Defaults are discovered: `Release/whisper-*/whisper-cli.exe` (CUDA build preferred when an NVIDIA GPU is available) and `Release/models/ggml-*.bin` (turbo preferred); `whisper-cli` on `PATH` is only used when neither exists. |
| `VIDEO_MCP_WHISPER_LANGUAGE` | Whisper language; default `auto`, or e.g. `zh`. |
| `VIDEO_MCP_WHISPER_VAD_MODEL` | Silero VAD model path; default is `Release/models/ggml-silero-*.bin` whenever one exists. VAD drops music-only/silent stretches before transcribing, which is where whisper tends to loop or hallucinate. Set to `0`/`off` to disable. |
| `VIDEO_MCP_KEEP_MEDIA` | Set to `1` to keep the downloaded video after extraction (default: delete it, keeping only `keyframes/`, `audio_16k.wav`, etc.). |
| `VIDEO_MCP_ASR_BASE_URL` / `VIDEO_MCP_ASR_API_KEY` / `VIDEO_MCP_ASR_MODEL` | Compatible speech-transcription API (`MODEL` defaults to `whisper-1`). **Audio is sent to this service.** |
| `VIDEO_MCP_SUMMARY_BASE_URL` / `VIDEO_MCP_SUMMARY_API_KEY` / `VIDEO_MCP_SUMMARY_MODEL` | Compatible chat-completions API for `summarize`. **Text and available frame images may be sent to this service.** |
| `VIDEO_MCP_BILIBILI_UA` | Override the Bilibili request User-Agent. |
| `VIDEO_MCP_DOUYIN_COOKIE_FILE` | Path to a Netscape `cookies.txt` exported for `douyin.com`. **Optional**: when unset, the repo-root `.douyin-cookies.txt` is used if it exists. Only rows whose domain looks like Douyin/ByteDance are sent. |
| `VIDEO_MCP_DOUYIN_COOKIES` | Raw `Cookie` header value for Douyin, used instead of the file. Must contain `UIFID`. |
| `VIDEO_MCP_DOUYIN_UA` | Override the Douyin request User-Agent (default Chrome 156 on Windows). Keep it consistent with the browser that issued the cookies. |
| `VIDEO_MCP_DOUYIN_FAST_AUDIO` | Also controls how transcript-only Douyin requests get their audio. **On by default**: ffmpeg streams the audio track out of the CDN URL instead of downloading the whole mp4 (≈10 MB instead of ≈35 MB for an 11-minute video), falling back automatically on any failure. Set `0` to always download the full file. |

If the summary provider is unset, `summarize` returns `SUMMARY_UNSET`; the other three tools work independently. Avoid committing credentials. Cached audio, WAV, frames, subtitles and the manifest remain on disk until you delete them; normal MCP results include text and **local paths**, not embedded frame images.

## Example calls and timeouts

```json
resolve_video  { "url": "https://www.bilibili.com/video/BV1VqsQ6KEoy" }
fetch_assets   { "id": "BV1VqsQ6KEoy" }
fetch_assets   { "id": "BV1VqsQ6KEoy", "wantAsr": true }
fetch_assets   { "id": "BV1VqsQ6KEoy", "wantKeyframes": true, "keyframeIntervalSec": 20 }
get_cached     { "id": "BV1VqsQ6KEoy" }
resolve_video  { "url": "https://v.douyin.com/j9yY-DusDuk/" }
fetch_assets   { "id": "7703476743591513353", "wantAsr": true }
```

The first call takes whatever comes cheap: platform subtitles when they exist, otherwise a transcript once ASR is configured. It never downloads media for sampling unless you pass `wantKeyframes: true`. Do not infer what the video says from its title alone. `fetch_assets` stores files under `<cache>/bilibili/<BV-ID>/` (`manifest.json`, optional `subtitle.txt`, `asr.txt`, `audio_16k.wav`, `keyframes/`, etc.); the full `media.mp4` is removed automatically once frames or a transcript exist (`VIDEO_MCP_KEEP_MEDIA=1` keeps it). If content has changed, call `fetch_assets` again for a fresh metadata snapshot.

Local Whisper process timeout is estimated from the first-page duration in seconds: `min(86400, max(300, ceil(durationSec * 3 + 120)))`; unknown/invalid duration defaults to **1800 seconds**. Override via `fetch_assets` argument `asrTimeoutSec` (integer **30–86400**). This only bounds the **local Whisper subprocess**, not resolution, downloading, ffmpeg, cloud ASR, or the MCP client's own timeout. If the client provides a progress token, `fetch_assets` reports progress at stage changes and about every **20 seconds**; clients that reset their timeout on progress (including Pi) can keep waiting. Cancellation stops active ffmpeg/Whisper subprocesses, but may not immediately interrupt downloading.

On the maintainer's test machine, the example BV above yielded a local transcript when ASR was requested, and `wantKeyframes: true` produced six storyboard frames without downloading video. A separate **2397-second** video (`BV1fKeg6mEY4`) completed GPU transcription in about **94 seconds**, with eight progress notifications. That is one environment-specific observation, **not** proof that every client will survive a 300-second request or that every long video finishes in this time.

## Troubleshooting and limits

- **Verify the upstream API:** in Postman, send `GET https://api.bilibili.com/x/web-interface/view` with Params `bvid=BV1VqsQ6KEoy`. Inspect both HTTP status and JSON `code` (`0` means success). `data.pubdate` is Unix seconds, `data.owner.mid` is the UID, `data.stat.reply` is a count, not comment text. This is a Bilibili web endpoint used by this code, **not** an MCP HTTP endpoint or a guaranteed official Open Platform contract. Access and rate limits can change; avoid aggressive retries.
- **No transcript?** Some videos expose no subtitles. Install ffmpeg plus Whisper (or configure a compatible provider) and set `VIDEO_MCP_ASR_PROVIDER`; transcription then runs by default, since `wantAsr` only stays off when you pass `false`.
- **No frames?** Storyboard may be unavailable; the fallback needs media access, ffmpeg, and sometimes yt-dlp. Paywalled, VIP, or login-only material is unsupported; the server does not use cookies.
- **No cache?** `get_cached` returns `CACHE_MISS` until `fetch_assets` has written a manifest. A cached manifest does not update its engagement counts automatically.
- **Long operations?** Raise the client's request timeout as needed; the Whisper timeout override alone does not extend it. A freshly edited Pi MCP config may require `/reload`.
- **Platform scope:** `src/adapters/registry.ts` registers Bilibili and Douyin. Douyin needs browser guest cookies plus a signed detail query; without `VIDEO_MCP_DOUYIN_COOKIE_FILE` it fails with `COOKIE_REQUIRED`. A `200` response with an **empty body** is Douyin's soft rate-limit / not-visible signal — refresh the cookies instead of retrying in a loop. Image posts (`/note/`) are unsupported. Bilibili's authorized APIs and Douyin's signed web endpoints differ, so each platform keeps its own adapter.

To add another platform, implement `PlatformAdapter` in `src/adapters/` and register it in `src/adapters/registry.ts`. Run `npm test` and `npm run build` after changes. For a more detailed Chinese walkthrough, see [README.zh-CN.md](README.zh-CN.md) and [Windows Cursor setup](INSTALL_CN.md).

## License

MIT (see `package.json`). Third-party model/binary licenses apply separately.
