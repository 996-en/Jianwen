import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { CacheStore } from "../../src/cache/store.js";
import type { PlatformAdapter } from "../../src/adapters/types.js";
import type { VideoRef } from "../../src/types.js";
import { estimateAsrTimeoutSec, fetchAssets, run, whisperCliArgs } from "../../src/pipeline/assets.js";

it("根据视频时长估算 Whisper 的转写时限，并限制最小和最大值", () => {
  assert.equal(estimateAsrTimeoutSec(116), 468);
  assert.equal(estimateAsrTimeoutSec(30), 300);
  assert.equal(estimateAsrTimeoutSec(0), 1800);
  assert.equal(estimateAsrTimeoutSec(3600), 10920);
  assert.equal(estimateAsrTimeoutSec(100000), 86400);
});

it("Whisper 子进程超过上限或客户端取消时会终止", async () => {
  const args = ["-e", "setInterval(() => {}, 1000)"];
  await assert.rejects(run(process.execPath, args, { timeoutMs: 150 }), /timed out after 1 seconds/);
  const controller = new AbortController();
  const pending = run(process.execPath, args, { signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(pending, /cancelled by client/);
});

it("Whisper 参数不携带上文、抑制非语音标记，并按需加 VAD", () => {
  const base = { model: "m.bin", audioPath: "a.wav", outBase: "out/asr", language: "auto" };
  const withoutVad = whisperCliArgs(base);
  assert.deepEqual(withoutVad, [
    "-m", "m.bin", "-f", "a.wav", "-l", "auto", "-mc", "0", "-sns", "-oj", "-of", "out/asr",
  ]);
  assert.deepEqual(
    whisperCliArgs({ ...base, vadModel: "vad.bin" }).slice(9, 12),
    ["--vad", "-vm", "vad.bin"],
  );
});

it("抽帧后默认删除下载的整段视频，VIDEO_MCP_KEEP_MEDIA=1 时保留", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "media-cleanup-test-"));
  const ref: VideoRef = {
    platform: "douyin", id: "7703519881974648083", title: "测试", author: "测试",
    durationSec: 60, pageUrl: "https://www.douyin.com/video/7703519881974648083",
  };
  // 适配器同时给出 videoPath 与现成的关键帧，因此流程不会调用 ffmpeg
  const adapter: PlatformAdapter = {
    platform: "douyin",
    canHandle: () => true,
    resolve: async () => ref,
    fetchMedia: async (_ref, dir) => {
      const media = path.join(dir, "media.mp4");
      const frameDir = path.join(dir, "keyframes");
      await fs.mkdir(frameDir, { recursive: true });
      await fs.writeFile(media, "fake-video");
      const frame = path.join(frameDir, "frame_0001.jpg");
      await fs.writeFile(frame, "fake-frame");
      return { videoPath: media, keyframePaths: [frame] };
    },
  };
  const cache = new CacheStore(root);
  const previous = process.env.VIDEO_MCP_KEEP_MEDIA;
  const previousProvider = process.env.VIDEO_MCP_ASR_PROVIDER;
  try {
    delete process.env.VIDEO_MCP_KEEP_MEDIA;
    process.env.VIDEO_MCP_ASR_PROVIDER = "none";
    const manifest = await fetchAssets(adapter, ref, cache, { wantKeyframes: true });
    assert.equal(manifest.videoPath, undefined);
    assert.equal(manifest.keyframePaths?.length, 1);
    assert.equal(await exists(path.join(manifest.cacheDir, "media.mp4")), false);
    assert.ok(manifest.notes?.some((note) => note.includes("VIDEO_MCP_KEEP_MEDIA=1")));
    assert.equal((await cache.readManifest(ref))?.videoPath, undefined);

    process.env.VIDEO_MCP_KEEP_MEDIA = "1";
    const kept = await fetchAssets(adapter, ref, cache, { wantKeyframes: true });
    assert.equal(kept.videoPath, path.join(kept.cacheDir, "media.mp4"));
    assert.equal(await exists(kept.videoPath!), true);
  } finally {
    if (previous === undefined) delete process.env.VIDEO_MCP_KEEP_MEDIA;
    else process.env.VIDEO_MCP_KEEP_MEDIA = previous;
    if (previousProvider === undefined) delete process.env.VIDEO_MCP_ASR_PROVIDER;
    else process.env.VIDEO_MCP_ASR_PROVIDER = previousProvider;
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("没有平台字幕又未配置 ASR 时会提示如何开启转写", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "asr-hint-test-"));
  const ref: VideoRef = {
    platform: "douyin", id: "7703519881974648083", title: "测试", author: "测试",
    durationSec: 60, pageUrl: "https://www.douyin.com/video/7703519881974648083",
  };
  const adapter: PlatformAdapter = {
    platform: "douyin",
    canHandle: () => true,
    resolve: async () => ref,
    fetchMedia: async () => ({}),
  };
  const previous = process.env.VIDEO_MCP_ASR_PROVIDER;
  try {
    process.env.VIDEO_MCP_ASR_PROVIDER = "none";
    const manifest = await fetchAssets(adapter, ref, new CacheStore(root), {
      wantKeyframes: false,
    });
    assert.ok(
      manifest.notes?.some((note) => note.includes("VIDEO_MCP_ASR_PROVIDER=whisper_local")),
    );

    const explicit = await fetchAssets(adapter, ref, new CacheStore(root), {
      wantKeyframes: false,
      wantAsr: true,
    });
    assert.ok(explicit.notes?.some((note) => note.includes("ASR skipped: VIDEO_MCP_ASR_PROVIDER is none")));
  } finally {
    if (previous === undefined) delete process.env.VIDEO_MCP_ASR_PROVIDER;
    else process.env.VIDEO_MCP_ASR_PROVIDER = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

it("默认不抽帧，也不要求适配器下载整段视频", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "default-no-frames-test-"));
  const ref: VideoRef = {
    platform: "douyin", id: "7703519881974648083", title: "测试", author: "测试",
    durationSec: 60, pageUrl: "https://www.douyin.com/video/7703519881974648083",
  };
  let seen: { wantKeyframes?: boolean; wantAsr?: boolean } = {};
  const adapter: PlatformAdapter = {
    platform: "douyin",
    canHandle: () => true,
    resolve: async () => ref,
    fetchMedia: async (_ref, _dir, options) => {
      seen = { wantKeyframes: options?.wantKeyframes, wantAsr: options?.wantAsr };
      return {};
    },
  };
  const previousProvider = process.env.VIDEO_MCP_ASR_PROVIDER;
  try {
    process.env.VIDEO_MCP_ASR_PROVIDER = "none";
    const manifest = await fetchAssets(adapter, ref, new CacheStore(root), {});
    // 默认只取文字：不向适配器索取关键帧，因此抖音也不会下载整片 mp4
    assert.equal(seen.wantKeyframes, false);
    assert.equal(manifest.keyframePaths, undefined);
    assert.equal(manifest.videoPath, undefined);
    assert.ok(manifest.notes?.some((note) => note.includes("Enable wantAsr or wantKeyframes")));
  } finally {
    if (previousProvider === undefined) delete process.env.VIDEO_MCP_ASR_PROVIDER;
    else process.env.VIDEO_MCP_ASR_PROVIDER = previousProvider;
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("已有故事板帧时直接写入 manifest，不要求视频文件或 ffmpeg", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bili-assets-test-"));  const ref: VideoRef = {
    platform: "bilibili", id: "BV1GJ411x7h7", title: "测试", author: "测试",
    durationSec: 50, pageUrl: "https://www.bilibili.com/video/BV1GJ411x7h7",
    authorId: 946974, publishedAt: "2026-10-28T17:51:36.000Z",
    stats: { views: 123, shares: 0, comments: 5, likes: 10, favorites: 2, coins: 1, danmaku: 3 },
  };
  const adapter: PlatformAdapter = {
    platform: "bilibili",
    canHandle: () => true,
    resolve: async () => ref,
    fetchMedia: async (_ref, dir, options) => {
      assert.equal(options?.keyframeIntervalSec, 20);
      return { keyframePaths: [path.join(dir, "keyframes", "frame_0001.jpg")] };
    },
  };
  try {
    const cache = new CacheStore(root);
    const manifest = await fetchAssets(adapter, ref, cache, { wantKeyframes: true, keyframeIntervalSec: 20 });
    assert.equal(manifest.keyframePaths?.length, 1);
    assert.equal(manifest.videoPath, undefined);
    assert.ok(manifest.notes?.some((note) => note.includes("storyboard keyframes")));
    assert.deepEqual(await cache.readManifest(ref), JSON.parse(JSON.stringify(manifest)));
    assert.deepEqual((await cache.readManifest(ref))?.ref.stats, ref.stats);
    assert.equal((await cache.readManifest(ref))?.ref.publishedAt, ref.publishedAt);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
