import { VideoMcpError } from "../types.js";
import { BilibiliAdapter } from "./bilibili.js";
import { DouyinAdapter } from "./douyin.js";
import type { PlatformAdapter } from "./types.js";

/**
 * 适配器按注册顺序匹配；裸 19 位数字会被抖音适配器当作 aweme_id，
 * B 站只匹配 BV/av 前缀或 bilibili.com 链接，两者不会冲突。
 */
const adapters: PlatformAdapter[] = [new BilibiliAdapter(), new DouyinAdapter()];

export function listAdapters(): PlatformAdapter[] {
  return adapters;
}

export function findAdapter(input: string): PlatformAdapter {
  const hit = adapters.find((a) => a.canHandle(input));
  if (!hit) {
    throw new VideoMcpError(
      `No platform adapter for: ${input}. Supports Bilibili URLs/BV/av ids and Douyin video URLs or aweme ids.`,
      "UNSUPPORTED_URL",
    );
  }
  return hit;
}

export function adapterByPlatform(platform: string): PlatformAdapter {
  const hit = adapters.find((a) => a.platform === platform);
  if (!hit) {
    throw new VideoMcpError(
      `Unknown platform: ${platform}`,
      "UNSUPPORTED_URL",
    );
  }
  return hit;
}
