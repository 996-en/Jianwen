/**
 * B 站番剧（/bangumi/play/ep|ss|md）与课程（/cheese/play/ep|ss）。
 *
 * 两者共用「season 信息 + 单集播放地址」这一套结构：
 * - 元数据来自 pgc/view/web/season（番剧）或 pugv/view/web/season（课程）；
 * - 播放地址来自 pgc/player/web/playurl（番剧，结果在 result 里）
 *   或 pugv/player/web/playurl（课程，结果在 data 里）。
 * 未购买/未登录的付费内容会返回 -403，这里统一翻译成 VIP_OR_LOGIN。
 */

import { VideoMcpError, type VideoRef, type VideoStats } from "../types.js";
import type { BiliLink } from "./bilibili-parse.js";
import {
  biliErrorMessage,
  biliGetJson,
  biliHeaders,
  isLoginOrVipMessage,
  isRateLimit,
} from "./bilibili-api.js";

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function unixToIso(value: unknown): string | undefined {
  const seconds = asNumber(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

/**
 * 时长单位不统一：番剧接口给毫秒（如 1494000），课程接口给秒（如 759）。
 * 超过 10 万的值按毫秒处理，避免把 24 分钟算成 40 小时。
 */
function toDurationSec(value: unknown): number {
  const raw = asNumber(value);
  if (raw === undefined || raw <= 0) return 0;
  return raw > 100_000 ? Math.round(raw / 1000) : Math.round(raw);
}

/** 拼标题：季名 + 集标题；没有集标题就只留季名 */
function joinTitle(seasonTitle: string, episodeTitle?: string, longTitle?: string): string {
  const parts = [seasonTitle.trim()];
  const extra = (longTitle ?? "").trim() || (episodeTitle ?? "").trim();
  if (extra && extra !== seasonTitle.trim() && !/^\d+$/.test(extra)) parts.push(extra);
  return parts.filter(Boolean).join(" · ");
}

/* ------------------------------------------------------------------ 番剧 */

interface BangumiEpisode {
  epId: number;
  aid?: number;
  bvid?: string;
  cid?: number;
  title?: string;
  longTitle?: string;
  durationSec: number;
  cover?: string;
  publishedAt?: string;
  /** 接口给的角标，如「会员」；带会员角标的集数公开 playurl 只给 180 秒试看 */
  badge?: string;
}

interface BangumiSeason {
  seasonId?: number;
  title: string;
  cover?: string;
  author: string;
  stats?: VideoStats;
  episodes: BangumiEpisode[];
  /** 总话数（含尚未开播的集），用于 episodes 为空时给出准确提示 */
  total?: number;
}

/** `/bangumi/play/md<id>` 是媒体页，跟着跳转拿到真正的 ep/ss 链接 */
async function followRedirect(url: string): Promise<string> {
  const res = await fetch(url, { headers: biliHeaders(), redirect: "follow" });
  await res.body?.cancel();
  return res.url;
}

function parseSeason(payload: unknown): BangumiSeason | null {
  const result = asRecord(asRecord(payload)?.result);
  if (!result) return null;

  const upInfo = asRecord(result.up_info);
  const stat = asRecord(result.stat);
  const episodes: BangumiEpisode[] = asArray(result.episodes).map((raw) => {
    const ep = asRecord(raw) ?? {};
    return {
      epId: asNumber(ep.id) ?? 0,
      aid: asNumber(ep.aid),
      bvid: asString(ep.bvid),
      cid: asNumber(ep.cid),
      title: asString(ep.title),
      longTitle: asString(ep.long_title),
      durationSec: toDurationSec(ep.duration),
      cover: asString(ep.cover),
      publishedAt: unixToIso(ep.pub_time),
      badge: asString(asRecord(ep.badge_info)?.text) ?? asString(ep.badge),
    };
  });

  return {
    seasonId: asNumber(result.season_id),
    title: asString(result.season_title) ?? asString(result.title) ?? "B站番剧",
    cover: asString(result.cover),
    author: asString(upInfo?.uname) ?? "哔哩哔哩番剧",
    total: asNumber(result.total),
    stats: stat
      ? {
          views: asNumber(stat.views),
          favorites: asNumber(stat.favorites),
          likes: asNumber(stat.likes),
          coins: asNumber(stat.coins),
          comments: asNumber(stat.replies),
          shares: asNumber(stat.share),
          danmaku: asNumber(stat.danmakus),
        }
      : undefined,
    episodes,
  };
}

async function fetchSeason(params: { epId?: string; seasonId?: string }): Promise<BangumiSeason> {
  const query = params.epId
    ? `ep_id=${encodeURIComponent(params.epId)}`
    : `season_id=${encodeURIComponent(params.seasonId ?? "")}`;
  const json = await biliGetJson<{ code?: number; message?: string; result?: unknown }>(
    `https://api.bilibili.com/pgc/view/web/season?${query}`,
  );
  if (json.code !== 0) {
    const message = biliErrorMessage(json, `code ${json.code ?? "unknown"}`);
    if (isRateLimit(json.code, message)) {
      throw new VideoMcpError(`B 站限流（${json.code}：${message}），请等几十秒后重试`, "DOWNLOAD_FAILED");
    }
    if (json.code === -10403 || json.code === -403 || isLoginOrVipMessage(message)) {
      throw new VideoMcpError(`番剧信息需要登录或地区受限：${message}`, "VIP_OR_LOGIN");
    }
    throw new VideoMcpError(`获取番剧信息失败：${message}`, "DOWNLOAD_FAILED");
  }
  const season = parseSeason(json);
  if (!season) {
    throw new VideoMcpError("番剧信息为空，可能已下架或地区受限", "NOT_FOUND");
  }
  if (!season.episodes.length) {
    // 未开播/仅预告的季里 episodes 是空数组，正片在 section 里也只有 PV，不能当成正片解析
    throw new VideoMcpError(
      `《${season.title}》暂无正片可解析${season.total ? `（共 ${season.total} 话，可能尚未开播）` : ""}`,
      "NOT_FOUND",
    );
  }
  return season;
}

export async function resolveBangumiRef(link: BiliLink): Promise<VideoRef> {
  let seasonType = link.seasonType ?? "ep";
  let id = link.id;

  if (seasonType === "md") {
    const finalUrl = await followRedirect(`https://www.bilibili.com/bangumi/play/md${id}`);
    const rest = /\/bangumi\/play\/(ep|ss)(\d+)/i.exec(finalUrl);
    if (!rest) {
      throw new VideoMcpError(
        `番剧媒体页 md${id} 跳转后没有拿到 ep/ss 号（${finalUrl}），请改用剧集链接`,
        "UNSUPPORTED_URL",
      );
    }
    seasonType = rest[1]!.toLowerCase() as "ep" | "ss";
    id = rest[2]!;
  }

  const season = await fetchSeason(
    seasonType === "ep" ? { epId: id } : { seasonId: id },
  );
  const episode =
    (seasonType === "ep" ? season.episodes.find((ep) => String(ep.epId) === id) : undefined) ??
    season.episodes[0]!;

  return {
    platform: "bilibili",
    id: episode.bvid ?? `ep${episode.epId}`,
    title: joinTitle(season.title, episode.title, episode.longTitle),
    durationSec: episode.durationSec,
    author: season.author,
    publishedAt: episode.publishedAt,
    stats: season.stats,
    pageUrl: `https://www.bilibili.com/bangumi/play/ep${episode.epId}`,
    extras: {
      kind: "bangumi",
      epId: episode.epId,
      seasonId: season.seasonId ?? null,
      aid: episode.aid ?? null,
      cid: episode.cid ?? null,
      bvid: episode.bvid ?? null,
      badge: episode.badge ?? null,
    },
  };
}

/* ------------------------------------------------------------------ 课程 */

export async function resolveCheeseRef(link: BiliLink): Promise<VideoRef> {
  const seasonType = link.seasonType ?? "ep";
  const query =
    seasonType === "ep"
      ? `ep_id=${encodeURIComponent(link.id)}`
      : `season_id=${encodeURIComponent(link.id)}`;
  const json = await biliGetJson<{ code?: number; message?: string; data?: unknown }>(
    `https://api.bilibili.com/pugv/view/web/season?${query}`,
  );
  if (json.code !== 0) {
    const message = biliErrorMessage(json, `code ${json.code ?? "unknown"}`);
    if (isRateLimit(json.code, message)) {
      throw new VideoMcpError(`B 站限流（${json.code}：${message}），请等几十秒后重试`, "DOWNLOAD_FAILED");
    }
    throw new VideoMcpError(`获取课程信息失败：${message}`, "DOWNLOAD_FAILED");
  }

  const data = asRecord(json.data);
  const upInfo = asRecord(data?.up_info);
  const episodes = asArray(data?.episodes).map((raw) => {
    const ep = asRecord(raw) ?? {};
    return {
      epId: asNumber(ep.id) ?? 0,
      aid: asNumber(ep.aid),
      cid: asNumber(ep.cid),
      title: asString(ep.title) ?? asString(ep.subtitle),
      durationSec: toDurationSec(ep.duration),
      cover: asString(ep.cover),
      publishedAt: unixToIso(ep.release_date),
      index: asNumber(ep.index),
      // 未购买的课程会带 "playable": false，公开 playurl 直接返回 -403
      playable: ep.playable === false ? false : true,
    };
  });
  if (!episodes.length) {
    throw new VideoMcpError("课程没有可解析的课时", "NOT_FOUND");
  }

  const episode =
    (seasonType === "ep" ? episodes.find((ep) => String(ep.epId) === link.id) : undefined) ??
    episodes[0]!;
  const courseTitle = asString(data?.title) ?? "B站课程";
  const episodeLabel = episode.index ? `第${episode.index}课` : "";

  return {
    platform: "bilibili",
    id: `ep${episode.epId}`,
    title: [courseTitle, episodeLabel, episode.title].filter(Boolean).join(" · "),
    durationSec: episode.durationSec,
    author: asString(upInfo?.uname) ?? "B站课程",
    authorId: asNumber(upInfo?.mid),
    publishedAt: episode.publishedAt,
    pageUrl: `https://www.bilibili.com/cheese/play/ep${episode.epId}`,
    extras: {
      kind: "cheese",
      epId: episode.epId,
      aid: episode.aid ?? null,
      cid: episode.cid ?? null,
      playable: episode.playable,
    },
  };
}

/* -------------------------------------------------------------- 播放地址 */

export interface PgcPlayurl {
  audioUrl?: string;
  videoUrl?: string;
}

/** 会员角标/未购标记：在下载前就先失败，避免把 180 秒试看当成正片 */
export function assertPgcWatchable(ref: VideoRef): void {
  const extras = (ref.extras ?? {}) as Record<string, unknown>;
  const badge = typeof extras.badge === "string" ? extras.badge : "";
  if (/会员|付费/.test(badge)) {
    throw new VideoMcpError(
      `该集带「${badge}」角标，B 站公开接口只提供 180 秒试看，无法完整获取`,
      "VIP_OR_LOGIN",
    );
  }
  if (extras.playable === false) {
    throw new VideoMcpError("该课程课时需要购买后才能观看", "VIP_OR_LOGIN");
  }
}

function pickDash(data: Json | undefined): PgcPlayurl {
  const dash = asRecord(data?.dash);
  const audio = asRecord(asArray(dash?.audio)[0]);
  const video = asRecord(asArray(dash?.video)[0]);
  const durl = asRecord(asArray(data?.durl)[0]);
  return {
    audioUrl: asString(audio?.baseUrl) ?? asString(audio?.base_url),
    videoUrl:
      asString(video?.baseUrl) ??
      asString(video?.base_url) ??
      asString(durl?.url),
  };
}

/** 取番剧/课程的公开播放地址（未购买内容会报 VIP_OR_LOGIN） */
export async function fetchPgcPlayurl(ref: VideoRef): Promise<PgcPlayurl> {
  const extras = (ref.extras ?? {}) as Record<string, unknown>;
  const epId = asNumber(extras.epId);
  if (!epId) throw new VideoMcpError("缺少 epId，无法获取播放地址", "INTERNAL");

  const kind = extras.kind === "cheese" ? "cheese" : "bangumi";
  const url =
    kind === "cheese"
      ? `https://api.bilibili.com/pugv/player/web/playurl?ep_id=${epId}&fnval=16`
      : `https://api.bilibili.com/pgc/player/web/playurl?ep_id=${epId}&fnval=16&fourk=1`;

  const json = await biliGetJson<{ code?: number; message?: string; result?: unknown; data?: unknown }>(
    url,
  );
  if (json.code !== 0) {
    const message = biliErrorMessage(json, `code ${json.code ?? "unknown"}`);
    if (isRateLimit(json.code, message)) {
      throw new VideoMcpError(`B 站限流（${json.code}：${message}），请等几十秒后重试`, "DOWNLOAD_FAILED");
    }
    if (json.code === -403 || json.code === -10403 || isLoginOrVipMessage(message)) {
      throw new VideoMcpError(
        `该${kind === "cheese" ? "课程" : "番剧"}需要购买/大会员或登录：${message}`,
        "VIP_OR_LOGIN",
      );
    }
    throw new VideoMcpError(`获取播放地址失败：${message}`, "DOWNLOAD_FAILED");
  }

  const container = asRecord(json.result) ?? asRecord(json.data);
  const playurl = pickDash(container);
  if (!playurl.audioUrl && !playurl.videoUrl) {
    throw new VideoMcpError(
      "播放地址为空（可能需要购买/大会员，或该内容限制了清晰度）",
      "VIP_OR_LOGIN",
    );
  }

  // 付费集数不会报错，而是回一个 180 秒的试看片段：没有 dash 且 durl 明显短于正片
  const dashVideo = asArray(asRecord(container?.dash)?.video).length;
  const durlMs = asNumber(asRecord(asArray(container?.durl)[0])?.length);
  const fullMs = ref.durationSec * 1000;
  if (!dashVideo && durlMs && fullMs > 0 && durlMs + 30_000 < fullMs) {
    throw new VideoMcpError(
      `只拿到试看片段（${Math.round(durlMs / 1000)} 秒 / 全长 ${ref.durationSec} 秒），需要大会员或购买`,
      "VIP_OR_LOGIN",
    );
  }
  return playurl;
}
