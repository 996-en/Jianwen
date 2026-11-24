import { Xhshow } from "@ikenxuan/xhshow-ts";
import type { XhsSession } from "./xiaohongshu-cookie.js";

const EDITH_ORIGIN = "https://edith.xiaohongshu.com";
const FEED_PATH = "/api/sns/web/v1/feed";
const SHORT_URL_PATH = "/api/sns/web/short_url";
const signer = new Xhshow();

function edithPostHeaders(
  path: string,
  body: Record<string, unknown>,
  session: XhsSession,
  referer: string,
): Record<string, string> {
  const cookies = { a1: session.a1, web_session: session.webSession };
  const signHeaders = signer.signHeadersPost(
    path,
    cookies,
    "xhs-pc-web",
    body,
    undefined,
    undefined,
    "xys",
    undefined,
    true,
  );
  return {
    "Content-Type": "application/json;charset=UTF-8",
    Accept: "application/json, text/plain, */*",
    Origin: "https://www.xiaohongshu.com",
    Referer: referer,
    "User-Agent": session.userAgent,
    Cookie: session.cookieHeader,
    ...signHeaders,
  };
}

async function edithPost(path: string, body: Record<string, unknown>, session: XhsSession, referer: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${EDITH_ORIGIN}${path}`, {
    method: "POST",
    headers: edithPostHeaders(path, body, session, referer),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  if (json.success === false && json.code !== 0 && json.code !== "0") {
    throw new Error(String(json.msg ?? json.message ?? `${path} failed`));
  }
  return json;
}

const XHSLINK_IN_TEXT =
  /(?:https?:\/\/)?(?:www\.)?xhslink\.(?:com|cn)\/[A-Za-z0-9/_-]+/i;

/** 平台有时返回不带协议的 xhslink.com/o/... */
export function normalizeXhsShareShortUrl(raw: string): string {
  const trimmed = raw.trim();
  const m = trimmed.match(XHSLINK_IN_TEXT);
  const hostPath = m?.[0] ?? trimmed;
  if (/^https?:\/\//i.test(hostPath)) return hostPath;
  return `https://${hostPath.replace(/^www\./i, "")}`;
}

/** 从 signed 分享接口解析 xhslink（MediaCrawler /api/sns/web/short_url）。 */
export function pickXhsShareShortUrl(json: Record<string, unknown>): string | undefined {
  const scan = (node: unknown, depth = 0): string | undefined => {
    if (depth > 4 || node == null) return;
    if (typeof node === "string") {
      const m = node.match(XHSLINK_IN_TEXT);
      if (m) return normalizeXhsShareShortUrl(m[0]);
    }
    if (typeof node !== "object") return;
    for (const value of Object.values(node as Record<string, unknown>)) {
      const hit = scan(value, depth + 1);
      if (hit) return hit;
    }
    return;
  };
  return scan(json.data ?? json);
}

const SEARCH_PATH = "/api/sns/web/v1/search/notes";

export type SearchTokenHit = { token: string; xsecSource: string };

export async function findNoteXsecTokenViaSearch(
  noteId: string,
  keywords: string[],
  session: XhsSession,
): Promise<SearchTokenHit | null> {
  const uniq = [...new Set(keywords.map((k) => k.trim()).filter((k) => k.length >= 2 && k !== noteId))];
  if (!uniq.length) return null;

  for (const keyword of uniq) {
    for (let page = 1; page <= 3; page += 1) {
      const body = {
        keyword,
        page,
        page_size: 40,
        search_id: signer.getSearchId(),
        sort: "general",
        note_type: 0,
      };
      try {
        const json = await edithPost(SEARCH_PATH, body, session, `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`);
        const items = (json.data as Record<string, unknown> | undefined)?.items as Array<Record<string, unknown>> | undefined;
        if (!items?.length) break;
        for (const item of items) {
          const id = (item.id ?? (item.note_card as Record<string, unknown> | undefined)?.note_id) as string | undefined;
          if (id !== noteId) continue;
          const token = (item.xsec_token ?? (item.note_card as Record<string, unknown> | undefined)?.xsec_token) as string | undefined;
          if (!token) continue;
          return { token, xsecSource: "pc_search" };
        }
      } catch {
        break;
      }
    }
  }
  return null;
}

