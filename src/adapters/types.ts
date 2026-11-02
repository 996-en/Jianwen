import type { FetchAssetsOptions, VideoRef } from "../types.js";

export interface MediaFetchResult {
  videoPath?: string;
  audioPath?: string;
  /** audioPath 已经是 16 kHz 单声道 PCM WAV，调用方可直接交给 ASR，不必再转一次 */
  audioReady?: boolean;
  subtitleText?: string;
  subtitlePath?: string;
  keyframePaths?: string[];
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
