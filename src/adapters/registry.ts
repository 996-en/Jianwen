import { VideoMcpError } from "../types.js";
import { BilibiliAdapter } from "./bilibili.js";
import type { PlatformAdapter } from "./types.js";

/**
 * Future: DouyinAdapter implementing PlatformAdapter.
 * Register it here without renaming MCP tools.
 * // import { DouyinAdapter } from "./douyin.js";
 */

const adapters: PlatformAdapter[] = [new BilibiliAdapter()];

// Placeholder for Douyin — not implemented in v1
// adapters.push(new DouyinAdapter());

export function listAdapters(): PlatformAdapter[] {
  return adapters;
}

export function findAdapter(input: string): PlatformAdapter {
  const hit = adapters.find((a) => a.canHandle(input));
  if (!hit) {
    throw new VideoMcpError(
      `No platform adapter for: ${input}. v1 supports Bilibili URLs/BV ids only (Douyin reserved).`,
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
