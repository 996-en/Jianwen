import type { FetchAssetsOptions, VideoRef } from "../types.js";

export interface MediaFetchResult {
  videoPath?: string;
  audioPath?: string;
  /** audioPath 已经是 16 kHz 单声道 PCM WAV，调用方可直接交给 ASR，不必再转一次 */
  audioReady?: boolean;
  subtitleText?: string;
  subtitlePath?: string;
  keyframePaths?: string[];
  /** 微信公众号正文纯文本；存在时 pipeline 会跳过 ASR/ffmpeg */
  articleText?: string;
  articlePath?: string;
  articleHtmlPath?: string;
  /** 微信公众号正文图片（由 wantKeyframes 控制是否下载） */
  imagePaths?: string[];
  /** 适配器附带的提示，由 pipeline 合并进 manifest.notes */
  notes?: string[];
  storyboardError?: string;
}

export interface PlatformAdapter {
  readonly platform: string;
  canHandle(input: string): boolean;
  resolve(input: string): Promise<VideoRef>;
  fetchMedia(
    ref: VideoRef,
    destDir: string,
    options?: FetchAssetsOptions,
  ): Promise<MediaFetchResult>;
}
