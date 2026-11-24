import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { xiaohongshuUserAgent } from "../config.js";
import { VideoMcpError, type FetchAssetsOptions, type VideoRef, type VideoStats } from "../types.js";
import { buildArticleMarkdown, downloadImages } from "./article-html.js";
import { fetchNoteViaFeed, findNoteXsecTokenViaSearch, mintNoteShortUrl } from "./xiaohongshu-api.js";
import { xhsCookieHint, xhsSessionOptional } from "./xiaohongshu-cookie.js";
import { readCachedXsecToken, writeCachedXsecToken } from "./xiaohongshu-token-cache.js";
import type { MediaFetchResult, PlatformAdapter } from "./types.js";

const exec = promisify(execFile);
const UA = xiaohongshuUserAgent();
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
const ID = /^[0-9a-f]{24}$/i;

type Note = {
  noteId?: string; type?: string; title?: string; desc?: string; time?: number;
  user?: { nickname?: string };
  interactInfo?: unknown;
  interact_info?: unknown;
  imageList?: Array<{ urlDefault?: string; urlPre?: string; infoList?: Array<{ url?: string }> }>;
  video?: { media?: { video?: { duration?: number }; stream?: Record<string, Array<{ masterUrl?: string; backupUrls?: string[]; audioCodec?: string }>> } };
};

function allowedPage(host: string): boolean {
  return host === "xiaohongshu.com" || host === "www.xiaohongshu.com" || /^(?:www\.)?xhslink\.(?:com|cn)$/.test(host);
}

function noteIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/(?:explore|discovery\/item)\/([0-9a-f]{24})\/?$/i);
  return match && ID.test(match[1]) ? match[1] : null;
}

/** 跟随 xhslink 到笔记页（GET + mobile UA，与 resolveUrl 一致）。 */
export async function followXhsRedirects(url: URL, maxHops = 6): Promise<URL> {
  let current = new URL(url.toString());
  const fromShort = /^(?:www\.)?xhslink\.(?:com|cn)$/i.test(url.hostname);
  for (let i = 0; i < maxHops; i++) {
    const nid = noteIdFromPath(current.pathname);
    const hasToken = extractXsecTokens(current.toString()).length > 0;
    if (nid && hasToken) {
      current.protocol = "https:";
      current.hostname = "www.xiaohongshu.com";
      return current;
    }
    if (nid && !fromShort) {
      current.protocol = "https:";
      current.hostname = "www.xiaohongshu.com";
      return current;
    }
    const canFollow =
      /^(?:www\.)?xhslink\.(?:com|cn)$/i.test(current.hostname) ||
      (fromShort && nid && !hasToken);
    if (!canFollow) break;
    const response = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(15000), headers: { "User-Agent": MOBILE_UA } });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) break;
    const next = new URL(location, current);
    if (!allowedPage(next.hostname.toLowerCase()) || next.username || next.password || next.port) break;
    current = next;
  }
  return current;
}

/** 分享文案里若同时有 xhslink 与 explore 长链，优先用短链（可刷新 xsec_token）。 */
export function xhsInputUrl(input: string): URL | null {
  const found: URL[] = [];
  for (const match of input.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    try {
      const url = new URL(match[0].replace(/[，。！？、）)]+$/, ""));
      if (allowedPage(url.hostname.toLowerCase()) && !url.username && !url.password && !url.port) found.push(url);
    } catch { /* ignore malformed URLs */ }
  }
  if (!found.length) return null;
  const short = found.find((u) => /^(?:www\.)?xhslink\.(?:com|cn)$/i.test(u.hostname));
  return short ?? found[0];
}

