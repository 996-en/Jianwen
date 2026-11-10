/**
 * B 站图文类内容：动态（/opus/<id>）与专栏（/read/cv<id>）。
 *
 * 两者都不是音视频，走的是和微信文章一样的「正文」通道：
 * resolve 时给出标题、作者、发布时间、正文与图片地址，
 * fetch_assets 时写 article.md（专栏另写 article.html），
 * 需要画面时把正文图片下载到 images/，不跑 ffmpeg / ASR。
 *
 * 解析函数是纯函数，方便用固定 JSON 做单元测试。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { bilibiliUserAgent } from "../config.js";
import { VideoMcpError, type FetchAssetsOptions, type VideoRef, type VideoStats } from "../types.js";
import type { MediaFetchResult } from "./types.js";
import { biliErrorMessage, biliGetJson, isRateLimit } from "./bilibili-api.js";
import {
  buildArticleMarkdown,
  downloadImages,
  extractImages,
  htmlToText,
  normalizeImageUrl,
  unique,
} from "./article-html.js";

type Json = Record<string, unknown>;

/** 动态/专栏解析出来的正文与元信息 */
export interface BiliArticleText {
  title: string;
  text: string;
  imageUrls: string[];
  authorName: string;
  authorId?: number;
  publishedAt?: string;
  stats?: VideoStats;
  /** 动态里挂的视频卡片 BV 号（不自动解析） */
  videoBvid?: string;
  /** 这条动态是转发时，被转发的原动态 id */
  reprintOpusId?: string;
  notes: string[];
}

export interface BiliArticleDetail {
  title: string;
  /** 正文 HTML（专栏接口直接给 HTML） */
  contentHtml: string;
  text: string;
  imageUrls: string[];
  authorName: string;
  authorId?: number;
  publishedAt?: string;
  stats?: VideoStats;
}

/* ---------------------------------------------------------------- 通用取值 */

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
 * 把 opus/detail 的 modules 归一成「MODULE_TYPE_xxx → 模块」的 Map。
 * 注意两种形状：opus/detail 给数组（元素带 module_type），
 * 动态详情接口给对象（键是 module_author 这种小写名）。
 */
function moduleMap(item: Json): Map<string, Json> {
  const map = new Map<string, Json>();
  const modules = item.modules;
  if (Array.isArray(modules)) {
    for (const raw of modules) {
      const module = asRecord(raw);
      const type = asString(module?.module_type);
      if (module && type) map.set(type, module);
    }
  } else {
    for (const [key, value] of Object.entries(asRecord(modules) ?? {})) {
      const module = asRecord(value);
      if (!module) continue;
      const name = key.replace(/^module_/, "").toUpperCase();
      // 对象形状里键就是 module_author，值直接是模块本体；
      // 统一包一层 { module_author: {...} }，让后面的取值逻辑两种形状都能用。
      map.set(`MODULE_TYPE_${name}`, { [key]: module });
    }
  }
  return map;
}

/** 互动数：每个字段长成 `{ count: number }`，可缺省 */
function statCount(moduleStat: Json | undefined, key: string): number | undefined {
  const entry = asRecord(moduleStat?.[key]);
  return asNumber(entry?.count);
}

/* -------------------------------------------------------------- 动态 opus */

/** 段落里的文字：`text.nodes[].word.words`；互动抽奖、表情等富文本节点放在 `rich` 里 */
function paragraphText(paragraph: Json): string {
  const type = asNumber(paragraph.para_type) ?? 1;
  if (type === 2) return "";

  const nodes = asArray(asRecord(paragraph.text)?.nodes);
  const words = nodes
    .map((node) => {
      const rec = asRecord(node);
      const word = asRecord(rec?.word);
      const rich = asRecord(rec?.rich);
      return (
        asString(word?.words) ??
        asString(rich?.text) ??
        asString(rich?.orig_text) ??
        asString(asRecord(rich?.emoji)?.text) ??
        ""
      );
    })
    .join("")
    .trim();
  if (words) return words;

  // 标题段、引用段、代码段各有自己的字段
  const heading = asRecord(paragraph.heading);
  if (asString(heading?.text)) return asString(heading?.text)!;
  const quote = asRecord(paragraph.blockquote);
  if (asString(quote?.text)) return asString(quote?.text)!;
  const code = asRecord(paragraph.code);
  if (asString(code?.content)) return asString(code?.content)!;
  const card = asRecord(paragraph.link_card);
  const jumpUrl = asString(card?.jump_url);
  if (jumpUrl) return `链接：${jumpUrl}`;
  return "";
}

