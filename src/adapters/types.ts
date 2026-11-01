import type { FetchAssetsOptions, VideoRef } from "../types.js";

export interface MediaFetchResult {
  videoPath?: string;
  audioPath?: string;
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
