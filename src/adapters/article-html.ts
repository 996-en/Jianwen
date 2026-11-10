/**
 * 图文类内容的通用工具：HTML → 纯文本、抽图片、下载图片、拼 Markdown。
 * 微信和 B 站专栏/动态都复用它，避免各写一份文本清洗。
 */

import fs from "node:fs/promises";
import path from "node:path";

export function decodeHtmlEntities(text: string): string {
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

/** 统一换行、去行内多余空白、丢弃空行 */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** 读取标签属性值，兼容双引号/单引号/无引号 */
export function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = re.exec(tag);
  if (!match) return undefined;
  return decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? "");
}

/** HTML → 可读纯文本：保留段落换行，丢掉脚本、样式、图片标签 */
export function htmlToText(html: string): string {
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

/**
 * 规范化图片地址：补 https、去掉转义斜杠，只接受 http(s)。
 * `allowHost` 用于限定图床（例如微信只收 qpic.cn）。
 */
export function normalizeImageUrl(raw: string, allowHost?: RegExp): string | undefined {
  let url = decodeHtmlEntities(raw).replace(/\\\//g, "/").trim();
  if (!url || url.startsWith("data:")) return undefined;
  if (url.startsWith("//")) url = `https:${url}`;
  else if (url.startsWith("http://")) url = `https://${url.slice("http://".length)}`;
  if (!/^https?:\/\//i.test(url)) return undefined;
  if (allowHost && !allowHost.test(url)) return undefined;
  return url;
}

/** 按出现顺序抽取正文里的图片地址 */
export function extractImages(
  html: string,
  options: { allowHost?: RegExp; limit?: number } = {},
): string[] {
  const limit = options.limit ?? 50;
  const tags = html.match(/<img\b[^>]*>/gi) ?? [];
  const urls: string[] = [];
  for (const tag of tags) {
    const raw = attr(tag, "data-src") ?? attr(tag, "data-original") ?? attr(tag, "src");
    if (!raw) continue;
    const url = normalizeImageUrl(raw, options.allowHost);
    if (url) urls.push(url);
  }
  return unique(urls).slice(0, limit);
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function imageExtension(contentType: string): string {
  if (/png/i.test(contentType)) return ".png";
  if (/gif/i.test(contentType)) return ".gif";
  if (/webp/i.test(contentType)) return ".webp";
  if (/bmp/i.test(contentType)) return ".bmp";
  return ".jpg";
}

export interface DownloadImagesOptions {
  /** 请求头里的 User-Agent */
  userAgent: string;
  /** 防盗链需要的 Referer */
  referer: string;
  /** 最多下载几张，默认 20 */
  limit?: number;
}

/**
 * 下载正文图片到 `<destDir>/images/001.jpg`。
 * 单张失败只跳过，不影响正文；最后统一给一条提示。
 */
export async function downloadImages(
  urls: string[],
  destDir: string,
  options: DownloadImagesOptions,
): Promise<{ paths: string[]; notes: string[] }> {
  const paths: string[] = [];
  const notes: string[] = [];
  if (!urls.length) return { paths, notes };

  const limit = options.limit ?? 20;
  const limited = urls.slice(0, limit);
  if (urls.length > limited.length) {
    notes.push(`Only the first ${limit} article images were downloaded.`);
  }

  const imagesDir = path.join(destDir, "images");
  await fs.mkdir(imagesDir, { recursive: true });
  const headers: Record<string, string> = {
    "User-Agent": options.userAgent,
    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    Referer: options.referer,
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
      // 单张失败忽略
    }
  }
  if (paths.length < limited.length) {
    notes.push(`Downloaded ${paths.length}/${limited.length} article images.`);
  }
  return { paths, notes };
}

export interface ArticleMarkdownInput {
  title: string;
  /** 元信息行，例如 `- 作者：xxx`；已带前缀 */
  meta?: string[];
  text: string;
  imageUrls?: string[];
}

/** 生成文章 Markdown：标题 + 元信息 + 正文 + 图片清单 */
export function buildArticleMarkdown(article: ArticleMarkdownInput): string {
  const meta = (article.meta ?? []).filter(Boolean);
  const images = article.imageUrls ?? [];
  const imageLines = images.length
    ? ["", "## 图片", ...images.map((url, index) => `![图片${index + 1}](${url})`)]
    : [];
  return [`# ${article.title}`, "", ...meta, "", article.text, ...imageLines, ""].join("\n");
}
