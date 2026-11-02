import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_DOUYIN_COOKIE_FILE,
  douyinCookieFile,
  douyinCookiesRaw,
  douyinFastAudio,
  douyinUserAgent,
} from "../config.js";
import { VideoMcpError, type FetchAssetsOptions, type VideoRef } from "../types.js";
import { buildDetailQuery, decodeComponent, detailParams } from "./douyin-sign.js";
import type { MediaFetchResult, PlatformAdapter } from "./types.js";

/** 详情接口地址；query 签名与网页端参数见 `douyin-sign.ts` */
const DETAIL_ENDPOINT = "https://www.douyin.com/aweme/v1/web/aweme/detail/";

const SHORT_LINK_RE = /(?:https?:\/\/)?v\.douyin\.com\/([A-Za-z0-9_-]+)/i;
const VIDEO_URL_RE =
  /(?:https?:\/\/)?(?:[\w-]+\.)?(?:ies)?douyin\.com\/(?:share\/)?video\/(\d{15,25})/i;
const NOTE_URL_RE =
  /(?:https?:\/\/)?(?:[\w-]+\.)?(?:ies)?douyin\.com\/(?:share\/)?note\/(\d{15,25})/i;
/** 裸 aweme_id 只接受 19 位数字，避免与 B 站纯数字 aid 混淆 */
const BARE_ID_RE = /^\d{19}$/;

export function extractAwemeId(input: string): string | null {
  const s = input.trim();
  const url = s.match(VIDEO_URL_RE);
  if (url) return url[1]!;
  const note = s.match(NOTE_URL_RE);
  if (note) return note[1]!;
  if (BARE_ID_RE.test(s)) return s;
  return null;
}

export function isDouyinInput(input: string): boolean {
  const s = input.trim();
  if (!s) return false;
  if (SHORT_LINK_RE.test(s)) return true;
  if (VIDEO_URL_RE.test(s)) return true;
  if (NOTE_URL_RE.test(s)) return true;
  if (BARE_ID_RE.test(s)) return true;
  return false;
}

export interface DouyinCookie {
  name: string;
  value: string;
}

/** 解析浏览器导出的 Netscape cookies.txt；只保留抖音相关域，避免把无关 Cookie 发出去 */
export function parseCookieFile(text: string): DouyinCookie[] {
  const out: DouyinCookie[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#HttpOnly_")) line = line.slice("#HttpOnly_".length);
    else if (line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    const domain = parts[0] ?? "";
    if (!/douyin|bytedance|amemv|snssdk|ixigua/i.test(domain)) continue;
    const name = parts[5] ?? "";
    const value = parts.slice(6).join("\t");
    if (name) out.push({ name, value });
  }
  return out;
}

export interface DouyinSession {
  cookieHeader: string;
  uifid: string;
}

function pickUifid(cookies: DouyinCookie[]): string | undefined {
  const upper = cookies.find((c) => c.name.toUpperCase() === "UIFID");
  const temp = cookies.find((c) => c.name.toUpperCase() === "UIFID_TEMP");
  const hit = upper ?? temp;
  if (!hit) return undefined;
  const decoded = decodeComponent(hit.value);
  return decoded || undefined;
}

/**
 * 读取抖音访客身份。详情接口要求 Cookie 成套签发（UIFID 与 ttwid 等必须来自同一浏览器会话），
 * 因此这里不做任何拼接或伪造，缺 Cookie 时直接报错让用户提供。
 */
export async function douyinSession(): Promise<DouyinSession> {
  const raw = douyinCookiesRaw();
  if (raw) {
    const cookies: DouyinCookie[] = raw
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf("=");
        return eq === -1
          ? { name: part, value: "" }
          : { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() };
      });
    const uifid = pickUifid(cookies);
    if (!uifid) {
      throw new VideoMcpError(
        "VIDEO_MCP_DOUYIN_COOKIES 中缺少 UIFID。抖音详情接口需要浏览器签发的访客身份，请从浏览器复制完整 Cookie（含 UIFID、ttwid）。",
        "COOKIE_REQUIRED",
      );
    }
    return { cookieHeader: raw, uifid };
  }

  const file = douyinCookieFile();
  if (!file) {
    throw new VideoMcpError(
      `抖音需要浏览器访客 Cookie。最快的修法是在项目目录执行 \`npm run douyin:cookies\` 生成默认文件 ${DEFAULT_DOUYIN_COOKIE_FILE}；也可以手动设置 VIDEO_MCP_DOUYIN_COOKIE_FILE（Netscape cookies.txt 路径）或 VIDEO_MCP_DOUYIN_COOKIES（Cookie 头原文），再用与浏览器一致的 UA 重试。详见 README「抖音平台」一节。`,
      "COOKIE_REQUIRED",
    );
  }

  let text: string;
  try {
    text = await fs.readFile(path.resolve(file), "utf8");
  } catch (err) {
    throw new VideoMcpError(
      `无法读取 Cookie 文件 ${file}: ${err instanceof Error ? err.message : String(err)}`,
      "COOKIE_REQUIRED",
    );
  }
  const cookies = parseCookieFile(text);
  const uifid = pickUifid(cookies);
  if (!uifid) {
    throw new VideoMcpError(
      `Cookie 文件 ${file} 中没有抖音的 UIFID。请确认导出的是 douyin.com、且包含 UIFID 与 ttwid。`,
      "COOKIE_REQUIRED",
    );
  }
  return {
    cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    uifid,
  };
}