/** 图片段：`pic.pics[].url` */
function paragraphImages(paragraph: Json): string[] {
  return asArray(asRecord(paragraph.pic)?.pics)
    .map((pic) => asString(asRecord(pic)?.url))
    .map((url) => (url ? normalizeImageUrl(url) : undefined))
    .filter((url): url is string => Boolean(url));
}

/**
 * 解析 opus/detail 的响应。
 * 同时兼容动态详情接口的形状：正文在 module_dynamic.desc / major.opus.summary。
 */
export function parseOpusDetail(payload: unknown): BiliArticleText | null {
  const item = asRecord(asRecord(asRecord(payload)?.data)?.item);
  if (!item) return null;

  const modules = moduleMap(item);
  const basic = asRecord(item.basic);
  const titleModule = asRecord(modules.get("MODULE_TYPE_TITLE")?.module_title);
  const authorModule = asRecord(modules.get("MODULE_TYPE_AUTHOR")?.module_author);
  const statModule = asRecord(modules.get("MODULE_TYPE_STAT")?.module_stat);
  const contentModule = asRecord(modules.get("MODULE_TYPE_CONTENT")?.module_content);
  const topModule = asRecord(modules.get("MODULE_TYPE_TOP")?.module_top);
  const dynamicModule = asRecord(modules.get("MODULE_TYPE_DYNAMIC")?.module_dynamic);
  const reprintModule = asRecord(
    modules.get("MODULE_TYPE_REPRINT_SOURCE")?.module_reprint_source,
  );

  const lines: string[] = [];
  const images: string[] = [];
  for (const raw of asArray(contentModule?.paragraphs)) {
    const paragraph = asRecord(raw);
    if (!paragraph) continue;
    images.push(...paragraphImages(paragraph));
    const line = paragraphText(paragraph);
    if (line) lines.push(line);
  }

  // 旧形状兜底：正文是一串 rich_text_nodes，图片在 major.opus.pics / major.draw.items
  if (!lines.length) {
    const desc = asRecord(dynamicModule?.desc);
    const richText = asArray(desc?.rich_text_nodes)
      .map((node) => asString(asRecord(node)?.text) ?? "")
      .join("")
      .trim();
    if (richText) lines.push(richText);
  }
  if (!images.length) {
    const major = asRecord(dynamicModule?.major);
    for (const pic of asArray(asRecord(major?.opus)?.pics)) {
      const url = asString(asRecord(pic)?.url);
      if (url && normalizeImageUrl(url)) images.push(normalizeImageUrl(url)!);
    }
    for (const entry of asArray(asRecord(major?.draw)?.items)) {
      const url = asString(asRecord(entry)?.src);
      if (url && normalizeImageUrl(url)) images.push(normalizeImageUrl(url)!);
    }
  }

  const videoBvid =
    asString(asRecord(asRecord(asRecord(topModule?.display)?.video))?.bvid) ??
    asString(asRecord(asRecord(dynamicModule?.major)?.archive)?.bvid) ??
    undefined;
  const reprintOpusId = asString(reprintModule?.id_str) ?? asString(reprintModule?.rid_str);

  const rawTitle = asString(titleModule?.text) ?? asString(basic?.title) ?? "";
  const title = rawTitle.replace(/\s*-\s*哔哩哔哩$/, "").trim();

  const notes: string[] = [];
  if (reprintOpusId) {
    notes.push(
      `该动态是转发，原文：https://www.bilibili.com/opus/${reprintOpusId}（未自动递归解析）`,
    );
  }
  if (videoBvid) {
    notes.push(
      `动态内嵌视频卡片 ${videoBvid}，如需视频请单独解析 https://www.bilibili.com/video/${videoBvid}`,
    );
  }

  let text = lines.join("\n").trim();
  if (!text && videoBvid) {
    text = `（该动态只有视频卡片，没有正文）\n视频地址：https://www.bilibili.com/video/${videoBvid}`;
  }
  if (!text && images.length) {
    text = `（该动态只有图片，共 ${images.length} 张）`;
  }

  // 标题只拿到「XX的动态」这种壳时，改用正文首行
  const finalTitle =
    !title || /的动态$/.test(title) || /^B 站动态 /.test(title)
      ? firstLine(text, title || "")
      : title;

  return {
    title: finalTitle,
    text,
    imageUrls: unique(images).slice(0, 50),
    authorName: asString(authorModule?.name) ?? "B站用户",
    authorId: asNumber(authorModule?.mid),
    publishedAt: unixToIso(authorModule?.pub_ts),
    stats: statModule
      ? {
          comments: statCount(statModule, "comment"),
          likes: statCount(statModule, "like"),
          shares: statCount(statModule, "forward"),
          coins: statCount(statModule, "coin"),
          favorites: statCount(statModule, "favorite"),
        }
      : undefined,
    videoBvid,
    reprintOpusId,
    notes,
  };
}

