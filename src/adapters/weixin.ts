import fs from "node:fs/promises";
import path from "node:path";
import {
  weixinChksm,
  weixinSearchEnabled,
  weixinUserAgent,
} from "../config.js";
import { VideoMcpError, type FetchAssetsOptions, type VideoRef } from "../types.js";
import type { MediaFetchResult, PlatformAdapter } from "./types.js";
import { WEIXIN_SEED_ARTICLES, type WeixinSeedArticle } from "./weixin-seeds.js";
import {
  clearPersistedChksm,
  loadPersistedChksm,
  savePersistedChksm,
} from "./weixin-chksm.js";

const WEIXIN_HOST = "mp.weixin.qq.com";
const MAX_ARTICLE_IMAGES = 20;
const PAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const PAGE_CACHE_LIMIT = 4;

export interface WeixinInput {
  kind: "short" | "long";
  /** 规范化后的抓取地址（不含 chksm；chksm 单独保存） */
  url: string;
  shortId?: string;
  biz?: string;
  mid?: string;
  idx?: string;
  sn?: string;
  chksm?: string;
}

export interface WeixinArticle {
  title: string;
  accountName: string;
  author: string;
  publishedAt?: string;
  biz?: string;
  mid?: string;
  idx?: string;
  sn?: string;
  chksm?: string;
  /** 正文纯文本；图片分享页没有 js_content 时给出说明性文本 */
  text: string;
  imageUrls: string[];
  articleType: "text" | "image";
  canonicalUrl: string;
}

interface FetchedPage {
  html: string;
  finalUrl: string;
  status: number;
}

interface CachedPage {
  page: FetchedPage;
  at: number;
}

const pageCache = new Map<string, CachedPage>();
const refCache = new Map<string, VideoRef>();
const searchCache = new Map<string, string[]>();
let learnedChksm: string | undefined;