/** 远程流式抽音轨用的一次性 ffmpeg 调用；失败交给调用方回落到整片下载 */
function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { shell: false });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
    });
  });
}

interface DouyinUrlList {
  url_list?: string[];
}

interface DouyinVideo {
  duration?: number;
  play_addr?: DouyinUrlList;
  play_addr_h264?: DouyinUrlList;
  play_addr_265?: DouyinUrlList;
  download_addr?: DouyinUrlList;
}

interface DouyinAweme {
  aweme_id?: string;
  desc?: string;
  create_time?: number;
  aweme_type?: number;
  author?: { nickname?: string; sec_uid?: string; uid?: string; unique_id?: string };
  statistics?: {
    play_count?: number;
    digg_count?: number;
    comment_count?: number;
    share_count?: number;
    collect_count?: number;
  };
  video?: DouyinVideo;
  images?: unknown[];
}

interface DouyinDetailResponse {
  status_code?: number;
  status_msg?: string;
  aweme_detail?: DouyinAweme | null;
}

async function fetchAwemeDetail(awemeId: string): Promise<DouyinAweme> {
  const session = await douyinSession();
  const query = buildDetailQuery(detailParams(awemeId), session.uifid);
  const res = await fetch(`${DETAIL_ENDPOINT}?${query}`, {
    headers: {
      "User-Agent": douyinUserAgent(),
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      Referer: `https://www.douyin.com/video/${awemeId}`,
      Cookie: session.cookieHeader,
    },
    redirect: "follow",
  });

  const body = await res.text();

  if (res.status === 403) {
    const hint = /uifid/i.test(body)
      ? "访客 UIFID 无效或缺失"
      : "请求被拒绝";
    throw new VideoMcpError(
      `抖音详情接口 HTTP 403（${hint}）：${body.slice(0, 200)}。请用同一浏览器重新导出完整 Cookie（含 UIFID、ttwid），不要自行拼接或伪造 UIFID。`,
      "COOKIE_REQUIRED",
    );
  }
  if (!res.ok) {
    throw new VideoMcpError(
      `抖音详情接口 HTTP ${res.status}: ${body.slice(0, 200)}`,
      "DOWNLOAD_FAILED",
    );
  }
  if (!body.trim()) {
    throw new VideoMcpError(
      "抖音返回空响应：通常是被风控拦截（Cookie 过期或 UA 与浏览器不一致），也可能是作品已删除/仅自己可见。请刷新浏览器 Cookie 后重试。",
      "DOWNLOAD_FAILED",
    );
  }

  let json: DouyinDetailResponse;
  try {
    json = JSON.parse(body) as DouyinDetailResponse;
  } catch {
    throw new VideoMcpError(
      `抖音返回非 JSON 内容（前 200 字符）：${body.slice(0, 200)}`,
      "DOWNLOAD_FAILED",
    );
  }

  if (json.status_code !== 0) {
    throw new VideoMcpError(
      `抖音详情接口失败：status_code=${json.status_code ?? "unknown"} ${json.status_msg ?? ""}`.trim(),
      "DOWNLOAD_FAILED",
    );
  }
  const aweme = json.aweme_detail;
  if (!aweme) {
    throw new VideoMcpError(
      "抖音未返回作品详情，作品可能已删除、仅自己可见或受地区限制。",
      "NOT_FOUND",
    );
  }
  return aweme;
}

