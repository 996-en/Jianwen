import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { bilibiliUserAgent } from "../config.js";
import { VideoMcpError, type FetchAssetsOptions, type VideoRef } from "../types.js";
import type { MediaFetchResult, PlatformAdapter } from "./types.js";
import { fetchStoryboardFrames } from "./bilibili-storyboard.js";
import {
  AV_RE,
  BV_RE,
  extractShortLink,
  parseBiliLink,
  type BiliLink,
} from "./bilibili-parse.js";
import { fetchBilibiliTextMedia, resolveArticleRef, resolveDynamicRef } from "./bilibili-opus.js";
import { assertPgcWatchable, fetchPgcPlayurl, resolveBangumiRef, resolveCheeseRef } from "./bilibili-pgc.js";
import { isRateLimit } from "./bilibili-api.js";

// 解析相关的纯函数搬到 bilibili-parse.ts，这里继续对外导出以保持调用方不变
export {
  extractAvId,
  extractBvId,
  extractShortLink,
  isBilibiliInput,
  parseBiliLink,
} from "./bilibili-parse.js";

/** 支持的类型，用在报错信息里 */
const SUPPORTED_HINT =
  "支持视频（BV/av、?p=N 分 P）、番剧（/bangumi/play/ep|ss|md）、课程（/cheese/play/ep|ss）、动态（/opus/<id>、t.bilibili.com/<id>）、专栏（/read/cv<id>）以及 b23.tv 短链";

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "User-Agent": bilibiliUserAgent(),
      Referer: "https://www.bilibili.com/",
      ...(init?.headers ?? {}),
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new VideoMcpError(
      `HTTP ${res.status} fetching ${url}`,
      res.status === 404 ? "NOT_FOUND" : "DOWNLOAD_FAILED",
    );
  }
  return res.text();
}

async function fetchJson<T>(url: string): Promise<T> {
  const text = await fetchText(url);
  return JSON.parse(text) as T;
}

/**
 * 跟随 b23.tv 短链到最终地址。先 manual 逐跳读 Location（分享文案跳转经常不止一跳），
 * 中途解析到任何 B 站内容就提前返回；拿不到 Location 的环节退回 follow 后取最终 URL。
 */
async function resolveShortLink(
  url: string,
): Promise<{ url: string; status: number; apiMessage?: string }> {
  let current = url;
  let status = 0;
  const looksResolved = (candidate: string): boolean => {
    const link = parseBiliLink(candidate);
    return Boolean(link && link.kind !== "short" && link.kind !== "unknown");
  };

  for (let hop = 0; hop < 5; hop += 1) {
    const res = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": bilibiliUserAgent() },
    });
    status = res.status;
    const location = res.headers.get("location");
    if (!location) {
      // 失效/不存在的短链不会 302，而是 HTTP 200 + {"code":-404,"message":"啥都木有"}；
      // 非 JSON 的落地页（活动页/中转页）交给下面的 follow 兜底拿最终地址
      const probed = await readShortLinkError(res);
      if (probed.json) return { url: current, status, apiMessage: probed.message };
      break;
    }
    await res.body?.cancel();
    current = new URL(location, current).toString();
    if (looksResolved(current)) return { url: current, status };
  }
  if (looksResolved(current)) return { url: current, status };

  // 有些网络环境下 redirect: manual 拿不到 Location，退回跟随重定向后解析最终 URL。
  const followed = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { "User-Agent": bilibiliUserAgent() },
  });
  await followed.body?.cancel();
  return { url: followed.url, status: followed.status };
}

/** 短链没有跳转时，读一下 b23.tv 的 JSON 响应（失效短链：{"code":-404,"message":"啥都木有"}） */
async function readShortLinkError(
  res: Response,
): Promise<{ json: boolean; message?: string }> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    await res.body?.cancel();
    return { json: false };
  }
  try {
    const json = (await res.json()) as { code?: number; message?: string };
    if (typeof json?.code === "number" && json.code !== 0) {
      return { json: true, message: json.message || `code ${json.code}` };
    }
    return { json: true };
  } catch {
    // 不是合法 JSON 就当没识别到
    return { json: false };
  }
}

