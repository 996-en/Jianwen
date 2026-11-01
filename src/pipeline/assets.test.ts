import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { CacheStore } from "../cache/store.js";
import type { PlatformAdapter } from "../adapters/types.js";
import type { VideoRef } from "../types.js";
import { estimateAsrTimeoutSec, fetchAssets, run } from "./assets.js";

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

it("已有故事板帧时直接写入 manifest，不要求视频文件或 ffmpeg", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bili-assets-test-"));
  const ref: VideoRef = {
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
