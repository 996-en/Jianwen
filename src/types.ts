/** Shared domain types for jianwen (见闻) */

export type PlatformId = "bilibili" | "douyin" | string;

export interface VideoStats {
  views?: number;
  shares?: number;
  comments?: number;
  likes?: number;
  favorites?: number;
  coins?: number;
  danmaku?: number;
}

export interface VideoRef {
  platform: PlatformId;
  id: string;
  title: string;
  durationSec: number;
  author: string;
  authorId?: number;
  /** 发布时间，UTC ISO 8601；平台未提供时省略 */
  publishedAt?: string;
  /** 获取元数据时的互动数快照；不随时间自动更新 */
  stats?: VideoStats;
  pageUrl: string;
  /** Extra platform-specific fields (aid, cid, etc.) */
  extras?: Record<string, string | number | boolean | null>;
}

export interface FetchAssetsOptions {
  wantSubtitles?: boolean;
  wantAsr?: boolean;
  /** 本地 Whisper 转写的最长等待秒数；未设置时根据视频时长自动估算 */
  asrTimeoutSec?: number;
  wantKeyframes?: boolean;
  /** Seconds between keyframes; default 10 */
  keyframeIntervalSec?: number;
}

export interface AssetManifest {
  ref: VideoRef;
  createdAt: string;
  cacheDir: string;
  subtitleText?: string;
  subtitlePath?: string;
  asrText?: string;
  asrPath?: string;
  audioPath?: string;
  videoPath?: string;
  keyframePaths?: string[];
  notes?: string[];
}

export class VideoMcpError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "UNSUPPORTED_URL"
      | "NOT_FOUND"
      | "VIP_OR_LOGIN"
      | "COOKIE_REQUIRED"
      | "DOWNLOAD_FAILED"
      | "FFMPEG_MISSING"
      | "ASR_UNAVAILABLE"
      | "SUMMARY_UNSET"
      | "CACHE_MISS"
      | "INTERNAL",
  ) {
    super(message);
    this.name = "VideoMcpError";
  }
}