function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, ["--version"], {
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

function runCommand(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `${cmd} exited ${code}: ${stderr.slice(-800) || stdout.slice(-800)}`,
          ),
        );
    });
  });
}

interface ViewApiResponse {
  code: number;
  message: string;
  data?: {
    bvid: string;
    aid: number;
    title: string;
    duration: number;
    owner?: { name: string; mid: number };
    pubdate?: number;
    stat?: {
      view?: number;
      share?: number;
      reply?: number;
      like?: number;
      favorite?: number;
      coin?: number;
      danmaku?: number;
    };
    pages?: Array<{ cid: number; page: number; part: string; duration: number }>;
    rights?: { pay?: number; ugc_pay?: number };
  };
}

interface PlayerResponse {
  code: number;
  message: string;
  data?: {
    subtitle?: {
      subtitles?: Array<{
        lan: string;
        lan_doc: string;
        subtitle_url: string;
      }>;
    };
  };
}

interface PlayUrlResponse {
  code: number;
  message: string;
  data?: {
    dash?: {
      audio?: Array<{ baseUrl?: string; base_url?: string }>;
      video?: Array<{ baseUrl?: string; base_url?: string }>;
    };
    durl?: Array<{ url: string }>;
  };
}

export class BilibiliAdapter implements PlatformAdapter {
  readonly platform = "bilibili";

  canHandle(input: string): boolean {
    return parseBiliLink(input) !== null;
  }

  async resolve(input: string): Promise<VideoRef> {
    const initial = parseBiliLink(input);
    if (!initial) {
      throw new VideoMcpError(
        `Could not parse a Bilibili link or id from: ${input}`,
        "UNSUPPORTED_URL",
      );
    }

    let link = initial;
    let source = input.trim();

    // 短链：先跟到真正的页面，再按页面类型分派
    if (link.kind === "short") {
      const shortLink = extractShortLink(source)!;
      let followed: { url: string; status: number; apiMessage?: string };
      try {
        followed = await resolveShortLink(shortLink);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new VideoMcpError(
          `Could not follow Bilibili short link ${shortLink}: ${reason}`,
          "UNSUPPORTED_URL",
        );
      }
      // 失效短链：b23.tv 返回 200 + {"code":-404,"message":"啥都木有"}，没有跳转
      if (followed.apiMessage) {
        throw new VideoMcpError(
          `B 站短链 ${shortLink} 已失效或不存在（b23.tv：${followed.apiMessage}），请在 App 里重新复制分享链接`,
          "NOT_FOUND",
        );
      }
      const target = parseBiliLink(followed.url);
      if (!target || target.kind === "short" || target.kind === "unknown") {
        throw new VideoMcpError(
          `Bilibili short link ${shortLink} led to ${followed.url}, which is not a video page or other supported content page (HTTP ${followed.status}). ${SUPPORTED_HINT}`,
          "UNSUPPORTED_URL",
        );
      }
      link = target;
      source = followed.url;
    }

    switch (link.kind) {
      case "video":
        return this.resolveVideo(source, link);
      case "bangumi":
        return resolveBangumiRef(link);
      case "cheese":
        return resolveCheeseRef(link);
      case "opus":
        // 动态可能只是壳：投稿视频动态要跳到背后的视频
        return resolveDynamicRef(link.id, (bvid) =>
          this.resolveVideo(`https://www.bilibili.com/video/${bvid}`, {
            kind: "video",
            id: bvid,
            page: 1,
          }),
        );
      case "article":
        return resolveArticleRef(link.id);
      case "audio":
        throw new VideoMcpError(
          `B 站音频区（au）暂不支持，请提供视频、番剧、课程、动态或专栏链接。${SUPPORTED_HINT}`,
          "UNSUPPORTED_URL",
        );
      default:
        throw new VideoMcpError(
          `这条 bilibili.com 链接的类型暂不支持（直播、收藏夹、合集、UP 主空间等）。${SUPPORTED_HINT}`,
          "UNSUPPORTED_URL",
        );
    }
  }