function opusApiError(json: { code?: number; message?: string }, opusId: string): VideoMcpError {
  const code = json.code;
  const message = biliErrorMessage(json, `code ${code ?? "unknown"}`);
  if (code === -352) {
    return new VideoMcpError(
      `动态接口被 B 站风控（-352），稍后重试或换网络环境。opus/${opusId}`,
      "COOKIE_REQUIRED",
    );
  }
  if (code === -404 || code === 11010) {
    return new VideoMcpError(`动态不存在或已删除：opus/${opusId}`, "NOT_FOUND");
  }
  // 4101152：动态不可见（已删除、仅作者可见，或需要登录才能看）
  if (code === 4101152 || message.includes("动态不可见")) {
    return new VideoMcpError(
      `动态不可见（可能已删除、仅作者可见或需要登录）：opus/${opusId}`,
      "NOT_FOUND",
    );
  }
  if (isRateLimit(code, message)) {
    return new VideoMcpError(
      `B 站限流（${code ?? "-509"}：${message}），请等几十秒后重试`,
      "DOWNLOAD_FAILED",
    );
  }
  return new VideoMcpError(`解析动态失败：${message}（opus/${opusId}）`, "DOWNLOAD_FAILED");
}

/** 拉取一条动态（opus）的完整正文；图片/视频卡类动态在 opus 接口里 item 为 null，此时返回 null 交给动态兜底 */
export async function fetchOpusText(opusId: string): Promise<BiliArticleText | null> {
  const url = `https://api.bilibili.com/x/polymer/web-dynamic/v1/opus/detail?id=${encodeURIComponent(opusId)}`;
  const json = await biliGetJson<{ code?: number; message?: string; data?: unknown }>(url);
  if (json.code !== 0) throw opusApiError(json, opusId);

  const parsed = parseOpusDetail(json);
  if (!parsed) return null;
  if (!parsed.title) parsed.title = `B 站动态 ${opusId}`;
  return parsed;
}

export async function resolveOpusRef(opusId: string): Promise<VideoRef> {
  const content = await fetchOpusText(opusId);
  if (!content) throw new VideoMcpError(`动态不存在或已删除：opus/${opusId}`, "NOT_FOUND");
  return opusTextToRef(content, opusId);
}

function opusTextToRef(content: BiliArticleText, opusId: string): VideoRef {
  const extras: Record<string, string | number | boolean | null> = {
    kind: "opus",
    opusId,
    imageCount: content.imageUrls.length,
  };
  if (content.videoBvid) extras.videoBvid = content.videoBvid;
  if (content.reprintOpusId) extras.reprintOpusId = content.reprintOpusId;

  return {
    platform: "bilibili",
    id: `opus${opusId}`,
    title: content.title,
    durationSec: 0,
    author: content.authorName,
    authorId: content.authorId,
    publishedAt: content.publishedAt,
    stats: content.stats,
    pageUrl: `https://www.bilibili.com/opus/${opusId}`,
    extras,
  };
}

/* --------------------------------------- 动态兜底（web-dynamic/v1/detail） */

/**
 * 不是所有动态都能用 opus 接口拿到内容：
 * 「投稿视频」「转发」这类动态 opus/detail 会返回 item:null，
 * 必须改问 web-dynamic/v1/detail（需要 buvid 指纹，否则 -352）。
 */