/** 从分享正文中截取可用于搜索刷新令牌的标题/话题（不含纯链接行）。 */
export function extractXhsSearchKeywords(rawInput: string, noteId: string): string[] {
  const out: string[] = [];
  const textOnly = rawInput.replace(/https?:\/\/\S+/gi, " ");
  for (const line of textOnly.split(/\r?\n/)) {
    const t = line.replace(/[\u{1F300}-\u{1FAFF}\u{FE00}-\u{FE0F}\u{200D}]/gu, "").trim();
    if (t.length < 4 || t.length > 80) continue;
    if (/^[0-9a-f]{24}$/i.test(t)) continue;
    if (!/[\u4e00-\u9fffA-Za-z]/.test(t)) continue;
    out.push(t);
  }
  for (const m of rawInput.matchAll(/#([^\s#]{2,40})/g)) out.push(m[1]);
  for (const m of rawInput.matchAll(/([\u4e00-\u9fffA-Za-z0-9][\u4e00-\u9fffA-Za-z0-9\s·]{2,78})\s+https?:\/\//g)) {
    const t = m[1].trim();
    if (t.length >= 4 && t.length <= 80) out.push(t);
  }
  return [...new Set(out.filter((k) => k !== noteId))];
}

function pageId(url: URL): string | null {
  return noteIdFromPath(url.pathname);
}

/** App 分享偶尔会把第二个 ?xsec_token= 拼进 query，URL 解析会丢掉后面的令牌。 */
export function extractXsecTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[?&]xsec_token=([^&\s#"'<>]+)/gi)) {
    let token = m[1];
    try { token = decodeURIComponent(token); } catch { /* keep raw */ }
    if (token && !out.includes(token)) out.push(token);
  }
  return out;
}

const FEED_XSEC_SOURCES = ["app_share", "pc_share", "pc_search", "webshare", "pc_feed"] as const;

/** 畸形链接里可能出现多个 source；只认合法取值，避免把 `pc_share?xsec_token=` 吃进 source。 */
export function extractXsecSources(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[?&](?:xsec_source|source)=([a-z0-9_]+)/gi)) {
    const v = m[1].toLowerCase();
    if (!out.includes(v)) out.push(v);
  }
  return out.length ? out : ["app_share"];
}

export function extractXsecSource(text: string): string {
  return extractXsecSources(text)[0] ?? "app_share";
}

/** App 分享常带 app_platform / type，丢掉后移动端 H5 易 404（参见 media-parser / dsh-reverie 讨论）。 */
export function shareQueryExtras(rawInput: string, xsecSource: string): Record<string, string> {
  const extras: Record<string, string> = {};
  if (xsecSource === "app_share" || /app_platform=/i.test(rawInput)) {
    if (!/[?&]app_platform=/i.test(rawInput)) extras.app_platform = "ios";
  }
  for (const m of rawInput.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    try {
      const u = new URL(m[0]);
      for (const key of ["app_platform", "type", "xhsshare", "share_from_user_hidden", "author_share"]) {
        const v = u.searchParams.get(key);
        if (v) extras[key] = v;
      }
    } catch { /* ignore */ }
  }
  return extras;
}

export function notePageCandidates(
  id: string,
  tokens: string[],
  xsecSources: string[] = ["app_share"],
  rawInput = "",
): string[] {
  const paths = [`/explore/${id}`, `/discovery/item/${id}`];
  const tokenList = tokens.length ? tokens : [""];
  const sources = xsecSources.length ? xsecSources : ["app_share"];
  const urls: string[] = [];
  for (const p of paths) {
    for (const token of tokenList) {
      if (!token) {
        urls.push(`https://www.xiaohongshu.com${p}`);
        continue;
      }
      for (const source of sources) {
        const q = new URLSearchParams({ xsec_token: token, xsec_source: source, ...shareQueryExtras(rawInput, source) });
        urls.push(`https://www.xiaohongshu.com${p}?${q.toString()}`);
      }
    }
  }
  return urls;
}

function userAgentsFor(url: string, rawInput?: string): string[] {
  const hint = `${url}${rawInput ?? ""}`;
  const mobileFirst =
    /\/discovery\/item\//i.test(url) ||
    /xsec_source=app_share|app_platform=/i.test(hint);
  return mobileFirst ? [MOBILE_UA, UA] : [UA, MOBILE_UA];
}

export async function resolveUrl(input: string): Promise<URL> {
  const initial = xhsInputUrl(input);
  if (!initial) throw new VideoMcpError("Invalid Xiaohongshu URL.", "UNSUPPORTED_URL");
  const url = await followXhsRedirects(initial);
  if (pageId(url)) return url;
  throw new VideoMcpError("小红书链接不是受支持的单篇笔记，或短链接跳转无效；请复制笔记的完整分享链接。", "UNSUPPORTED_URL");
}

/** 小红书的状态是 JSON 加 undefined；只在字符串外替换，不执行网页脚本。 */
export function parseXhsState(html: string): Record<string, unknown> {
  const match = html.match(/window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script\s*>/i);
  if (!match) throw new VideoMcpError("小红书没有返回笔记内容，可能需要登录、链接失效或被风控。", "VIP_OR_LOGIN");
  const raw = match[1].trim().replace(/;$/, "");
  let result = "";
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quoted) {
      result += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true; result += c;
    } else if (raw.startsWith("undefined", i) && !/[\w$]/.test(raw[i - 1] ?? "") && !/[\w$]/.test(raw[i + 9] ?? "")) {
      result += "null"; i += 8;
    } else result += c;
  }
  try { return JSON.parse(result) as Record<string, unknown>; }
  catch { throw new VideoMcpError("小红书页面结构无法解析，可能已发生变化。", "DOWNLOAD_FAILED"); }
}

