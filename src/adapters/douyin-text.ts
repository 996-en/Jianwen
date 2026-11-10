/**
 * 抖音「不是视频」的两种作品：图文（images）和长文（article_info）。
 *
 * 两者都没有可下载的 mp4，网页端也没有字幕轨道，因此不进入 ASR / ffmpeg：
 * 正文直接落成 article.md，图片默认不下载（用户明确要图时由 wantKeyframes 打开）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { douyinUserAgent } from "../config.js";
import type { FetchAssetsOptions, VideoRef } from "../types.js";
import { buildArticleMarkdown, downloadImages } from "./article-html.js";
import type { MediaFetchResult } from "./types.js";

/** 一次最多下载多少张图片；抖音图文常见 3–20 张，40 足够覆盖长图文 */
const IMAGE_LIMIT = 40;

export interface DouyinImage {
  uri?: string;
  url_list?: string[];
  download_url_list?: string[];
  width?: number;
  height?: number;
}

export interface DouyinArticleInfo {
  article_id?: string;
  article_title?: string;
  article_type?: number;
  read_time?: number;
  /** 注意：接口给的是 JSON 字符串，里面才是 markdown 正文 */
  article_content?: unknown;
}

/** 只描述图文/长文需要读的字段，douyin.ts 的视频结构可以直接传进来 */
export interface DouyinTextAweme {
  aweme_id?: string;
  desc?: string;
  images?: DouyinImage[] | null;
  article_info?: DouyinArticleInfo | Record<string, unknown> | string | null;
}

export interface DouyinArticle {
  title?: string;
  articleId?: string;
  readTime?: number;
  /** 已经去掉图片尺寸尾巴（`width=… height=…`）的 Markdown，可直接阅读 */
  markdown: string;
  /** 接口返回的原始 Markdown，原样保存到 article.original.md */
  rawMarkdown: string;
  abstract?: string;
  imageUrls: string[];
}

/** 正文里的图片地址；抖音长文把图片直接写在 markdown 里 */
const IMAGE_URL_RE = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)/g;
/** 抖音长文的图片语法带 `width=1053 height=400` 尾巴，标准 Markdown 渲染器会把它当成图片标题 */
const IMAGE_SIZE_TAIL_RE = /(!\[[^\]]*\]\([^)\s]+)\s+[^)]*\)/g;

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * article_info.article_content 是「JSON 字符串的 JSON 字符串」：
 * 外层对象里 article_content 是 string，解析后才有 markdown。
 * 少数返回把 markdown 直接放在 article_info 上，这里一并兼容。
 */
function articleBody(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === "string") return parseJsonObject(raw);
  if (typeof raw !== "object") return null;
  const content = (raw as DouyinArticleInfo).article_content;
  if (typeof content === "string") return parseJsonObject(content);
  if (content && typeof content === "object") return content as Record<string, unknown>;
  if (typeof (raw as Record<string, unknown>).markdown === "string") {
    return raw as Record<string, unknown>;
  }
  return null;
}

export function extractImageUrls(markdown: string): string[] {
  const out: string[] = [];
  for (const match of markdown.matchAll(IMAGE_URL_RE)) {
    const url = match[1];
    if (typeof url === "string" && !out.includes(url)) out.push(url);
  }
  return out;
}

export function cleanMarkdown(markdown: string): string {
  return markdown.replace(IMAGE_SIZE_TAIL_RE, "$1)").replace(/\r\n/g, "\n").trim();
}

/** 长文作品：拿不到正文（已删除/需要登录/格式变了）时返回 null */
export function parseArticleInfo(raw: unknown): DouyinArticle | null {
  const body = articleBody(raw);
  if (!body) return null;

  const rawMarkdown = typeof body.markdown === "string" ? body.markdown : "";
  const abstract =
    typeof body.long_article_abstract === "string" ? body.long_article_abstract.trim() : "";
  if (!rawMarkdown.trim() && !abstract) return null;

  const info = (raw && typeof raw === "object" ? raw : {}) as DouyinArticleInfo;
  const bodyId = body.article_id;
  const articleId =
    typeof bodyId === "string" || typeof bodyId === "number"
      ? String(bodyId)
      : typeof info.article_id === "string"
        ? info.article_id
        : undefined;
  const bodyReadTime = body.read_time;
  const readTime =
    typeof info.read_time === "number"
      ? info.read_time
      : typeof bodyReadTime === "number"
        ? bodyReadTime
        : undefined;

  return {
    title: info.article_title?.trim() || undefined,
    articleId,
    readTime,
    markdown: cleanMarkdown(rawMarkdown || abstract),
    rawMarkdown,
    abstract: abstract || undefined,
    imageUrls: extractImageUrls(rawMarkdown),
  };
}