export interface BiliDynamicContent {
  kind: "video" | "article" | "image" | "text" | "unsupported";
  bvid?: string;
  cvId?: string;
  title: string;
  text: string;
  imageUrls: string[];
  authorName: string;
  authorId?: number;
  publishedAt?: string;
  stats?: VideoStats;
  notes: string[];
  /** 转发动态里原动态的 id，用来补全原动态正文 */
  origDynamicId?: string;
  origAuthorName?: string;
  needsOrigText?: boolean;
}

function nodeText(node: unknown): string {
  const rec = asRecord(node);
  if (!rec) return "";
  const direct = asString(rec.text);
  if (direct) return direct;
  return asArray(rec.rich_text_nodes)
    .map((n) => asString(asRecord(n)?.text) ?? asString(asRecord(n)?.orig_text) ?? "")
    .filter(Boolean)
    .join("");
}

function majorImages(major: unknown): string[] {
  const rec = asRecord(major);
  const urls: string[] = [];
  for (const item of asArray(asRecord(rec?.draw)?.items)) {
    const src = asString(asRecord(item)?.src);
    if (src) urls.push(normalizeImageUrl(src) ?? src);
  }
  for (const pic of asArray(asRecord(rec?.opus)?.pics)) {
    const url = asString(asRecord(pic)?.url);
    if (url) urls.push(normalizeImageUrl(url) ?? url);
  }
  return urls;
}