function noteFromMobileState(state: Record<string, unknown>, id: string): Note | null {
  const wrap = state.noteData as { data?: { noteData?: Record<string, unknown> } } | undefined;
  const raw = wrap?.data?.noteData;
  if (!raw) return null;
  const noteId = (raw.noteId ?? raw.note_id) as string | undefined;
  if (noteId && noteId !== id) return null;
  return {
    noteId: id,
    type: raw.type as string | undefined,
    title: raw.title as string | undefined,
    desc: raw.desc as string | undefined,
    time: raw.time as number | undefined,
    user: raw.user as { nickname?: string } | undefined,
    interactInfo: raw.interactInfo ?? raw.interact_info,
    imageList: raw.imageList as Note["imageList"],
    video: raw.video as Note["video"],
  };
}

function noteFromHtml(html: string, id: string): Note {
  const state = parseXhsState(html) as { note?: { noteDetailMap?: Record<string, { note?: Note }> } };
  const note = state.note?.noteDetailMap?.[id]?.note;
  if (note && (!note.noteId || note.noteId === id)) return note;
  const mobile = noteFromMobileState(state, id);
  if (mobile) return mobile;
  throw new VideoMcpError("未获取到该小红书笔记；请确认笔记可见且分享链接完整。", "NOT_FOUND");
}

async function fetchNoteHtml(url: string, opts?: { userAgent?: string; cookieHeader?: string }): Promise<string> {
  const ua = opts?.userAgent ?? UA;
  const args = ["--silent", "--show-error", "--location", "--max-redirs", "6", "--max-time", "25", "--proto", "=https", "-H", `User-Agent: ${ua}`, "-H", `Accept: ${ACCEPT}`];
  if (opts?.cookieHeader) args.push("-H", `Cookie: ${opts.cookieHeader}`);
  args.push("--", url);
  const { stdout } = await exec(process.platform === "win32" ? "curl.exe" : "curl", args, { maxBuffer: 12 * 1024 * 1024, timeout: 30000 });
  return stdout;
}

async function tryHtmlNote(
  candidate: string,
  id: string,
  rawInput: string | undefined,
  cookieHeader?: string,
): Promise<Note | null> {
  for (const userAgent of userAgentsFor(candidate, rawInput)) {
    try {
      const html = await fetchNoteHtml(candidate, { userAgent, cookieHeader });
      return noteFromHtml(html, id);
    } catch (error) {
      if (error instanceof VideoMcpError && error.code !== "VIP_OR_LOGIN" && error.code !== "NOT_FOUND") throw error;
    }
  }
  return null;
}

async function loadNoteWithTokens(
  id: string,
  rawInput: string | undefined,
  tokens: string[],
  xsecSources: string[],
  candidates: string[],
  session?: XhsSession | null,
): Promise<{ note: Note; pageUrl: string } | null> {
  for (const candidate of candidates) {
    const note = await tryHtmlNote(candidate, id, rawInput, session?.cookieHeader);
    if (note) return { note, pageUrl: candidate };
  }
  if (!session) return null;
  const feedTokens = [...tokens];
  if (!feedTokens.includes("")) feedTokens.push("");
  const sourceList = [...new Set([...xsecSources, ...FEED_XSEC_SOURCES])];
  for (const token of feedTokens) {
    for (const source of sourceList) {
      try {
        const note = await fetchNoteViaFeed(id, token, source, session) as Note;
        if (!note.noteId) note.noteId = id;
        const pageUrl = token
          ? `https://www.xiaohongshu.com/explore/${id}?xsec_token=${encodeURIComponent(token)}&xsec_source=${source}`
          : `https://www.xiaohongshu.com/explore/${id}`;
        return { note, pageUrl };
      } catch { /* try next source */ }
    }
  }
  return null;
}

type XhsSession = NonNullable<Awaited<ReturnType<typeof xhsSessionOptional>>>;

async function persistWorkingToken(id: string, pageUrl: string, note: Note): Promise<{ note: Note; pageUrl: string }> {
  const tokens = extractXsecTokens(pageUrl);
  if (tokens[0]) await writeCachedXsecToken(id, tokens[0], extractXsecSource(pageUrl));
  return { note, pageUrl };
}

