/**
 * B 站接口取数层：统一 User-Agent / Referer，带匿名指纹（buvid3/buvid4），
 * 并对风控码（-352 风控、-509 限流）做一次退避重试。
 *
 * 这些接口大多数不登录也能读；少数（专栏、部分动态接口）要求 Cookie 里
 * 至少有 buvid，所以这里只在需要时向 finger/spi 申请一个匿名指纹。
 */

import { bilibiliUserAgent } from "../config.js";
import { VideoMcpError } from "../types.js";

export const BILI_REFERER = "https://www.bilibili.com/";

let buvidCookie: string | undefined;
let buvidFailedAt = 0;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function biliHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "User-Agent": bilibiliUserAgent(),
    Referer: BILI_REFERER,
    ...(extra ?? {}),
  };
}

/**
 * 匿名指纹：`finger/spi` 给出 b_3/b_4，拼成 `buvid3=...; buvid4=...`。
 * 失败不抛错（只降级成无 Cookie），并冷却 60 秒，避免每个请求都去打一次。
 */
export async function bilibiliBuvidCookie(): Promise<string | undefined> {
  if (buvidCookie) return buvidCookie;
  if (buvidFailedAt && Date.now() - buvidFailedAt < 60_000) return undefined;
  try {
    const res = await fetch("https://api.bilibili.com/x/frontend/finger/spi", {
      headers: biliHeaders(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { b_3?: string; b_4?: string } };
    const b3 = json.data?.b_3;
    const b4 = json.data?.b_4;
    if (!b3) throw new Error("no buvid3 in finger/spi response");
    buvidCookie = b4 ? `buvid3=${b3}; buvid4=${b4}` : `buvid3=${b3}`;
    return buvidCookie;
  } catch {
    buvidFailedAt = Date.now();
    return undefined;
  }
}

async function requestHeaders(withCookie: boolean): Promise<Record<string, string>> {
  const headers = biliHeaders({ Accept: "application/json, text/plain, */*" });
  if (withCookie) {
    const cookie = await bilibiliBuvidCookie();
    if (cookie) headers.Cookie = cookie;
  }
  return headers;
}

/** 需要重试的码：-352 风控校验失败（换指纹）、-509/-799 请求过于频繁（只排时间） */
const THROTTLE_CODES = new Set([-352, -509, -799]);

/** 真实限流：短时间内请求太多，换指纹没用，只能等 */
const RATE_LIMIT_CODES = new Set([-509, -799]);

export interface BiliJson {
  code?: number;
  message?: string;
}

export interface BiliJsonOptions {
  /** 是否带匿名指纹 Cookie，默认 true */
  cookie?: boolean;
  /** 最多尝试次数，默认 4 */
  attempts?: number;
}

/**
 * GET + 解析 JSON。风控码会自动换指纹并退避重试；
 * 返回最后一次的响应体，是否成功交给调用方判断（有些接口用别的成功码）。
 */
export async function biliGetJson<T extends BiliJson>(
  url: string,
  options: BiliJsonOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 4);
  let last: T | undefined;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const res = await fetch(url, {
      headers: await requestHeaders(options.cookie !== false),
      redirect: "follow",
    });

    if (!res.ok) {
      // 412 是风控页，429 是限流，都值得等一下再来
      if ((res.status === 412 || res.status === 429) && attempt + 1 < attempts) {
        if (res.status === 412) buvidCookie = undefined;
        await sleep((res.status === 412 ? 1_200 : 2_500) * (attempt + 1));
        continue;
      }
      throw new VideoMcpError(
        `Bilibili API request failed (HTTP ${res.status}): ${url}`,
        res.status === 404 ? "NOT_FOUND" : "DOWNLOAD_FAILED",
      );
    }

    last = (await res.json()) as T;
    if (typeof last.code === "number" && THROTTLE_CODES.has(last.code) && attempt + 1 < attempts) {
      // 限流时换指纹没用，只退避；风控（-352）则换一个匿名指纹再试
      if (!RATE_LIMIT_CODES.has(last.code)) buvidCookie = undefined;
      await sleep((RATE_LIMIT_CODES.has(last.code) ? 2_500 : 900) * (attempt + 1));
      continue;
    }
    return last;
  }

  if (last) return last;
  throw new VideoMcpError(`Bilibili API kept failing: ${url}`, "DOWNLOAD_FAILED");
}

/** GET 纯文本（HTML 页面等），同样带浏览器头与重试 */
export async function biliGetText(url: string, options: { cookie?: boolean } = {}): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: await requestHeaders(options.cookie !== false),
        redirect: "follow",
      });
      if (!res.ok) throw new VideoMcpError(`HTTP ${res.status}: ${url}`, "DOWNLOAD_FAILED");
      return await res.text();
    } catch (err) {
      lastError = err;
      if (err instanceof VideoMcpError) throw err;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastError instanceof VideoMcpError
    ? lastError
    : new VideoMcpError(
        `Failed to fetch ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        "DOWNLOAD_FAILED",
      );
}

/** 把接口的中文/英文错误信息统一成可读提示 */
export function biliErrorMessage(json: BiliJson, fallback: string): string {
  return json.message && json.message !== "0" ? json.message : fallback;
}

/** 判断接口报错是不是“需要登录/大会员”，用来给出更准确的错误码 */
export function isLoginOrVipMessage(message: string): boolean {
  return /登录|login|会员|大会员|购买|付费|权限|地区|不可观看/i.test(message);
}

/** 限流提示：重试后仍是 -509/-799，说明短时间内请求太多 */
export function isRateLimit(code: number | undefined, message: string): boolean {
  return code === -509 || code === -799 || /请求过于频繁|过于频繁|frequency/i.test(message);
}
