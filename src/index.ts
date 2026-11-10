#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { adapterByPlatform } from "./adapters/registry.js";
import { CacheStore } from "./cache/store.js";
import { getAsrProvider } from "./config.js";
import { estimateAsrTimeoutSec, fetchAssets } from "./pipeline/assets.js";
import { resolveInput } from "./resolve.js";
import { summarizeManifest } from "./summarize.js";
import { VideoMcpError, type VideoRef } from "./types.js";

const cache = new CacheStore();

const videoRefSchema = z
  .object({
    platform: z.string(),
    id: z.string(),
    title: z.string().optional(),
    durationSec: z.number().optional(),
    author: z.string().optional(),
    authorId: z.number().optional(),
    publishedAt: z.string().optional(),
    stats: z.object({
      views: z.number().optional(),
      shares: z.number().optional(),
      comments: z.number().optional(),
      likes: z.number().optional(),
      favorites: z.number().optional(),
      coins: z.number().optional(),
      danmaku: z.number().optional(),
    }).optional(),
    pageUrl: z.string().optional(),
    extras: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  })
  .partial()
  .extend({
    platform: z.string().optional(),
    id: z.string().optional(),
  });

function textResult(data: unknown, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
    isError,
  };
}

function formatErr(err: unknown) {
  if (err instanceof VideoMcpError) {
    return textResult({ error: err.code, message: err.message }, true);
  }
  const message = err instanceof Error ? err.message : String(err);
  return textResult({ error: "INTERNAL", message }, true);
}

const server = new McpServer({
  name: "jianwen",
  version: "0.1.0",
});

server.tool(
  "resolve_video",
  "Resolve a Bilibili video/dynamic/column or a Douyin video, or a Weixin public-account article into a VideoRef (title, author, publishedAt and platform extras). Bilibili also accepts bangumi and course episodes (metadata + episode), dynamics (/opus/<id>) and columns (/read/cv<id>), which come back as text with image URLs. Douyin requires browser guest cookies via VIDEO_MCP_DOUYIN_COOKIE_FILE or VIDEO_MCP_DOUYIN_COOKIES; Weixin long links may need VIDEO_MCP_WEIXIN_CHKSM, while short mp.weixin.qq.com/s/<id> links usually work directly.",
  {
    url: z.string().optional().describe("Bilibili watch/page URL (video with optional ?p=N, /bangumi/play/ep|ss|md, /cheese/play/ep|ss, /opus/<id>, /read/cv<id>), b23.tv short link, Douyin video URL, v.douyin.com share link, or Weixin article URL (mp.weixin.qq.com/s/...)"),
    id: z.string().optional().describe("BV id (e.g. BV1xx...), av number, or Douyin aweme id"),
  },
  async ({ url, id }) => {
    try {
      const ref = await resolveInput({ url, id });
      return textResult(ref);
    } catch (err) {
      return formatErr(err);
    }
  },
);