async function loadNote(url: string, id: string, rawInput?: string): Promise<{ note: Note; pageUrl: string }> {
  const session = await xhsSessionOptional();
  const context = `${url}${rawInput ?? ""}`;
  let xsecSources = extractXsecSources(context);
  const fromUrl = extractXsecTokens(url);
  const fromInput = rawInput ? extractXsecTokens(rawInput) : [];
  const cached = await readCachedXsecToken(id);
  if (cached?.xsecSource && !xsecSources.includes(cached.xsecSource)) {
    xsecSources = [cached.xsecSource, ...xsecSources];
  }
  const tokens = [...new Set([...(cached ? [cached.token] : []), ...fromUrl, ...fromInput])];
  const contextText = `${url}${rawInput ?? ""}`;
  let candidates = [...new Set([url, ...notePageCandidates(id, tokens, xsecSources, contextText)])];

  const first = await loadNoteWithTokens(id, rawInput, tokens, xsecSources, candidates, null);
  if (first) return persistWorkingToken(id, first.pageUrl, first.note);
  if (session) {
    const second = await loadNoteWithTokens(id, rawInput, tokens, xsecSources, candidates, session);
    if (second) return persistWorkingToken(id, second.pageUrl, second.note);

    const searchHit = await findNoteXsecTokenViaSearch(id, extractXhsSearchKeywords(rawInput ?? url, id), session);
    if (searchHit) {
      xsecSources = [...new Set([searchHit.xsecSource, ...xsecSources])];
      const searchTokens = [...new Set([searchHit.token, ...tokens])];
      candidates = [...new Set([...candidates, ...notePageCandidates(id, searchTokens, xsecSources, contextText)])];
      const viaSearch = await loadNoteWithTokens(id, rawInput, searchTokens, xsecSources, candidates, session);
      if (viaSearch) return persistWorkingToken(id, viaSearch.pageUrl, viaSearch.note);
    }

    try {
      const short = await mintNoteShortUrl(id, session);
      const landed = await followXhsRedirects(new URL(short));
      const freshTokens = extractXsecTokens(landed.toString());
      if (freshTokens.length) {
        const freshSources = extractXsecSources(landed.toString());
        const freshCandidates = [...new Set([landed.toString(), ...notePageCandidates(id, freshTokens, freshSources, landed.toString())])];
        const third = await loadNoteWithTokens(id, rawInput, freshTokens, freshSources, freshCandidates, session);
        if (third) return persistWorkingToken(id, third.pageUrl, third.note);
      }
    } catch { /* share refresh failed */ }
  }
  const hint = session
    ? " 链接里的 xsec_token 可能已过期；请在同一句话里附上笔记标题或 xhslink，或先解析一次短链写入本地令牌缓存。"
    : ` ${xhsCookieHint()}`;
  throw new VideoMcpError(
    `小红书笔记 ${id} 未返回内容（常见原因：xsec_token 已失效）。请试 xhslink 短链或附带分享标题。${hint}`,
    session ? "DOWNLOAD_FAILED" : "VIP_OR_LOGIN",
  );
}

function mediaUrl(raw: string | undefined): string | undefined {
  if (!raw) return;
  try {
    const u = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.port || !/(^|\.)(xhscdn\.com|xiaohongshu\.com)$/.test(u.hostname)) return;
    u.protocol = "https:";
    return u.toString();
  } catch { return; }
}

function parseInteractionCount(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
  if (typeof raw !== "string") return;
  const match = raw.trim().match(/^(\d+|\d{1,3}(?:[,，]\d{3})+)(\.\d+)?\s*([万亿wk])?\s*\+?$/i);
  if (!match) return;

  const value = Number(match[1].replace(/[,，]/g, "") + (match[2] ?? ""));
  const unit = match[3]?.toLowerCase();
  const multiplier = unit === "亿" ? 100_000_000 : unit === "万" || unit === "w" ? 10_000 : unit === "k" ? 1_000 : 1;
  // 缩写是平台给出的约数；尾部的 + 只表示至少有这么多。
  const count = multiplier === 1 ? value : Math.round(value * multiplier);
  return Number.isSafeInteger(count) ? count : undefined;
}