/** 抖音短链需要跟随 302 才能拿到 aweme_id；分享文本里只有短链，没有作品 ID */
async function resolveShortLink(input: string): Promise<string> {
  const m = input.match(SHORT_LINK_RE);
  if (!m) throw new VideoMcpError(`无法从输入中提取抖音短链：${input}`, "UNSUPPORTED_URL");
  const url = `https://v.douyin.com/${m[1]}/`;
  const res = await fetch(url, {
    method: "GET",
    redirect: "manual",
    headers: { "User-Agent": douyinUserAgent() },
  });
  const location = res.headers.get("location") ?? "";
  const hit = location.match(/\/(?:share\/)?(?:video|note)\/(\d{15,25})/);
  if (hit) return hit[1]!;
  // 有些网络环境下 redirect: manual 拿不到 Location，退回跟随重定向后解析最终 URL。
  const followed = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { "User-Agent": douyinUserAgent() },
  });
  const hit2 = followed.url.match(/\/(?:share\/)?(?:video|note)\/(\d{15,25})/);
  if (hit2) return hit2[1]!;
  throw new VideoMcpError(
    `抖音短链解析失败（HTTP ${res.status}）：${url}`,
    "UNSUPPORTED_URL",
  );
}

function collectUrls(...lists: Array<DouyinUrlList | undefined>): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const u of list?.url_list ?? []) {
      if (typeof u === "string" && /^https?:\/\//.test(u) && !out.includes(u)) out.push(u);
    }
  }
  return out;
}

/**
 * 只有顶层 play_addr 是 h264 + aac 的完整 mp4；bit_rate[*].play_addr 多是纯视频 DASH 流（无音轨），
 * 拿来下载会导致 ASR 没有声音，因此这里不使用 bit_rate 档位。
 */
function videoCandidates(aweme: DouyinAweme): string[] {
  const v = aweme.video;
  if (!v) return [];
  return collectUrls(
    v.play_addr,
    v.play_addr_h264,
    v.download_addr,
    v.play_addr_265,
  );
}

export class DouyinAdapter implements PlatformAdapter {
  readonly platform = "douyin";

  canHandle(input: string): boolean {
    return isDouyinInput(input);
  }

  async resolve(input: string): Promise<VideoRef> {
    const s = input.trim();
    let awemeId = extractAwemeId(s);
    if (!awemeId && SHORT_LINK_RE.test(s)) {
      awemeId = await resolveShortLink(s);
    }
    if (!awemeId) {
      throw new VideoMcpError(
        `无法从输入中解析抖音作品 ID：${input}`,
        "UNSUPPORTED_URL",
      );
    }

    const aweme = await fetchAwemeDetail(awemeId);
    if (!aweme.video && Array.isArray(aweme.images) && aweme.images.length > 0) {
      throw new VideoMcpError(
        "这是抖音图文作品，当前版本只处理视频作品。",
        "UNSUPPORTED_URL",
      );
    }

    const id = aweme.aweme_id ?? awemeId;
    const durationMs = aweme.video?.duration ?? 0;
    const secUid = aweme.author?.sec_uid;
    const stats = aweme.statistics;

    return {
      platform: "douyin",
      id,
      title: aweme.desc?.trim() || `抖音作品 ${id}`,
      durationSec: durationMs > 0 ? Math.round(durationMs / 1000) : 0,
      author: aweme.author?.nickname ?? "unknown",
      authorId: undefined,
      publishedAt:
        typeof aweme.create_time === "number" && aweme.create_time > 0
          ? new Date(aweme.create_time * 1000).toISOString()
          : undefined,
      stats: stats
        ? {
            // 网页端详情接口通常不返回真实播放量（play_count 为 0），避免把 0 当成真实数据。
            views: stats.play_count && stats.play_count > 0 ? stats.play_count : undefined,
            likes: stats.digg_count,
            comments: stats.comment_count,
            shares: stats.share_count,
            favorites: stats.collect_count,
          }
        : undefined,
      pageUrl: `https://www.douyin.com/video/${id}`,
      extras: {
        awemeId: id,
        authorSecUid: secUid ?? null,
      },
    };
  }