server.tool(
  "fetch_assets",
  "Cache video assets (subtitles, optional ASR, up to 6 storyboard frames; fall back to video download + ffmpeg if storyboard is unavailable), or parse a text page (Weixin public-account article, Bilibili dynamic/column) into article.md and optional images. Local ASR timeout is estimated from durationSec or overridden with asrTimeoutSec; long operations report progress. Returns local paths. Bilibili exposes subtitles and a storyboard; Douyin has neither, so Douyin always downloads the video for ASR/frames; text pages (Weixin articles, Bilibili dynamics/columns) skip ASR/ffmpeg entirely.",
  {
    url: z.string().optional(),
    id: z.string().optional(),
    ref: videoRefSchema.optional(),
    wantSubtitles: z.boolean().optional().default(true),
    wantAsr: z.boolean().optional()
      .describe("Transcribe the audio with ASR. Defaults to on when VIDEO_MCP_ASR_PROVIDER is configured (and is skipped automatically when the platform already has subtitles); set false to force it off."),
    asrTimeoutSec: z.number().int().min(30).max(86400).optional()
      .describe("Optional Whisper process timeout in seconds; defaults to durationSec * 3 + 120 (min 300, max 86400). Does not change the MCP client's timeout."),
    wantKeyframes: z.boolean().optional().default(false)
      .describe("Extract representative frames for videos, or download article images for Weixin. Defaults to false: without it only text (platform subtitles, ASR, or article text) is collected, which avoids downloading the whole video on Douyin. Set true when you need to see the picture."),
    keyframeIntervalSec: z.number().optional().default(10),
  },
  async (args, extra) => {
    const started = Date.now();
    let stage = "正在解析视频/文章信息";
    const token = extra._meta?.progressToken;
    const reportProgress = () => {
      if (token === undefined || extra.signal.aborted) return;
      void extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress: Math.floor((Date.now() - started) / 1000),
          message: `${stage}；已耗时 ${Math.floor((Date.now() - started) / 1000)} 秒`,
        },
      }).catch(() => {});
    };
    // Pi 每次收到进度通知都会重置其单次请求超时；无进度令牌的客户端仍需自行调大超时。
    const heartbeat = token === undefined ? undefined : setInterval(reportProgress, 20000);
    try {
      const ref = await resolveInput({
        url: args.url,
        id: args.id,
        ref: args.ref as VideoRef | undefined,
      });
      if (args.wantAsr !== false && getAsrProvider() === "whisper_local" && ref.durationSec > 0) {
        stage = `视频时长 ${ref.durationSec} 秒；Whisper 最长 ${args.asrTimeoutSec ?? estimateAsrTimeoutSec(ref.durationSec)} 秒`;
        reportProgress();
      }
      const adapter = adapterByPlatform(ref.platform);
      const manifest = await fetchAssets(adapter, ref, cache, {
        wantSubtitles: args.wantSubtitles,
        wantAsr: args.wantAsr,
        asrTimeoutSec: args.asrTimeoutSec,
        wantKeyframes: args.wantKeyframes,
        keyframeIntervalSec: args.keyframeIntervalSec,
      }, {
        signal: extra.signal,
        onProgress: (next) => { stage = next; reportProgress(); },
      });
      return textResult(manifest);
    } catch (err) {
      return formatErr(err);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  },
);

server.tool(
  "get_cached",
  "Read an existing AssetManifest from the local cache without re-downloading.",
  {
    url: z.string().optional(),
    id: z.string().optional(),
    ref: videoRefSchema.optional(),
  },
  async (args) => {
    try {
      const ref = await resolveInput({
        url: args.url,
        id: args.id,
        ref: args.ref as VideoRef | undefined,
      });
      const manifest = await cache.readManifest(ref);
      if (!manifest) {
        return textResult(
          {
            error: "CACHE_MISS",
            message: `No cache for ${ref.platform}/${ref.id}. Call fetch_assets first.`,
            cacheDir: cache.dirFor(ref),
          },
          true,
        );
      }
      return textResult(manifest);
    } catch (err) {
      return formatErr(err);
    }
  },
);

server.tool(
  "summarize",
  "Optional structured summary from cached video assets or Weixin article text via VIDEO_MCP_SUMMARY_* env. Errors clearly if unset.",
  {
    url: z.string().optional(),
    id: z.string().optional(),
    ref: videoRefSchema.optional(),
    focus: z
      .string()
      .optional()
      .describe("Optional focus prompt, e.g. 'extract homework deadlines'"),
    fetchIfMissing: z
      .boolean()
      .optional()
      .default(true)
      .describe("If no cache, run fetch_assets first"),
  },
  async (args) => {
    try {
      const ref = await resolveInput({
        url: args.url,
        id: args.id,
        ref: args.ref as VideoRef | undefined,
      });
      let manifest = await cache.readManifest(ref);
      if (!manifest) {
        if (!args.fetchIfMissing) {
          throw new VideoMcpError(
            "No cached assets. Call fetch_assets or set fetchIfMissing=true.",
            "CACHE_MISS",
          );
        }
        const adapter = adapterByPlatform(ref.platform);
        manifest = await fetchAssets(adapter, ref, cache, {
          wantSubtitles: true,
          wantKeyframes: true,
        });
      }
      const summary = await summarizeManifest(manifest, args.focus);
      return textResult(summary);
    } catch (err) {
      return formatErr(err);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