/** 测试用：清掉进程内的页面缓存、VideoRef 缓存、搜索缓存与学到的 chksm，避免用例互相影响。 */
export function clearWeixinCache(): void {
  pageCache.clear();
  refCache.clear();
  searchCache.clear();
  learnedChksm = undefined;
  clearPersistedChksm();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function decodeJsString(raw: string): string {
  const decoded = raw.replace(
    /\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|n|r|t|b|f|v|0|'|"|\\|\/)/g,
    (_match, code: string) => {
      switch (code) {
        case "n": return "\n";
        case "r": return "\r";
        case "t": return "\t";
        case "b": return "\b";
        case "f": return "\f";
        case "v": return "\v";
        case "0": return "\0";
        case "'": return "'";
        case '"': return '"';
        case "\\": return "\\";
        case "/": return "/";
        default:
          if (code.startsWith("x")) return String.fromCharCode(Number.parseInt(code.slice(1), 16));
          if (code.startsWith("u")) return String.fromCharCode(Number.parseInt(code.slice(1), 16));
          return code;
      }
    },
  );
  return decodeHtmlEntities(decoded);
}

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(
    `\\b${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const match = re.exec(tag);
  if (!match) return undefined;
  return decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? "");
}

function readJsVar(html: string, name: string): string | undefined {
  const re = new RegExp(`\\bvar\\s+${escapeRegExp(name)}\\s*=\\s*`, "gi");
  let fallback: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    let index = match.index + match[0].length;
    while (index < html.length && /\s/.test(html[index]!)) index += 1;
    if (html.startsWith("htmlDecode(", index)) {
      index += "htmlDecode(".length;
      while (index < html.length && /\s/.test(html[index]!)) index += 1;
    }

    const quote = html[index];
    if (quote === "'" || quote === '"') {
      index += 1;
      let raw = "";
      while (index < html.length) {
        const ch = html[index]!;
        if (ch === "\\") {
          raw += ch;
          index += 1;
          if (index < html.length) raw += html[index]!;
          index += 1;
          continue;
        }
        if (ch === quote) return decodeJsString(raw);
        raw += ch;
        index += 1;
      }
      continue;
    }

    // 页面里可能有同名变量先以表达式形式出现（如压缩代码里的 `var ct=et(r,G)`），
    // 这里跳过它继续找真正的字符串赋值，避免把表达式当成元数据。
    const end = html.indexOf(";", index);
    if (end < 0) continue;
    const raw = html.slice(index, end).trim();
    if (!fallback && raw && !/[(){}]/.test(raw)) fallback = decodeHtmlEntities(raw);
  }
  return fallback;
}

function metaContent(html: string, property: string): string | undefined {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const key = attr(tag, "property") ?? attr(tag, "name");
    if (key?.toLowerCase() === property.toLowerCase()) {
      return attr(tag, "content");
    }
  }
  return undefined;
}

function textOfId(html: string, id: string): string | undefined {
  const re = new RegExp(
    `<([a-zA-Z0-9]+)\\b[^>]*\\bid\\s*=\\s*["']${escapeRegExp(id)}["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
    "i",
  );
  const match = re.exec(html);
  return match ? normalizeText(decodeHtmlEntities(match[2]!.replace(/<[^>]+>/g, ""))) : undefined;
}

/** 提取指定 id 的 div 内部 HTML，按 div 深度匹配，避免正文里的嵌套 div 截断。 */
function extractDivById(html: string, id: string): string {
  const open = new RegExp(
    `<div\\b[^>]*\\bid\\s*=\\s*["']${escapeRegExp(id)}["'][^>]*>`,
    "i",
  );
  const match = open.exec(html);
  if (!match) return "";

  const start = match.index + match[0].length;
  let depth = 1;
  const tagRe = /<\/?div\b[^>]*>/gi;
  tagRe.lastIndex = start;
  let tag: RegExpExecArray | null;
  while ((tag = tagRe.exec(html))) {
    if (/^<\/div/i.test(tag[0])) depth -= 1;
    else if (!/\/>$/.test(tag[0])) depth += 1;
    if (depth === 0) return html.slice(start, tag.index);
  }
  return html.slice(start);
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** 将微信正文 HTML 转成可读纯文本，保留段落换行，去掉脚本和内联样式。 */
function htmlToText(html: string): string {
  let text = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(
    /<\/(p|div|section|li|h[1-6]|blockquote|tr|td|article|header|footer|pre)>/gi,
    "\n",
  );
  text = text.replace(/<img\b[^>]*>/gi, "");
  text = text.replace(/<[^>]+>/g, "");
  return normalizeText(decodeHtmlEntities(text));
}

function normalizeImageUrl(raw: string): string | undefined {
  let url = decodeHtmlEntities(raw)
    .replace(/\\\//g, "/")
    .trim();
  if (!url || url.startsWith("data:")) return undefined;
  if (url.startsWith("//")) url = `https:${url}`;
  else if (url.startsWith("http://")) url = `https://${url.slice("http://".length)}`;
  if (!/^https?:\/\//i.test(url)) return undefined;
  if (!/(?:qpic\.cn|qlogo\.cn)\//i.test(url)) return undefined;
  return url;
}

function extractImages(html: string): string[] {
  const tags = html.match(/<img\b[^>]*>/gi) ?? [];
  const urls: string[] = [];
  for (const tag of tags) {
    const raw = attr(tag, "data-src") ?? attr(tag, "data-original") ?? attr(tag, "src");
    if (!raw) continue;
    const url = normalizeImageUrl(raw);
    if (url) urls.push(url);
  }
  return unique(urls).slice(0, 50);
}

/** 图片分享页（appmsg_type=9 / item_show_type=8）没有 js_content，图片列表在 JSON 里。 */
function extractImagePostImages(html: string): string[] {
  const start = html.search(/picture_page_info_list/i);
  const rawSlice = start >= 0 ? html.slice(start, start + 500_000) : html;
  const slice = rawSlice.replace(/\\\//g, "/").replace(/\\u0026/gi, "&");
  const rawUrls = slice.match(/https?:\/\/[^"'\\\s<>]+/g) ?? [];
  const urls = rawUrls
    .map((raw) => normalizeImageUrl(raw))
    .filter((url): url is string => Boolean(url));
  if (urls.length) return unique(urls).slice(0, 50);
  return unique(
    [...slice.matchAll(/https?:\/\/[^"'\\\s<>]*qpic\.cn\/[^"'\\\s<>]*/gi)]
      .map((match) => normalizeImageUrl(match[0]))
      .filter((url): url is string => Boolean(url)),
  ).slice(0, 50);
}

function extractChksm(text: string): string | undefined {
  const match = /[?&]chksm=([0-9a-f]+)/i.exec(decodeHtmlEntities(text).replace(/\\\//g, "/"));
  return match?.[1];
}

function buildLongUrl(params: {
  biz?: string;
  mid?: string;
  idx?: string;
  sn?: string;
}): string | undefined {
  if (!params.biz || !params.mid || !params.sn) return undefined;
  const url = new URL("https://mp.weixin.qq.com/s");
  url.searchParams.set("__biz", params.biz);
  url.searchParams.set("mid", params.mid);
  url.searchParams.set("idx", params.idx ?? "1");
  url.searchParams.set("sn", params.sn);
  return url.toString();
}

function extractWeixinUrl(input: string): string | undefined {
  const match = input.match(
    /(https?:\/\/)?mp\.weixin\.qq\.com\/s[^\s"'<>，。；、）】]+/i,
  );
  if (!match) return undefined;
  let raw = match[0].replace(/&amp;/g, "&");
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  raw = raw.replace(/[),.;!?]+$/, "");
  try {
    const url = new URL(raw);
    if (url.hostname.toLowerCase() !== WEIXIN_HOST) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function parseWeixinInput(input: string): WeixinInput | null {
  const rawUrl = extractWeixinUrl(input);
  if (!rawUrl) {
    // 允许用 resolve_video 返回的 32 位 sn 继续 fetch_assets；同一进程里
    // resolve 会把 VideoRef 记进 refCache，跨进程请改用文章 URL。
    const bareSn = input.trim();
    if (/^[0-9a-f]{32}$/i.test(bareSn)) {
      return { kind: "long", url: "", sn: bareSn.toLowerCase() };
    }
    return null;
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const shortMatch = /^\/s\/([^/]+)\/?$/.exec(url.pathname);
  if (shortMatch) {
    const shortId = decodeURIComponent(shortMatch[1]!);
    return {
      kind: "short",
      url: `https://${WEIXIN_HOST}/s/${encodeURIComponent(shortId)}`,
      shortId,
    };
  }

  if (url.pathname !== "/s") return null;
  const biz = url.searchParams.get("__biz") ?? undefined;
  const mid = url.searchParams.get("mid") ?? undefined;
  const idx = url.searchParams.get("idx") ?? undefined;
  const sn = url.searchParams.get("sn") ?? undefined;
  const chksm = url.searchParams.get("chksm") ?? undefined;
  const canonical = buildLongUrl({ biz, mid, idx, sn });
  return {
    kind: "long",
    url: canonical ?? url.toString(),
    biz,
    mid,
    idx,
    sn,
    chksm,
  };
}

export function canHandleWeixin(input: string): boolean {
  return parseWeixinInput(input) !== null;
}

function withChksm(url: string, chksm: string): string {
  const next = new URL(url);
  next.searchParams.set("chksm", chksm);
  return next.toString();
}

async function requestHeaders(): Promise<Record<string, string>> {
  return {
    "User-Agent": weixinUserAgent(),
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Referer: "https://mp.weixin.qq.com/",
    "Upgrade-Insecure-Requests": "1",
  };
}

async function fetchHtml(url: string, timeoutMs = 0): Promise<FetchedPage> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: await requestHeaders(),
      redirect: "follow",
      signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (err) {
    throw new VideoMcpError(
      `Failed to fetch Weixin page ${url}: ${err instanceof Error ? err.message : String(err)}`,
      "DOWNLOAD_FAILED",
    );
  }
  const html = await response.text();
  return { html, finalUrl: response.url || url, status: response.status };
}

function isArticleHtml(html: string): boolean {
  return /id\s*=\s*["']js_content["']/i.test(html) || /picture_page_info_list/i.test(html);
}

function isCaptchaPage(page: FetchedPage): boolean {
  return (
    /wappoc_appmsgcaptcha/i.test(page.finalUrl) ||
    /wappoc_appmsgcaptcha/i.test(page.html) ||
    (/环境异常/.test(page.html) && !isArticleHtml(page.html))
  );
}

function unavailableReason(html: string): string | undefined {
  if (/此账号已自主注销|账号已自主注销/.test(html)) return "账号已注销，内容无法查看";
  if (/该内容已被发布者删除|内容已删除/.test(html)) return "内容已被发布者删除";
  if (/此内容因违规无法查看|此账号已被屏蔽/.test(html)) return "内容因违规或安全风险被限制";
  if (/此内容被投诉且经审核涉嫌侵权|经审核涉嫌侵权/.test(html)) return "内容因侵权投诉被限制";
  if (/该公众号已迁移/.test(html)) return "公众号已迁移";
  if (/链接已过期/.test(html)) return "链接已过期";
  // 隐私页是前端渲染的，HTML 里只有 private 入口脚本；文案在 private.*.js 内。
  if (
    /根据作者隐私设置，无法查看该内容|作者隐私设置/.test(html) ||
    /private_vite_entry|js\/assets\/private\.[^"']+\.js/.test(html)
  ) {
    return "根据作者隐私设置，无法查看该内容";
  }
  // 部分下架/删除页只渲染空壳提示，正文和错误文案都由脚本注入。
  if (/weui-msg/.test(html) && html.length > 20000) return "内容不可用（可能已下架或仅限特定环境查看）";
  return undefined;
}

function isUnavailablePage(html: string): boolean {
  return unavailableReason(html) !== undefined;
}

function unavailableError(url: string, html: string): VideoMcpError {
  const reason = unavailableReason(html) ?? "内容不可用";
  return new VideoMcpError(`Weixin article is unavailable: ${url} (${reason})`, "NOT_FOUND");
}

function captchaError(url: string): VideoMcpError {
  return new VideoMcpError(
    `Weixin returned a captcha instead of the article (${url}). ` +
      "Use the short link form https://mp.weixin.qq.com/s/<id>, or set VIDEO_MCP_WEIXIN_CHKSM to a valid chksm from an article you can open.",
    "WEIXIN_CAPTCHA",
  );
}

function rememberChksm(html: string, seedUrl?: string): void {
  const chksm = extractChksm(html);
  if (!chksm) return;
  learnedChksm = chksm;
  savePersistedChksm(chksm, seedUrl);
}

function currentChksm(): string | undefined {
  return weixinChksm() ?? learnedChksm ?? loadPersistedChksm()?.chksm;
}

function cachePage(key: string, page: FetchedPage): void {
  pageCache.set(key, { page, at: Date.now() });
  while (pageCache.size > PAGE_CACHE_LIMIT) {
    const oldest = [...pageCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!oldest) break;
    pageCache.delete(oldest[0]);
  }
}

function cachedPage(key: string): FetchedPage | undefined {
  const hit = pageCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > PAGE_CACHE_TTL_MS) {
    pageCache.delete(key);
    return undefined;
  }
  return hit.page;
}

function jqDecode(value: string): string {
  return decodeHtmlEntities(value.replace(/\\\//g, "/").replace(/\\u0026/gi, "&"));
}

/** 从 getappmsgext 的 JSON 或相邻文章页里找可用的 chksm；它通常不触发验证码。 */
async function bootstrapChksm(input: WeixinInput): Promise<string[]> {
  if (!input.biz || !input.mid || !input.sn) return [];

  const api = new URL("https://mp.weixin.qq.com/mp/getappmsgext");
  api.searchParams.set("__biz", input.biz);
  api.searchParams.set("mid", input.mid);
  api.searchParams.set("idx", input.idx ?? "1");
  api.searchParams.set("sn", input.sn);
  api.searchParams.set("wxtoken", "777");

  try {
    const page = await fetchHtml(api.toString());
    if (!page.html.trim().startsWith("{")) return [];
    const links = unique(
      [...page.html.matchAll(/"(?:pre|next)_article_link"\s*:\s*"([^"]+)"/g)]
        .map((match) => jqDecode(match[1]!)),
    );
    const found = links
      .map((link) => extractChksm(link))
      .filter((chksm): chksm is string => Boolean(chksm));
    if (found.length) return unique(found);

    // 非合集文章不会有相邻链接；合集文章可以从相邻文章页的 pre/next 再找一次。
    for (const link of links.slice(0, 2)) {
      try {
        const neighbor = await fetchHtml(link);
        if (!isArticleHtml(neighbor.html)) continue;
        const neighborLinks = [
          ...neighbor.html.matchAll(/https?:\/\/mp\.weixin\.qq\.com\/s\?[^"'<>\\\s]+/gi),
        ].map((match) => jqDecode(match[0]));
        for (const candidate of neighborLinks) {
          if (!candidate.includes(`sn=${input.sn}`) && !candidate.includes(`mid=${input.mid}`)) {
            continue;
          }
          const chksm = extractChksm(candidate);
          if (chksm) return [chksm];
        }
      } catch {
        // 忽略单个相邻文章失败，继续尝试其他候选。
      }
    }
  } catch {
    // getappmsgext 本身失败时不阻塞主流程，最终会给出验证码错误。
  }
  return [];
}

/** 用缓存的短链重新拿一次 chksm；短链通常不触发验证码。 */
async function refreshChksmFromSeed(): Promise<string | undefined> {
  const stored = loadPersistedChksm();
  if (!stored?.seedUrl) return undefined;
  try {
    const page = await fetchHtml(stored.seedUrl);
    if (!isArticleHtml(page.html)) return undefined;
    const chksm = extractChksm(page.html);
    if (!chksm) return undefined;
    learnedChksm = chksm;
    savePersistedChksm(chksm, stored.seedUrl);
    return chksm;
  } catch {
    return undefined;
  }
}

interface SeedChksm {
  chksm: string;
  seedUrl: string;
}

/**
 * 最后一档：用内置的人民日报文章种子学习 chksm。
 *
 * 现在的种子本身就是带 chksm 的长链，先从 URL 里直接取；只有以后改成
 * 短链种子时，才需要打开页面从 msg_link 里找。返回全部候选而不是只返回
 * 第一个，这样即使某条签名过期，也能继续尝试下一条。
 */
async function learnChksmFromSeeds(): Promise<SeedChksm[]> {
  const found: SeedChksm[] = [];
  const needFetch: WeixinSeedArticle[] = [];
  for (const seed of WEIXIN_SEED_ARTICLES) {
    const embedded = extractChksm(seed.url);
    if (embedded) found.push({ chksm: embedded, seedUrl: seed.url });
    else needFetch.push(seed);
  }

  for (let offset = 0; offset < needFetch.length; offset += 4) {
    const batch = needFetch.slice(offset, offset + 4);
    const results = await Promise.allSettled(
      batch.map(async (seed) => {
        const page = await fetchHtml(seed.url, 10_000);
        if (!isArticleHtml(page.html)) return undefined;
        const chksm = extractChksm(page.html);
        return chksm ? { chksm, seedUrl: seed.url } : undefined;
      }),
    );
    for (const result of results) {
      if (result.status !== "fulfilled" || !result.value) continue;
      found.push(result.value);
    }
  }

  return [...new Map(found.map((item) => [item.chksm, item])).values()];
}

/** 最后兜底：用百度索引按 sn 搜公开文章链接里的 chksm；失败不阻塞主流程。 */
async function searchChksm(input: WeixinInput): Promise<string[]> {
  if (!weixinSearchEnabled() || !input.sn) return [];
  const cached = searchCache.get(input.sn);
  if (cached) return cached;

  const url = new URL("https://www.baidu.com/s");
  url.searchParams.set("wd", input.sn);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": weixinUserAgent(),
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    });
    const html = await response.text();
    const found = unique(
      [...html.matchAll(/chksm(?:=|%3D)([0-9a-f]{20,})/gi)].map((match) => match[1]!),
    );
    searchCache.set(input.sn, found);
    return found;
  } catch {
    searchCache.set(input.sn, []);
    return [];
  }
}

async function loadArticleHtml(
  input: WeixinInput,
  preferredChksm?: string,
): Promise<FetchedPage> {
  const candidates = unique(
    [preferredChksm, currentChksm()].filter((value): value is string => Boolean(value)),
  );

  if (input.kind === "short") {
    const attempts = [input.url, ...candidates.map((chksm) => withChksm(input.url, chksm))];
    for (const attempt of attempts) {
      const page = await fetchHtml(attempt);
      if (isArticleHtml(page.html)) {
        rememberChksm(page.html, input.url);
        return page;
      }
      if (isUnavailablePage(page.html)) {
        throw unavailableError(input.url, page.html);
      }
      if (!isCaptchaPage(page) && page.status === 404) {
        throw new VideoMcpError(`Weixin article not found: ${input.url}`, "NOT_FOUND");
      }
    }
    throw captchaError(input.url);
  }

  for (const chksm of candidates) {
    const page = await fetchHtml(withChksm(input.url, chksm));
    if (isArticleHtml(page.html)) {
      learnedChksm = chksm;
      rememberChksm(page.html);
      return page;
    }
    if (isUnavailablePage(page.html)) {
      throw unavailableError(input.url, page.html);
    }
  }

  const direct = await fetchHtml(input.url);
  if (isArticleHtml(direct.html)) {
    rememberChksm(direct.html);
    return direct;
  }
  if (direct.status === 404 || isUnavailablePage(direct.html)) {
    throw unavailableError(input.url, direct.html);
  }

  const bootstrapped = await bootstrapChksm(input);
  for (const chksm of bootstrapped) {
    if (candidates.includes(chksm)) continue;
    const page = await fetchHtml(withChksm(input.url, chksm));
    if (isArticleHtml(page.html)) {
      learnedChksm = chksm;
      rememberChksm(page.html);
      return page;
    }
    if (isUnavailablePage(page.html)) {
      throw unavailableError(input.url, page.html);
    }
  }

  const refreshed = await refreshChksmFromSeed();
  if (refreshed && !candidates.includes(refreshed)) {
    const page = await fetchHtml(withChksm(input.url, refreshed));
    if (isArticleHtml(page.html)) {
      learnedChksm = refreshed;
      rememberChksm(page.html);
      return page;
    }
    if (isUnavailablePage(page.html)) {
      throw unavailableError(input.url, page.html);
    }
  }

  const searched = await searchChksm(input);
  for (const chksm of searched) {
    if (candidates.includes(chksm)) continue;
    const page = await fetchHtml(withChksm(input.url, chksm));
    if (isArticleHtml(page.html)) {
      learnedChksm = chksm;
      rememberChksm(page.html);
      return page;
    }
    if (isUnavailablePage(page.html)) {
      throw unavailableError(input.url, page.html);
    }
  }

  const seeded = await learnChksmFromSeeds();
  for (const { chksm, seedUrl } of seeded) {
    if (candidates.includes(chksm)) continue;
    const page = await fetchHtml(withChksm(input.url, chksm));
    if (isArticleHtml(page.html)) {
      learnedChksm = chksm;
      rememberChksm(page.html, seedUrl);
      savePersistedChksm(learnedChksm ?? chksm, seedUrl);
      return page;
    }
    if (isUnavailablePage(page.html)) {
      throw unavailableError(input.url, page.html);
    }
  }

  throw captchaError(input.url);
}

function parsePublishedAt(html: string): string | undefined {
  const raw = readJsVar(html, "ct") || readJsVar(html, "create_time");
  if (!raw) return undefined;
  const seconds = Number(raw.replace(/[^\d]/g, ""));
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function parseWeixinArticle(
  html: string,
  input?: WeixinInput & { finalUrl?: string },
): WeixinArticle {
  const contentHtml = extractDivById(html, "js_content");
  const metaTitle = metaContent(html, "og:title");
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = normalizeText(
    decodeHtmlEntities(readJsVar(html, "msg_title") || metaTitle || titleTag || "微信公众号文章"),
  ) || "微信公众号文章";

  const accountName = normalizeText(
    decodeHtmlEntities(
      readJsVar(html, "nickname") ||
        textOfId(html, "js_name") ||
        metaContent(html, "og:article:author") ||
        "",
    ),
  );
  const author = normalizeText(decodeHtmlEntities(readJsVar(html, "author") || accountName));

  const biz = readJsVar(html, "biz") || input?.biz;
  const mid = readJsVar(html, "mid") || input?.mid;
  const idx = readJsVar(html, "idx") || input?.idx;
  const sn = readJsVar(html, "sn") || input?.sn;
  const msgLink = readJsVar(html, "msg_link");
  const imagePost = !contentHtml && /picture_page_info_list|item_show_type\s*=\s*["']?8|appmsg_type\s*=\s*["']?9/i.test(html);
  const contentText = contentHtml ? htmlToText(contentHtml) : "";
  const images = contentHtml ? extractImages(contentHtml) : imagePost ? extractImagePostImages(html) : [];
  const cover = metaContent(html, "og:image") ?? readJsVar(html, "msg_cdn_url");
  if (!images.length && cover) {
    const normalizedCover = normalizeImageUrl(cover);
    if (normalizedCover) images.push(normalizedCover);
  }

  const text = contentText ||
    (imagePost
      ? `${title}\n\n（图片分享，共 ${images.length} 张图片）`
      : title);

  const chksm = input?.chksm || extractChksm(msgLink ?? "") || extractChksm(html);
  const canonicalUrl =
    input?.kind === "short" && input.shortId
      ? `https://${WEIXIN_HOST}/s/${encodeURIComponent(input.shortId)}`
      : buildLongUrl({ biz, mid, idx, sn }) ?? msgLink ?? input?.url ?? "";

  return {
    title,
    accountName: accountName || "微信公众号",
    author: author || accountName || "微信公众号",
    publishedAt: parsePublishedAt(html),
    biz,
    mid,
    idx,
    sn,
    chksm,
    text,
    imageUrls: unique(images).slice(0, 50),
    articleType: imagePost && !contentText ? "image" : "text",
    canonicalUrl,
  };
}

function buildArticleMarkdown(article: WeixinArticle): string {
  const meta = [
    `- 公众号：${article.accountName}`,
    article.author && article.author !== article.accountName ? `- 作者：${article.author}` : "",
    article.publishedAt ? `- 发布时间：${article.publishedAt}` : "",
    `- 原文：${article.canonicalUrl}`,
  ].filter(Boolean);
  const imageLines = article.imageUrls.length
    ? ["", "## 图片", ...article.imageUrls.map((url, index) => `![图片${index + 1}](${url})`)]
    : [];
  return [`# ${article.title}`, "", ...meta, "", article.text, ...imageLines, ""].join("\n");
}

function imageExtension(contentType: string): string {
  if (/png/i.test(contentType)) return ".png";
  if (/gif/i.test(contentType)) return ".gif";
  if (/webp/i.test(contentType)) return ".webp";
  if (/bmp/i.test(contentType)) return ".bmp";
  return ".jpg";
}

async function downloadArticleImages(
  urls: string[],
  destDir: string,
): Promise<{ paths: string[]; notes: string[] }> {
  const paths: string[] = [];
  const notes: string[] = [];
  if (!urls.length) return { paths, notes };

  const imagesDir = path.join(destDir, "images");
  await fs.mkdir(imagesDir, { recursive: true });
  const limited = urls.slice(0, MAX_ARTICLE_IMAGES);
  if (urls.length > limited.length) {
    notes.push(`Only the first ${MAX_ARTICLE_IMAGES} article images were downloaded.`);
  }

  const headers: Record<string, string> = {
    "User-Agent": weixinUserAgent(),
    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    Referer: "https://mp.weixin.qq.com/",
  };

  for (const [index, url] of limited.entries()) {
    try {
      const response = await fetch(url, { headers, redirect: "follow" });
      if (!response.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) continue;
      const extension = imageExtension(response.headers.get("content-type") ?? "");
      const file = path.join(imagesDir, `${String(index + 1).padStart(3, "0")}${extension}`);
      await fs.writeFile(file, buffer);
      paths.push(file);
    } catch {
      // 单张图片失败不影响正文；最后统一记一条提示。
    }
  }
  if (paths.length < limited.length) {
    notes.push(`Downloaded ${paths.length}/${limited.length} article images.`);
  }
  return { paths, notes };
}

export class WeixinAdapter implements PlatformAdapter {
  readonly platform = "weixin";

  canHandle(input: string): boolean {
    return canHandleWeixin(input);
  }

  async resolve(input: string): Promise<VideoRef> {
    const parsed = parseWeixinInput(input);
    if (!parsed) {
      throw new VideoMcpError(
        "Unsupported Weixin input. Use https://mp.weixin.qq.com/s/<id> or a full mp.weixin.qq.com/s?__biz=...&mid=...&idx=...&sn=... article URL.",
        "UNSUPPORTED_URL",
      );
    }
    const cachedRef = refCache.get(parsed.sn ?? parsed.shortId ?? input);
    if (cachedRef) return cachedRef;
    if (!parsed.url) {
      throw new VideoMcpError(
        `Weixin article id ${parsed.sn ?? input} is not in this process cache. Pass the original article URL (a short /s/<id> link is best) so it can be resolved again.`,
        "UNSUPPORTED_URL",
      );
    }

    const page = await loadArticleHtml(parsed, parsed.chksm);
    const article = parseWeixinArticle(page.html, { ...parsed, finalUrl: page.finalUrl });
    const seedUrl =
      parsed.kind === "short"
        ? parsed.url
        : /^https:\/\/mp\.weixin\.qq\.com\/s\/[^?]+/.test(article.canonicalUrl)
          ? article.canonicalUrl
          : undefined;
    if (article.chksm) savePersistedChksm(article.chksm, seedUrl);
    const id = article.sn || parsed.sn || parsed.shortId || `${article.mid ?? "unknown"}-${article.idx ?? "1"}`;
    const extras: Record<string, string | number | boolean | null> = {};
    const addExtra = (key: string, value: string | number | boolean | null | undefined) => {
      if (value !== undefined) extras[key] = value;
    };
    addExtra("biz", article.biz);
    addExtra("mid", article.mid);
    addExtra("idx", article.idx);
    addExtra("sn", article.sn);
    addExtra("chksm", article.chksm);
    addExtra("accountName", article.accountName);
    addExtra("articleAuthor", article.author);
    addExtra("articleType", article.articleType);
    addExtra("imageCount", article.imageUrls.length);

    const ref: VideoRef = {
      platform: this.platform,
      id,
      title: article.title,
      durationSec: 0,
      author: article.accountName || article.author || "微信公众号",
      publishedAt: article.publishedAt,
      pageUrl: article.canonicalUrl || parsed.url,
      extras,
    };
    cachePage(id, page);
    cachePage(parsed.url, page);
    refCache.set(id, ref);
    refCache.set(parsed.sn ?? id, ref);
    return ref;
  }

  async fetchMedia(
    ref: VideoRef,
    destDir: string,
    options?: FetchAssetsOptions,
  ): Promise<MediaFetchResult> {
    const cached = cachedPage(ref.id);
    const preferred = typeof ref.extras?.chksm === "string" ? ref.extras.chksm : undefined;
    const page = cached ?? await loadArticleHtml(
      parseWeixinInput(ref.pageUrl) ?? {
        kind: "long",
        url: ref.pageUrl,
        biz: typeof ref.extras?.biz === "string" ? ref.extras.biz : undefined,
        mid: typeof ref.extras?.mid === "string" ? ref.extras.mid : undefined,
        idx: typeof ref.extras?.idx === "string" ? ref.extras.idx : undefined,
        sn: typeof ref.extras?.sn === "string" ? ref.extras.sn : undefined,
        chksm: preferred,
      },
      preferred,
    );
    cachePage(ref.id, page);

    const article = parseWeixinArticle(page.html, {
      ...(parseWeixinInput(ref.pageUrl) ?? {
        kind: "long",
        url: ref.pageUrl,
        biz: typeof ref.extras?.biz === "string" ? ref.extras.biz : undefined,
        mid: typeof ref.extras?.mid === "string" ? ref.extras.mid : undefined,
        idx: typeof ref.extras?.idx === "string" ? ref.extras.idx : undefined,
        sn: typeof ref.extras?.sn === "string" ? ref.extras.sn : undefined,
        chksm: preferred,
      }),
      finalUrl: page.finalUrl,
    });

    const htmlPath = path.join(destDir, "article.html");
    const markdownPath = path.join(destDir, "article.md");
    await fs.writeFile(htmlPath, page.html, "utf8");
    await fs.writeFile(markdownPath, buildArticleMarkdown(article), "utf8");

    const notes: string[] = [];
    let imagePaths: string[] | undefined;
    if (options?.wantKeyframes) {
      const downloaded = await downloadArticleImages(article.imageUrls, destDir);
      imagePaths = downloaded.paths.length ? downloaded.paths : undefined;
      notes.push(...downloaded.notes);
    }

    return {
      articleText: article.text,
      articlePath: markdownPath,
      articleHtmlPath: htmlPath,
      imagePaths,
      notes,
    };
  }
}