function noteStats(note: Note): VideoStats | undefined {
  const raw = note.interactInfo ?? note.interact_info;
  if (!raw || typeof raw !== "object") return;
  const info = raw as Record<string, unknown>;
  const stats: VideoStats = {};
  for (const [field, camelCase, snakeCase] of [
    ["likes", "likedCount", "liked_count"],
    ["comments", "commentCount", "comment_count"],
    ["favorites", "collectedCount", "collected_count"],
    ["shares", "shareCount", "share_count"],
  ] as const) {
    const count = parseInteractionCount(info[camelCase]) ?? parseInteractionCount(info[snakeCase]);
    if (count !== undefined) stats[field] = count;
  }
  return Object.keys(stats).length ? stats : undefined;
}

export class XiaohongshuAdapter implements PlatformAdapter {
  readonly platform = "xiaohongshu";
  canHandle(input: string): boolean { return xhsInputUrl(input) !== null; }

  async resolve(input: string): Promise<VideoRef> {
    const url = await resolveUrl(input);
    const id = pageId(url)!;
    const { note, pageUrl } = await loadNote(url.toString(), id, input);
    if (note.type !== "video" && note.type !== "normal") throw new VideoMcpError("暂不支持这种小红书笔记类型。", "UNSUPPORTED_URL");
    const time = note.time && Number.isFinite(note.time) ? new Date(note.time) : undefined;
    const stats = noteStats(note);
    return {
      platform: this.platform, id, title: note.title?.trim() || note.desc?.trim().slice(0, 80) || "小红书笔记",
      author: note.user?.nickname || "未知作者", durationSec: note.video?.media?.video?.duration ?? 0,
      ...(time && !Number.isNaN(time.getTime()) ? { publishedAt: time.toISOString() } : {}),
      ...(stats ? { stats } : {}),
      pageUrl, extras: { kind: note.type === "video" ? "video" : "images" },
    };
  }

  async fetchMedia(ref: VideoRef, destDir: string, options?: FetchAssetsOptions): Promise<MediaFetchResult> {
    const url = await resolveUrl(ref.pageUrl);
    if (pageId(url) !== ref.id) throw new VideoMcpError("笔记 ID 与链接不匹配。", "UNSUPPORTED_URL");
    const { note } = await loadNote(url.toString(), ref.id, ref.pageUrl);
    if (note.type !== "video" && note.type !== "normal") throw new VideoMcpError("暂不支持这种小红书笔记类型。", "UNSUPPORTED_URL");
    await fs.mkdir(destDir, { recursive: true });
    if (note.type !== "video") {
      const urls = [...new Set((note.imageList ?? []).map(i => mediaUrl(i.urlDefault || i.infoList?.[0]?.url || i.urlPre)).filter((u): u is string => !!u))];
      const articleText = note.desc?.trim() || ref.title;
      const articlePath = path.join(destDir, "article.md");
      await fs.writeFile(articlePath, buildArticleMarkdown({ title: ref.title, meta: [`- 作者：${ref.author}`, `- 原文：${ref.pageUrl}`], text: articleText, imageUrls: urls }), "utf8");
      const notes = ["小红书图文：文字可能只是说明，主要内容可能在图片中。"];
      let imagePaths: string[] | undefined;
      if (options?.wantKeyframes && urls.length) {
        const downloaded = await downloadImages(urls, destDir, { userAgent: UA, referer: "https://www.xiaohongshu.com/", limit: 40 });
        notes.push(...downloaded.notes); imagePaths = downloaded.paths;
      }
      return { articleText, articlePath, imagePaths, notes };
    }
    const notes = note.desc ? [`小红书笔记文案：${note.desc}`] : [];
    if (!options?.wantAsr && !options?.wantKeyframes) return { notes };
    const streams = note.video?.media?.stream ?? {};
    const candidates = Object.values(streams).flat().flatMap(s => [s.masterUrl, ...(s.backupUrls ?? [])]).map(mediaUrl).filter((u): u is string => !!u);
    const dest = path.join(destDir, "video.mp4");
    for (const candidate of candidates) {
      try {
        const response = await fetch(candidate, { redirect: "manual", headers: { "User-Agent": UA, Referer: "https://www.xiaohongshu.com/" }, signal: AbortSignal.timeout(120000) });
        if (!response.ok || !response.body) continue;
        const file = await fs.open(dest, "w");
        let size = 0;
        try {
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > 1024 * 1024 * 1024) throw new Error("video too large");
            await file.writeFile(chunk);
          }
        } finally { await file.close(); }
        if (!size) { await fs.rm(dest, { force: true }); continue; }
        return { videoPath: dest, notes };
      } catch { await fs.rm(dest, { force: true }); /* try next CDN address */ }
    }
    throw new VideoMcpError("无法下载小红书视频，链接可能过期或受到访问限制。", "DOWNLOAD_FAILED");
  }
}