  async fetchMedia(
    ref: VideoRef,
    destDir: string,
    options?: FetchAssetsOptions,
  ): Promise<MediaFetchResult> {
    await fs.mkdir(destDir, { recursive: true });
    const result: MediaFetchResult = {};

    // 抖音网页端不提供字幕轨道，也没有 B 站式故事板：字幕只能靠 ASR，画面只能靠 ffmpeg 抽帧。
    const wantFrames = options?.wantKeyframes === true;
    const wantAudio = options?.wantAsr === true;
    if (!wantFrames && !wantAudio) return result;

    const awemeId = String(ref.extras?.awemeId ?? ref.id);
    const aweme = await fetchAwemeDetail(awemeId);
    const candidates = videoCandidates(aweme);
    if (!candidates.length) {
      throw new VideoMcpError(
        "该抖音作品没有可下载的视频地址（可能是图文作品或已下架）。",
        "DOWNLOAD_FAILED",
      );
    }

    const session = await douyinSession();
    const headers = {
      "User-Agent": douyinUserAgent(),
      Referer: `https://www.douyin.com/video/${awemeId}`,
      Cookie: session.cookieHeader,
    };

    // 只要文字、不要画面时，若开了 fast-audio 就让 ffmpeg 直读 CDN 地址抽音轨：
    // 抖音 CDN 支持 Range 且 moov 在文件头，实测 667 秒视频只需下载音轨那部分，
    // 省掉整片 mp4 的流量与落盘（并顺带省掉一次 16 kHz 转码）。
    // 任何一步失败（ffmpeg 缺失、CDN 拒 Range、签名过期）都静默回落到下面的整片下载。
    if (!wantFrames && wantAudio && douyinFastAudio()) {
      const wav = path.join(destDir, "audio_16k.wav");
      const timeoutMs = Math.max(120_000, (ref.durationSec || 0) * 2000);
      for (const url of candidates) {
        try {
          await runFfmpeg(
            [
              "-y",
              "-nostdin",
              "-loglevel", "error",
              "-headers", `Referer: ${headers.Referer}\r\n`,
              "-user_agent", headers["User-Agent"],
              "-i", url,
              "-vn",
              "-acodec", "pcm_s16le",
              "-ar", "16000",
              "-ac", "1",
              wav,
            ],
            timeoutMs,
          );
          const stat = await fs.stat(wav);
          if (stat.size > 1024) {
            result.audioPath = wav;
            result.audioReady = true;
            return result;
          }
        } catch {
          // 落到下面的整片下载
        }
      }
    }

    const dest = path.join(destDir, "media.mp4");
    let lastError = "";
    for (const url of candidates) {
      try {
        const res = await fetch(url, { headers, redirect: "follow" });
        if (!res.ok) {
          lastError = `HTTP ${res.status}`;
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength === 0) {
          lastError = "空文件";
          continue;
        }
        await fs.writeFile(dest, buf);
        result.videoPath = dest;
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    throw new VideoMcpError(
      `抖音视频下载失败：${lastError || "所有候选地址均不可用"}。Cookie 可能已过期。`,
      "DOWNLOAD_FAILED",
    );
  }
}