/**
 * 图文作品的图片地址：url_list 是无水印原图，download_url_list 带水印，优先前者。
 * 网页端图文没有视频，`video.play_addr` 往往是配乐 mp3，不能当作品内容用。
 */
export function imageUrlsOf(aweme: DouyinTextAweme): string[] {
  const out: string[] = [];
  for (const image of aweme.images ?? []) {
    const url = (image.url_list ?? [])[0] ?? (image.download_url_list ?? [])[0];
    if (typeof url === "string" && /^https?:\/\//.test(url) && !out.includes(url)) out.push(url);
  }
  return out;
}

/** 按详情数据判断这是不是文字类作品；是视频就返回 null */
export function douyinTextKind(aweme: DouyinTextAweme): "article" | "images" | null {
  if (parseArticleInfo(aweme.article_info)) return "article";
  if (imageUrlsOf(aweme).length > 0) return "images";
  return null;
}

/**
 * 把图文/长文落成 article.md（可选 article.original.md、article.json），
 * 图片只在 options.wantKeyframes === true 时下载。
 */
export async function fetchDouyinTextMedia(
  aweme: DouyinTextAweme,
  ref: VideoRef,
  destDir: string,
  options?: FetchAssetsOptions,
): Promise<MediaFetchResult> {
  const article = parseArticleInfo(aweme.article_info);
  const imageUrls = article ? article.imageUrls : imageUrlsOf(aweme);
  const text = article ? article.markdown : (aweme.desc ?? "").trim();
  const notes: string[] = [];

  if (article) {
    notes.push(
      "Douyin long article: text comes from article_info.markdown; ASR and ffmpeg were skipped.",
    );
    notes.push("原始 Markdown 已保存到 article.original.md，可直接复用；结构化信息见 article.json。");
    if (!text) notes.push("长文正文为空：可能需要在浏览器里打开一次作品后重试，或换完整 Cookie。");
  } else {
    notes.push(
      "Douyin image post: the caption is only a title/description, the real content is in the images.",
    );
    if (imageUrls.length) {
      notes.push(
        `共 ${imageUrls.length} 张图片，默认不下载；需要看图时把 wantKeyframes 设为 true（B 站、微信图文同理）。`,
      );
    }
  }

  const meta = [
    `- 作者：${ref.author}`,
    ref.publishedAt ? `- 发布时间：${ref.publishedAt}` : "",
    `- 原文：${ref.pageUrl}`,
    `- 类型：${article ? "长文" : "图文"}${imageUrls.length ? `（${imageUrls.length} 张图片）` : ""}`,
  ].filter(Boolean);

  const articlePath = path.join(destDir, "article.md");
  await fs.writeFile(
    articlePath,
    buildArticleMarkdown({ title: ref.title, meta, text, imageUrls }),
    "utf8",
  );

  let articleSourcePath: string | undefined;
  let articleJsonPath: string | undefined;
  if (article) {
    articleSourcePath = path.join(destDir, "article.original.md");
    await fs.writeFile(articleSourcePath, article.rawMarkdown || article.markdown, "utf8");
    articleJsonPath = path.join(destDir, "article.json");
    await fs.writeFile(
      articleJsonPath,
      JSON.stringify(aweme.article_info ?? article, null, 2),
      "utf8",
    );
  } else if (imageUrls.length) {
    // 图文没有 markdown 原文，图片地址就是唯一的结构化信息，单独存一份便于别的工具复用
    articleJsonPath = path.join(destDir, "article.json");
    await fs.writeFile(
      articleJsonPath,
      JSON.stringify(
        { aweme_id: aweme.aweme_id ?? ref.id, title: ref.title, author: ref.author, pageUrl: ref.pageUrl, imageUrls },
        null,
        2,
      ),
      "utf8",
    );
  }

  let imagePaths: string[] | undefined;
  if (options?.wantKeyframes === true && imageUrls.length) {
    const downloaded = await downloadImages(imageUrls, destDir, {
      userAgent: douyinUserAgent(),
      referer: "https://www.douyin.com/",
      limit: IMAGE_LIMIT,
    });
    notes.push(...downloaded.notes);
    if (downloaded.paths.length) imagePaths = downloaded.paths;
  }

  return { articleText: text, articlePath, articleSourcePath, articleJsonPath, imagePaths, notes };
}
