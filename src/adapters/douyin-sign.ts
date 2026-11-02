import crypto from "node:crypto";

/**
 * 抖音网页版详情接口的 query 签名（`x-secsdk-web-signature`）。
 *
 * 这一层只做纯计算：给定参数表、uifid 与 timestamp，产出可直接请求的 query 字符串。
 * 算法来自公开前端实现，并已用浏览器真实请求逐字节校验（相同输入得到相同签名）。
 * 签名只覆盖 query、不覆盖 body，所以“参与签名的 query”必须与实际发出的完全相同。
 *
 * 抖音没有 B 站那种可独立降级的第二能力（故事板/字幕），单独拆出本文件是因为
 * 签名本身是一段独立算法：可离线回归、最容易随上游更新而变化。
 */

/** 与浏览器同源的签名盐值；上游前端更新后可能变化，改动前先用真实请求回归验证 */
export const WEBSIGN_SALT = "A96D855A08C0A9707F8BEF0D9A527E4E";

/** 与浏览器 URLSearchParams 一致：`+` 视为空格 */
export function decodeComponent(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

/**
 * 规范化 query：参数保持原顺序，key 解码后原样输出（不重新编码），
 * value 解码后按 encodeURIComponent 重新编码，并剔除签名参数本身。
 * 注意 timestamp 必须保留在签名范围内（已用浏览器真实请求比对确认）。
 */
export function canonicalizeQuery(rawQuery: string): string {
  const out: string[] = [];
  for (const pair of rawQuery.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? "" : pair.slice(eq + 1);
    const key = decodeComponent(rawKey);
    if (key === "x-secsdk-web-signature") continue;
    out.push(`${key}=${encodeURIComponent(decodeComponent(rawValue))}`);
  }
  return out.join("&");
}

/** 签名 = md5(`${uifid}_${timestamp}_${salt}_${规范化 query}`) 的小写 hex */
export function computeWebSignature(
  canonicalQuery: string,
  uifid: string,
  timestamp: number,
): string {
  const preimage = `${uifid}_${timestamp}_${WEBSIGN_SALT}_${canonicalQuery}`;
  return crypto.createHash("md5").update(preimage, "utf8").digest("hex");
}

/** 生成可直接请求的详情 query（已含 uifid / timestamp / 签名） */
export function buildDetailQuery(
  params: Array<[string, string]>,
  uifid: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): string {
  // 先剔除调用方可能带入的旧 timestamp / 签名，再按固定顺序拼出 base query。
  const base = params
    .filter(([k]) => k !== "timestamp" && k !== "x-secsdk-web-signature")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const withUifid = /(?:^|&)uifid=/.test(base)
    ? base
    : `${base}&uifid=${encodeURIComponent(uifid)}`;
  // timestamp 参与签名，必须在生成签名之前追加。
  const signedQuery = canonicalizeQuery(`${withUifid}&timestamp=${timestamp}`);
  const signature = computeWebSignature(signedQuery, uifid, timestamp);
  return `${signedQuery}&x-secsdk-web-signature=${signature}`;
}

/**
 * 详情接口固定使用网页端参数：顺序固定，签名与实际请求共用同一串 query。
 * 这些指纹需要与 `douyinUserAgent()` 的默认 UA 同代（当前 Chrome 156 / Windows），
 * 不一致时抖音可能返回空响应；当前接口不需要 a_bogus / msToken。
 */
export function detailParams(awemeId: string): Array<[string, string]> {
  return [
    ["device_platform", "webapp"],
    ["aid", "6383"],
    ["channel", "channel_pc_web"],
    ["aweme_id", awemeId],
    ["pc_client_type", "1"],
    ["version_code", "190500"],
    ["version_name", "19.5.0"],
    ["cookie_enabled", "true"],
    ["screen_width", "1920"],
    ["screen_height", "1080"],
    ["browser_language", "zh-CN"],
    ["browser_platform", "Win32"],
    ["browser_name", "Chrome"],
    ["browser_version", "156.0.0.0"],
    ["browser_online", "true"],
    ["engine_name", "Blink"],
    ["engine_version", "156.0.0.0"],
    ["os_name", "Windows"],
    ["os_version", "10"],
    ["cpu_core_num", "8"],
    ["device_memory", "8"],
    ["platform", "PC"],
    ["downlink", "10"],
    ["effective_type", "4g"],
    ["round_trip_time", "0"],
  ];
}