  /** 普通投稿视频：按 ?p=N 选分 P */
  private async resolveVideo(raw: string, link: BiliLink): Promise<VideoRef> {
    const bvidFromLink = link.id.startsWith("av") ? null : link.id;
    const avid = link.id.startsWith("av") ? link.id.slice(2) : null;

    const apiUrl = bvidFromLink
      ? `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvidFromLink)}`
      : `https://api.bilibili.com/x/web-interface/view?aid=${encodeURIComponent(avid ?? "")}`;

    if (!bvidFromLink && !avid) {
      throw new VideoMcpError(
        `Could not parse a Bilibili BV/av id from: ${raw}`,
        "UNSUPPORTED_URL",
      );
    }

    const json = await fetchJson<ViewApiResponse>(apiUrl);
    if (json.code === -404 || json.code === 62002) {
      throw new VideoMcpError(
        `Video not found or unavailable: ${json.message}`,
        "NOT_FOUND",
      );
    }
    if (json.code !== 0 || !json.data) {
      const msg = json.message || `code ${json.code}`;
      if (isRateLimit(json.code, msg)) {
        throw new VideoMcpError(`B 站限流（${json.code}：${msg}），请等几十秒后重试`, "DOWNLOAD_FAILED");
      }
      if (/登录|login|会员|大会员|pay/i.test(msg)) {
        throw new VideoMcpError(
          `VIP or login required (v1 has no cookies): ${msg}`,
          "VIP_OR_LOGIN",
        );
      }
      throw new VideoMcpError(`Bilibili view API failed: ${msg}`, "DOWNLOAD_FAILED");
    }

    const d = json.data;
    if (d.rights?.pay === 1 || d.rights?.ugc_pay === 1) {
      throw new VideoMcpError(
        "This video requires payment/VIP. v1 does not support login or cookies.",
        "VIP_OR_LOGIN",
      );
    }

    const bvid = d.bvid;
    const pages = d.pages ?? [];
    const pageCount = pages.length;
    // ?p= 越界时夹到最后一 P，避免 cid 为 undefined
    const pageIndex = pageCount > 0 ? Math.min(Math.max(link.page, 1), pageCount) - 1 : 0;
    const page = pages[pageIndex];
    const pageNumber = page?.page ?? 1;
    const durationSec = page?.duration ?? d.duration ?? 0;
    const multiPage = pageCount > 1;

    const title =
      multiPage && (page?.part ?? "").trim() && (page?.part ?? "").trim() !== d.title.trim()
        ? `${d.title} · P${pageNumber} ${(page?.part ?? "").trim()}`
        : multiPage
          ? `${d.title} · P${pageNumber}`
          : d.title;

    const extras: Record<string, string | number | boolean | null> = {
      aid: d.aid,
      cid: page?.cid ?? 0,
    };
    // 单 P 视频保持 extras 原样（{aid, cid}），多 P 才补充分 P 信息
    if (multiPage) {
      extras.bvid = bvid;
      extras.page = pageNumber;
      extras.pageCount = pageCount;
    }

    return {
      platform: "bilibili",
      // 多 P 时把 P 号写进 id，避免不同分 P 共用同一个缓存目录
      id: multiPage ? `${bvid}_p${pageNumber}` : bvid,
      title,
      durationSec,
      author: d.owner?.name ?? "unknown",
      authorId: d.owner?.mid,
      publishedAt: typeof d.pubdate === "number" && d.pubdate > 0
        ? new Date(d.pubdate * 1000).toISOString()
        : undefined,
      stats: d.stat ? {
        views: d.stat.view,
        shares: d.stat.share,
        comments: d.stat.reply,
        likes: d.stat.like,
        favorites: d.stat.favorite,
        coins: d.stat.coin,
        danmaku: d.stat.danmaku,
      } : undefined,
      pageUrl: `https://www.bilibili.com/video/${bvid}${multiPage && pageNumber > 1 ? `?p=${pageNumber}` : ""}`,
      extras,
    };
  }

