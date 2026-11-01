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
  "Resolve a Bilibili URL or BV/av id into a VideoRef (title, duration, author, publishedAt and engagement stats snapshot).",
  {
    url: z.string().optional().describe("Bilibili watch URL or b23.tv short link"),
    id: z.string().optional().describe("BV id (e.g. BV1xx...) or av number"),
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
  "Cache subtitles, optional ASR and up to 6 storyboard frames; fall back to video download + ffmpeg if storyboard is unavailable. Local ASR timeout is estimated from durationSec or overridden with asrTimeoutSec; long operations report progress. Returns local paths.",
  {
    url: z.string().optional(),
    id: z.string().optional(),
    ref: videoRefSchema.optional(),
    wantSubtitles: z.boolean().optional().default(true),
    wantAsr: z.boolean().optional().default(false),
    asrTimeoutSec: z.number().int().min(30).max(86400).optional()
      .describe("Optional Whisper process timeout in seconds; defaults to durationSec * 3 + 120 (min 300, max 86400). Does not change the MCP client's timeout."),
    wantKeyframes: z.boolean().optional().default(true),
    keyframeIntervalSec: z.number().optional().default(10),
  },
  async (args, extra) => {
    const started = Date.now();
    let stage = "正在解析视频信息";
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
      if (args.wantAsr && getAsrProvider() === "whisper_local") {
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
  "Optional structured summary from cached assets via VIDEO_MCP_SUMMARY_* env. Errors clearly if unset.",
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
          wantAsr: false,
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
