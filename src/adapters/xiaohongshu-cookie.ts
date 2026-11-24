import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_XHS_COOKIE_FILE,
  xhsCookieFile,
  xhsCookiesRaw,
  xiaohongshuUserAgent,
} from "../config.js";
import { VideoMcpError } from "../types.js";

export interface XhsCookie {
  name: string;
  value: string;
}

export interface XhsSession {
  cookieHeader: string;
  a1: string;
  webSession?: string;
  userAgent: string;
}

/** 解析 Netscape cookies.txt，只保留小红书相关域。 */
export function parseXhsCookieFile(text: string): XhsCookie[] {
  const out: XhsCookie[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#HttpOnly_")) line = line.slice("#HttpOnly_".length);
    else if (line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    const domain = parts[0] ?? "";
    if (!/xiaohongshu/i.test(domain)) continue;
    const name = parts[5] ?? "";
    const value = parts.slice(6).join("\t");
    if (name) out.push({ name, value });
  }
  return out;
}

function cookiesFromRawHeader(raw: string): XhsCookie[] {
  return raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      return eq === -1
        ? { name: part, value: "" }
        : { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() };
    });
}

function sessionFromCookies(cookies: XhsCookie[], cookieHeader: string): XhsSession {
  const a1 = cookies.find((c) => c.name === "a1")?.value;
  if (!a1) {
    throw new VideoMcpError(
      `小红书 Cookie 中缺少 a1。请登录小红书网页版后执行 npm run xhs:cookies，或设置 VIDEO_MCP_XHS_COOKIES。`,
      "COOKIE_REQUIRED",
    );
  }
  const webSession = cookies.find((c) => c.name === "web_session")?.value;
  return { cookieHeader, a1, webSession, userAgent: xiaohongshuUserAgent() };
}

/** 未配置 Cookie 时返回 null；公开短链等仍可走无 Cookie 网页解析。 */
export async function xhsSessionOptional(): Promise<XhsSession | null> {
  const raw = xhsCookiesRaw();
  if (raw) return sessionFromCookies(cookiesFromRawHeader(raw), raw);

  const file = xhsCookieFile();
  if (!file) return null;

  let text: string;
  try {
    text = await fs.readFile(path.resolve(file), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new VideoMcpError(
      `无法读取小红书 Cookie 文件 ${file}: ${err instanceof Error ? err.message : String(err)}`,
      "COOKIE_REQUIRED",
    );
  }
  const cookies = parseXhsCookieFile(text);
  if (!cookies.length) return null;
  return sessionFromCookies(cookies, cookies.map((c) => `${c.name}=${c.value}`).join("; "));
}

export function xhsCookieHint(): string {
  return `需要登录态时可执行 npm run xhs:cookies（默认写入 ${DEFAULT_XHS_COOKIE_FILE}）。`;
}