export async function mintNoteShortUrl(noteId: string, session: XhsSession): Promise<string> {
  const referer = `https://www.xiaohongshu.com/explore/${noteId}`;
  const json = await edithPost(
    SHORT_URL_PATH,
    { original_url: `https://www.xiaohongshu.com/discovery/item/${noteId}` },
    session,
    referer,
  );
  const short = pickXhsShareShortUrl(json);
  if (!short) throw new Error("short_url empty");
  return short;
}

export type FeedNote = {
  noteId?: string;
  type?: string;
  title?: string;
  desc?: string;
  time?: number;
  user?: { nickname?: string };
  interactInfo?: unknown;
  imageList?: Array<{ urlDefault?: string; urlPre?: string; infoList?: Array<{ url?: string }> }>;
  video?: { media?: { video?: { duration?: number }; stream?: Record<string, Array<{ masterUrl?: string; backupUrls?: string[]; audioCodec?: string }>> } };
};

type FeedBody = {
  source_note_id: string;
  image_formats: string[];
  extra: { need_body_topic: number };
  xsec_source: string;
  xsec_token: string;
};

function mapNoteCard(card: Record<string, unknown>, id: string): FeedNote {
  const streams: Record<string, Array<{ masterUrl?: string; backupUrls?: string[]; audioCodec?: string }>> = {};
  const video = card.video as {
    media?: { video?: { duration?: number }; stream?: Record<string, Array<Record<string, unknown>>> };
  } | undefined;
  if (video?.media?.stream) {
    for (const [codec, list] of Object.entries(video.media.stream)) {
      streams[codec] = list.map((s) => ({
        masterUrl: (s.master_url ?? s.masterUrl) as string | undefined,
        backupUrls: (s.backup_urls ?? s.backupUrls) as string[] | undefined,
        audioCodec: (s.audio_codec ?? s.audioCodec) as string | undefined,
      }));
    }
  }
  const imageList = (card.image_list as Array<Record<string, unknown>> | undefined)?.map((img) => ({
    urlDefault: (img.url_default ?? img.urlDefault) as string | undefined,
    urlPre: (img.url_pre ?? img.urlPre) as string | undefined,
    infoList: img.info_list as Array<{ url?: string }> | undefined,
  }));
  return {
    noteId: (card.note_id ?? card.noteId ?? id) as string,
    type: card.type as string | undefined,
    title: card.title as string | undefined,
    desc: card.desc as string | undefined,
    time: card.time as number | undefined,
    user: card.user as { nickname?: string } | undefined,
    interactInfo: card.interact_info ?? card.interactInfo,
    imageList,
    video: video ? { media: { video: video.media?.video, stream: streams } } : undefined,
  };
}

export async function fetchNoteViaFeed(
  noteId: string,
  xsecToken: string,
  xsecSource: string,
  session: XhsSession,
): Promise<FeedNote> {
  const body: FeedBody = {
    source_note_id: noteId,
    image_formats: ["jpg", "webp", "avif"],
    extra: { need_body_topic: 1 },
    xsec_source: xsecSource,
    xsec_token: xsecToken,
  };
  const res = await fetch(`${EDITH_ORIGIN}${FEED_PATH}`, {
    method: "POST",
    headers: edithPostHeaders(FEED_PATH, body as Record<string, unknown>, session, `https://www.xiaohongshu.com/explore/${noteId}`),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
  const data = json.data as Record<string, unknown> | undefined;
  const items = (data?.items ?? json.items) as Array<{ note_card?: Record<string, unknown> }> | undefined;
  const card = items?.[0]?.note_card;
  if (!card) throw new Error(String(json.msg ?? json.message ?? "feed empty"));
  return mapNoteCard(card, noteId);
}