  async fetchMedia(
    ref: VideoRef,
    destDir: string,
    options?: FetchAssetsOptions,
  ): Promise<MediaFetchResult> {
    await fs.mkdir(destDir, { recursive: true });
    const kind = String(ref.extras?.kind ?? "video");

    // 动态与专栏是图文：写 article.md，不进入 ffmpeg / ASR
    if (kind === "opus" || kind === "article") {
      return fetchBilibiliTextMedia(ref, destDir, options);
    }

    // 会员集/未购课程：先失败，避免故事板、yt-dlp 或 playurl 把 180 秒试看当成正片
    if (kind === "bangumi" || kind === "cheese") assertPgcWatchable(ref);

    const result: MediaFetchResult = {};

    const aid = Number(ref.extras?.aid ?? 0);
    const cid = Number(ref.extras?.cid ?? 0);

    // Subtitles via player API（番剧/课程同样适用，PGC 多数没有字幕，失败不影响）
    if (options?.wantSubtitles !== false && cid) {
      try {
        const playerUrl = `https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${cid}`;
        const player = await fetchJson<PlayerResponse>(playerUrl);
        const subs = player.data?.subtitle?.subtitles ?? [];
        const preferred =
          subs.find((s) => /zh|ai-zh|中/i.test(s.lan) || /中/i.test(s.lan_doc)) ??
          subs[0];
        if (preferred?.subtitle_url) {
          let subUrl = preferred.subtitle_url;
          if (subUrl.startsWith("//")) subUrl = `https:${subUrl}`;
          const body = await fetchText(subUrl);
          const subtitlePath = path.join(destDir, "subtitle.json");
          await fs.writeFile(subtitlePath, body, "utf8");
          result.subtitlePath = subtitlePath;
          result.subtitleText = subtitleJsonToText(body);
          const txtPath = path.join(destDir, "subtitle.txt");
          await fs.writeFile(txtPath, result.subtitleText, "utf8");
        }
      } catch {
        // Subtitles optional; continue
      }
    }

    if (options?.wantKeyframes === true && cid) {
      try {
        result.keyframePaths = await fetchStoryboardFrames(
          ref,
          destDir,
          options?.keyframeIntervalSec ?? 10,
        );
      } catch (err) {
        result.storyboardError = err instanceof Error ? err.message : String(err);
      }
    }

    const needVideo = options?.wantKeyframes === true && !result.keyframePaths?.length;
    const needAudio = options?.wantAsr === true && !result.subtitleText;
    if (!needVideo && !needAudio) return result;

    // 只有 ASR 需要媒体时，优先下载音频轨，不下载整段视频。
    const audioOnly = needAudio && !needVideo;
    const isPgc = kind === "bangumi" || kind === "cheese";
    let ytDlpError: string | undefined;

    // Prefer yt-dlp when present（对番剧/课程也先试一次，失败再走 playurl）
    const hasYtDlp = await commandExists("yt-dlp");
    if (hasYtDlp) {
      try {
        const outTpl = path.join(destDir, `${audioOnly ? "audio" : "media"}.%(ext)s`);
        await runCommand("yt-dlp", [
          "-f",
          audioOnly ? "ba" : "bv*[height<=720]+ba/b[height<=720]/b",
          "--no-playlist",
          "-o",
          outTpl,
          ref.pageUrl,
        ]);
        const files = await fs.readdir(destDir);
        const media = files.find(
          (f) =>
            f.startsWith(audioOnly ? "audio." : "media.") &&
            !f.endsWith(".json") &&
            !f.endsWith(".txt") &&
            !f.endsWith(".vtt"),
        );
        if (media) {
          const full = path.join(destDir, media);
          const ext = path.extname(media).toLowerCase();
          if (audioOnly || [".m4a", ".mp3", ".aac", ".opus", ".wav"].includes(ext)) {
            result.audioPath = full;
          } else {
            result.videoPath = full;
          }
        }
        // Also try extracting audio-only if we only got video
        if (result.videoPath && !result.audioPath) {
          const audioOut = path.join(destDir, "audio.m4a");
          try {
            await runCommand("yt-dlp", [
              "-f",
              "ba/b",
              "-x",
              "--audio-format",
              "m4a",
              "--no-playlist",
              "-o",
              audioOut,
              ref.pageUrl,
            ]);
            result.audioPath = audioOut;
          } catch {
            // ignore
          }
        }
        if (result.audioPath || result.videoPath) return result;
      } catch (err) {
        ytDlpError = err instanceof Error ? err.message : String(err);
        // 付费番剧：yt-dlp 会报登录/会员，此时不立刻失败，先试公开 playurl
        if (!isPgc && /login|cookie|premium|会员|付费/i.test(ytDlpError)) {
          throw new VideoMcpError(
            `Download blocked (login/VIP). Install cookies support later or use a public video. Detail: ${ytDlpError}`,
            "VIP_OR_LOGIN",
          );
        }
      }
    }

    // 番剧与课程：公开 playurl（未购买/大会员会抛 VIP_OR_LOGIN）
    if (isPgc) {
      try {
        const playurl = await fetchPgcPlayurl(ref);
        if (playurl.audioUrl) {
          const audioPath = path.join(destDir, "audio.m4s");
          await downloadBinary(playurl.audioUrl, audioPath);
          result.audioPath = audioPath;
        }
        if (playurl.videoUrl && (needVideo || (needAudio && !playurl.audioUrl))) {
          const videoPath = path.join(destDir, "video.m4s");
          await downloadBinary(playurl.videoUrl, videoPath);
          result.videoPath = videoPath;
        }
        return result;
      } catch (err) {
        if (err instanceof VideoMcpError) throw err;
        const reason = err instanceof Error ? err.message : String(err);
        throw new VideoMcpError(
          `Failed to download PGC media: ${reason}${ytDlpError ? ` (yt-dlp: ${ytDlpError.slice(-300)})` : ""}`,
          "DOWNLOAD_FAILED",
        );
      }
    }

    // Fallback: public playurl API (often needs more headers; may fail)
    if (!cid || !aid) {
      throw new VideoMcpError(
        "Missing aid/cid for playurl fetch. Re-run resolve_video.",
        "INTERNAL",
      );
    }

    const playUrl = `https://api.bilibili.com/x/player/playurl?avid=${aid}&cid=${cid}&fnval=16&fourk=1`;
    const play = await fetchJson<PlayUrlResponse>(playUrl);
    if (play.code !== 0 || !play.data) {
      const msg = play.message || `code ${play.code}`;
      if (/登录|login|会员|大会员/i.test(msg) || play.code === -101) {
        throw new VideoMcpError(
          `VIP or login required for media: ${msg}. Tip: install yt-dlp on PATH for better public downloads.`,
          "VIP_OR_LOGIN",
        );
      }
      throw new VideoMcpError(
        `Playurl failed: ${msg}. Install yt-dlp on PATH and retry.`,
        "DOWNLOAD_FAILED",
      );
    }

    const audioUrl =
      play.data.dash?.audio?.[0]?.baseUrl ||
      play.data.dash?.audio?.[0]?.base_url;
    const videoUrl =
      play.data.dash?.video?.[0]?.baseUrl ||
      play.data.dash?.video?.[0]?.base_url ||
      play.data.durl?.[0]?.url;

    if (audioUrl) {
      const audioPath = path.join(destDir, "audio.m4s");
      await downloadBinary(audioUrl, audioPath);
      result.audioPath = audioPath;
    }
    // 仅转写时如果没有独立音轨，才下载可能含音频的视频流。
    if (videoUrl && (needVideo || (needAudio && !audioUrl))) {
      const videoPath = path.join(destDir, "video.m4s");
      await downloadBinary(videoUrl, videoPath);
      result.videoPath = videoPath;
    }

    if (!result.audioPath && !result.videoPath && !result.subtitleText) {
      throw new VideoMcpError(
        "No media or subtitles available. Install yt-dlp or try a video with public CC subtitles.",
        "DOWNLOAD_FAILED",
      );
    }

    return result;
  }
}

async function downloadBinary(url: string, dest: string): Promise<void> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": bilibiliUserAgent(),
      Referer: "https://www.bilibili.com/",
    },
  });
  if (!res.ok) {
    throw new VideoMcpError(
      `Failed to download media (${res.status})`,
      "DOWNLOAD_FAILED",
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
}

/** Convert Bilibili BCC JSON (or plain text) to readable transcript */
export function subtitleJsonToText(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      body?: Array<{ from?: number; to?: number; content?: string }>;
    };
    if (Array.isArray(parsed.body)) {
      return parsed.body
        .map((line) => (line.content ?? "").trim())
        .filter(Boolean)
        .join("\n");
    }
  } catch {
    // not JSON
  }
  return body;
}