function firstLine(text: string, fallback: string): string {
  const line = text
    .split("\n")
    .map((t) => t.trim())
    .find(Boolean);
  if (!line) return fallback;
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

/** 解析 web-dynamic/v1/detail 的 data.item（modules 是对象形状） */
export function parseDynamicDetail(payload: unknown): BiliDynamicContent | null {
  const data = asRecord(asRecord(payload)?.data);
  const item = asRecord(data?.item);
  if (!item) return null;
  const dynamicId = asString(item.id_str) ?? "";
  const modules = asRecord(item.modules);
  const author = asRecord(modules?.module_author);
  const dynamic = asRecord(modules?.module_dynamic);
  const stat = asRecord(modules?.module_stat);
  const major = asRecord(dynamic?.major);
  const majorType = asString(major?.type) ?? "";
  const authorName = asString(author?.name) ?? "B站用户";
  const authorId = asNumber(author?.mid);
  const publishedAt = unixToIso(author?.pub_ts);
  const stats = stat
    ? {
        comments: statCount(stat, "comment"),
        likes: statCount(stat, "like"),
        shares: statCount(stat, "forward"),
      }
    : undefined;
  const notes: string[] = [];

  const ownText = nodeText(dynamic?.desc);
  const ownImages = majorImages(major);

  // 转发动态：把自己写的话 + 原动态文字拼在一起
  const orig = asRecord(item.orig);
  const origModules = asRecord(orig?.modules);
  const origDynamic = asRecord(origModules?.module_dynamic);
  const origAuthor = asRecord(origModules?.module_author);
  const origText = nodeText(origDynamic?.desc);
  const origImages = majorImages(origDynamic?.major);
  const origName = asString(origAuthor?.name);
  const origDynamicId = asString(orig?.id_str) ?? undefined;

  let text = ownText;
  let needsOrigText = false;
  if (origText) {
    text = [ownText, `—— 转发自 ${origName ? `@${origName}` : "原作者"} ——`, origText]
      .filter(Boolean)
      .join("\n\n");
    notes.push("这是转发动态，正文里带上了原动态的文字。");
  } else if (origDynamicId || origImages.length) {
    // 原动态的 desc 有时是 null，正文要靠 origDynamicId 再去 opus 接口拿
    needsOrigText = Boolean(origDynamicId);
    notes.push("这是转发动态，正文里带上了原动态的文字。");
  }
  const images = unique([...ownImages, ...origImages]).slice(0, 50);
  const origExtras = { origDynamicId, origAuthorName: origName, needsOrigText };

  // 投稿视频卡：真正的内容是背后的那个视频
  const archive = asRecord(major?.archive);
  const bvid = asString(archive?.bvid);
  if (majorType === "MAJOR_TYPE_ARCHIVE" && bvid) {
    notes.push(`这条动态是投稿视频卡片，已切换到视频 ${bvid}。`);
    return {
      kind: "video",
      bvid,
      title: asString(archive?.title) ?? firstLine(text, `B 站动态 ${dynamicId}`),
      text,
      imageUrls: images,
      authorName,
      authorId,
      publishedAt,
      stats,
      notes,
      ...origExtras,
    };
  }

  // 专栏卡：直接当专栏处理
  const article = asRecord(major?.article);
  const cvId = asString(article?.id);
  if (majorType === "MAJOR_TYPE_ARTICLE" && cvId) {
    notes.push(`这条动态是专栏卡片，已切换到专栏 cv${cvId}。`);
    return {
      kind: "article",
      cvId,
      title: asString(article?.title) ?? firstLine(text, `B 站动态 ${dynamicId}`),
      text,
      imageUrls: images,
      authorName,
      authorId,
      publishedAt,
      stats,
      notes,
      ...origExtras,
    };
  }

  // 直播推荐卡之类：没有可下载内容
  if (majorType === "MAJOR_TYPE_LIVE_RCMD" || majorType === "MAJOR_TYPE_LIVE") {
    notes.push("这是一条直播推荐动态，没有可下载的内容。");
    return {
      kind: "unsupported",
      title: firstLine(text, `B 站动态 ${dynamicId}`),
      text,
      imageUrls: images,
      authorName,
      authorId,
      publishedAt,
      stats,
      notes,
    };
  }

  const title = firstLine(text, `B 站动态 ${dynamicId}`);
  if (images.length) {
    notes.push(`动态里有 ${images.length} 张图片。`);
    return {
      kind: "image",
      title,
      text,
      imageUrls: images,
      authorName,
      authorId,
      publishedAt,
      stats,
      notes,
      ...origExtras,
    };
  }
  return {
    kind: "text",
    title,
    text,
    imageUrls: images,
    authorName,
    authorId,
    publishedAt,
    stats,
    notes,
    ...origExtras,
  };
}

/** 拉取动态详情（图片/视频卡/转发类动态的兜底通道） */
export async function fetchDynamicDetail(dynamicId: string): Promise<BiliDynamicContent | null> {
  const url = `https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${encodeURIComponent(dynamicId)}`;
  const json = await biliGetJson<{ code?: number; message?: string; data?: unknown }>(url);
  if (json.code !== 0) throw opusApiError(json, dynamicId);
  const parsed = parseDynamicDetail(json);
  if (!parsed) return null;
  if (!parsed.title) parsed.title = `B 站动态 ${dynamicId}`;

  // 转发动态：原动态的 desc 常常是 null，再去 opus 接口把原动态正文补上
  if (parsed.needsOrigText && parsed.origDynamicId) {
    try {
      const orig = await fetchOpusText(parsed.origDynamicId);
      if (orig?.text) {
        parsed.text = [
          parsed.text,
          `—— ${parsed.origAuthorName ? `@${parsed.origAuthorName}` : "原作者"} 的原动态 ——`,
          orig.text,
        ]
          .filter(Boolean)
          .join("\n\n");
        parsed.notes.push(`原动态正文来自 opus/${parsed.origDynamicId}。`);
      }
    } catch {
      parsed.notes.push(
        `原动态 opus/${parsed.origDynamicId} 的正文没取到，可以单独解析它。`,
      );
    }
  }

  return parsed;
}

function dynamicTextToRef(content: BiliDynamicContent, dynamicId: string): VideoRef {
  return {
    platform: "bilibili",
    id: `opus${dynamicId}`,
    title: content.title,
    durationSec: 0,
    author: content.authorName,
    authorId: content.authorId,
    publishedAt: content.publishedAt,
    stats: content.stats,
    pageUrl: `https://www.bilibili.com/opus/${dynamicId}`,
    extras: {
      kind: "opus",
      opusId: dynamicId,
      imageCount: content.imageUrls.length,
      dynamicKind: content.kind,
    },
  };
}

/**
 * 动态统一入口：先问 opus 接口，拿不到再问动态详情接口。
 * 如果是投稿视频卡，就交给调用方传进来的 resolveVideo 去当普通视频解析。
 */
export async function resolveDynamicRef(
  dynamicId: string,
  resolveVideo: (bvid: string) => Promise<VideoRef>,
): Promise<VideoRef> {
  const opus = await fetchOpusText(dynamicId);
  if (opus) return opusTextToRef(opus, dynamicId);

  const dyn = await fetchDynamicDetail(dynamicId);
  if (!dyn) {
    throw new VideoMcpError(`动态不存在或已删除：opus/${dynamicId}`, "NOT_FOUND");
  }
  if (dyn.kind === "video" && dyn.bvid) {
    const videoRef = await resolveVideo(dyn.bvid);
    return { ...videoRef, extras: { ...(videoRef.extras ?? {}), fromDynamic: dynamicId } };
  }
  if (dyn.kind === "article" && dyn.cvId) {
    const articleRef = await resolveArticleRef(dyn.cvId);
    return { ...articleRef, extras: { ...(articleRef.extras ?? {}), fromDynamic: dynamicId } };
  }
  if (dyn.kind === "unsupported") {
    throw new VideoMcpError(
      `这条动态里没有可解析的内容（${dyn.notes.join(" ")}）：${dynamicId}`,
      "UNSUPPORTED_URL",
    );
  }
  return dynamicTextToRef(dyn, dynamicId);
}

/* ------------------------------------------------------------------ 专栏 */

export function parseArticleDetail(payload: unknown): BiliArticleDetail | null {
  const data = asRecord(asRecord(payload)?.data);
  if (!data) return null;
  const author = asRecord(data.author);
  const contentHtml = asString(data.content) ?? "";
  const stats = asRecord(data.stats);

  // 正文里的图片按出现顺序更贴近阅读顺序，拿不到再退回 image_urls
  const images = extractImages(contentHtml, { allowHost: /hdslb\.com/i });
  const fallback = asArray(data.image_urls)
    .map((url) => asString(url))
    .map((url) => (url ? normalizeImageUrl(url) : undefined))
    .filter((url): url is string => Boolean(url));

  return {
    title: asString(data.title) ?? "",
    contentHtml,
    text: htmlToText(contentHtml),
    imageUrls: unique(images.length ? images : fallback).slice(0, 50),
    authorName: asString(author?.name) ?? "B站用户",
    authorId: asNumber(author?.mid),
    publishedAt: unixToIso(data.publish_time ?? data.ctime),
    stats: stats
      ? {
          views: asNumber(stats.view),
          favorites: asNumber(stats.favorite),
          likes: asNumber(stats.like),
          coins: asNumber(stats.coin),
          comments: asNumber(stats.reply),
          shares: asNumber(stats.share),
        }
      : undefined,
  };
}

function articleApiError(json: { code?: number; message?: string }, cvId: string): VideoMcpError {
  const code = json.code;
  const message = biliErrorMessage(json, `code ${code ?? "unknown"}`);
  if (code === -352 || code === -403) {
    return new VideoMcpError(
      `专栏接口被 B 站风控或需要登录（${code}）：${message}。cv${cvId}`,
      "COOKIE_REQUIRED",
    );
  }
  if (isRateLimit(code, message)) {
    return new VideoMcpError(`B 站限流（${code ?? "-509"}：${message}），请等几十秒后重试`, "DOWNLOAD_FAILED");
  }
  if (code === -404) return new VideoMcpError(`专栏不存在：cv${cvId}`, "NOT_FOUND");
  return new VideoMcpError(`解析专栏失败：${message}（cv${cvId}）`, "DOWNLOAD_FAILED");
}

/** 拉取一篇专栏的正文（这个接口要求 Cookie 里至少有 buvid） */
export async function fetchArticleDetail(cvId: string): Promise<BiliArticleDetail> {
  const url = `https://api.bilibili.com/x/article/view?id=${encodeURIComponent(cvId)}`;
  const json = await biliGetJson<{ code?: number; message?: string; data?: unknown }>(url);
  if (json.code !== 0) throw articleApiError(json, cvId);

  const parsed = parseArticleDetail(json);
  if (!parsed) throw new VideoMcpError(`专栏不存在：cv${cvId}`, "NOT_FOUND");
  if (!parsed.title) parsed.title = `B 站专栏 cv${cvId}`;
  return parsed;
}

export async function resolveArticleRef(cvId: string): Promise<VideoRef> {
  const article = await fetchArticleDetail(cvId);
  return {
    platform: "bilibili",
    id: `cv${cvId}`,
    title: article.title,
    durationSec: 0,
    author: article.authorName,
    authorId: article.authorId,
    publishedAt: article.publishedAt,
    stats: article.stats,
    pageUrl: `https://www.bilibili.com/read/cv${cvId}`,
    extras: { kind: "article", cvId, imageCount: article.imageUrls.length },
  };
}

/* ------------------------------------------------- 图文类 fetch_assets 落地 */

function extrasOf(ref: VideoRef): Record<string, unknown> {
  return (ref.extras ?? {}) as Record<string, unknown>;
}

function noteBlock(title: string, meta: string[], text: string, images: string[]): string {
  return buildArticleMarkdown({
    title,
    meta,
    text,
    imageUrls: images,
  });
}

/**
 * 图文类（动态/专栏）的 fetch_assets：
 * 写 article.md（专栏另写 article.html），需要画面时下载正文图片。
 */
export async function fetchBilibiliTextMedia(
  ref: VideoRef,
  destDir: string,
  options: FetchAssetsOptions = {},
): Promise<MediaFetchResult> {
  const extras = extrasOf(ref);
  const kind = extras.kind === "article" ? "article" : "opus";
  const notes: string[] = [];
  let title = ref.title;
  let text = "";
  let imageUrls: string[] = [];
  let contentHtml: string | undefined;
  let publishedAt = ref.publishedAt;
  let author = ref.author;
  let pageUrl = ref.pageUrl;

  if (kind === "article") {
    const cvId = String(extras.cvId ?? ref.id.replace(/^cv/, ""));
    const article = await fetchArticleDetail(cvId);
    title = article.title || title;
    text = article.text;
    imageUrls = article.imageUrls;
    contentHtml = article.contentHtml;
    publishedAt = article.publishedAt ?? publishedAt;
    author = article.authorName || author;
    pageUrl = `https://www.bilibili.com/read/cv${cvId}`;
    notes.push("专栏正文来自 article/view 接口，图片按正文顺序排列。");
  } else {
    const opusId = String(extras.opusId ?? ref.id.replace(/^opus/, ""));
    const opus = await fetchOpusText(opusId);
    if (opus) {
      title = opus.title || title;
      text = opus.text;
      imageUrls = opus.imageUrls;
      publishedAt = opus.publishedAt ?? publishedAt;
      author = opus.authorName || author;
      pageUrl = `https://www.bilibili.com/opus/${opusId}`;
      notes.push(...opus.notes);
    } else {
      // 图片/转发类动态只能走动态详情接口
      const dyn = await fetchDynamicDetail(opusId);
      if (!dyn) throw new VideoMcpError(`动态不存在或已删除：opus/${opusId}`, "NOT_FOUND");
      title = dyn.title || title;
      text = dyn.text;
      imageUrls = dyn.imageUrls;
      publishedAt = dyn.publishedAt ?? publishedAt;
      author = dyn.authorName || author;
      pageUrl = `https://www.bilibili.com/opus/${opusId}`;
      notes.push(...dyn.notes);
    }
  }

  const meta = [
    `- 作者：${author}`,
    publishedAt ? `- 发布时间：${publishedAt}` : "",
    `- 原文：${pageUrl}`,
  ].filter(Boolean);

  const markdownPath = path.join(destDir, "article.md");
  await fs.writeFile(markdownPath, noteBlock(title, meta, text, imageUrls), "utf8");

  let articleHtmlPath: string | undefined;
  if (contentHtml !== undefined) {
    articleHtmlPath = path.join(destDir, "article.html");
    await fs.writeFile(
      articleHtmlPath,
      `<html><head><meta charset="utf-8"><title>${title}</title></head><body>\n${contentHtml}\n</body></html>`,
      "utf8",
    );
  }

  let imagePaths: string[] | undefined;
  if (options.wantKeyframes) {
    const downloaded = await downloadImages(imageUrls, destDir, {
      userAgent: bilibiliUserAgent(),
      referer: "https://www.bilibili.com/",
    });
    imagePaths = downloaded.paths.length ? downloaded.paths : undefined;
    notes.push(...downloaded.notes);
  }

  return {
    articleText: text,
    articlePath: markdownPath,
    articleHtmlPath,
    imagePaths,
    notes,
  };
}

