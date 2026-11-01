import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import sharp from "sharp";
import { BilibiliAdapter } from "./bilibili.js";
import { fetchStoryboardFrames } from "./bilibili-storyboard.js";
import type { VideoRef } from "../types.js";

const ref: VideoRef = {
  platform: "bilibili", id: "BV1GJ411x7h7", title: "测试", durationSec: 50,
  author: "测试", pageUrl: "https://www.bilibili.com/video/BV1GJ411x7h7",
  extras: { aid: 123, cid: 456 },
};

const data = {
  code: 0, data: {
    image: ["//bimp.hdslb.com/1.jpg", "//bimp.hdslb.com/2.jpg"],
    index: [0, 0, 10, 20, 30, 40, 50],
    img_x_len: 2, img_y_len: 2, img_x_size: 8, img_y_size: 8,
  },
};

function mockFetch(handler: (url: string) => Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => handler(String(input));
  return () => { globalThis.fetch = original; };
}

describe("Bilibili storyboard", () => {
  it("跨雪碧图均匀选帧并裁剪，可在不下载视频时得到画面", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bili-storyboard-"));
    const sheet = await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } }).jpeg().toBuffer();
    const urls: string[] = [];
    const restore = mockFetch(async (url) => {
      urls.push(url);
      if (url.includes("/x/player/videoshot?")) return Response.json(data);
      if (url.startsWith("https://bimp.hdslb.com/")) return new Response(new Uint8Array(sheet));
      throw new Error(`意外请求: ${url}`);
    });
    try {
      const frames = await fetchStoryboardFrames(ref, dir, 10);
      assert.equal(frames.length, 5);
      assert.ok(urls.some((url) => url.endsWith("/2.jpg")), "应访问第二张雪碧图");
      assert.equal(urls.filter((url) => url.endsWith("/1.jpg")).length, 1, "同一雪碧图只下载一次");
      assert.ok(urls.every((url) => !url.includes("playurl")));
      for (const file of frames) {
        const meta = await sharp(file).metadata();
        assert.equal(meta.width, 8);
        assert.equal(meta.height, 8);
      }
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("故事板图损坏时回退到视频下载，而不是返回不存在的帧", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bili-storyboard-fallback-"));
    const urls: string[] = [];
    const restore = mockFetch(async (url) => {
      urls.push(url);
      if (url.includes("/x/player/videoshot?")) return Response.json(data);
      if (url.startsWith("https://bimp.hdslb.com/")) return new Response("invalid jpeg");
      if (url.includes("/x/player/playurl?")) return Response.json({ code: 0, data: { durl: [{ url: "https://example.com/video.m4s" }] } });
      if (url === "https://example.com/video.m4s") return new Response("video bytes");
      throw new Error(`意外请求: ${url}`);
    });
    try {
      const result = await new BilibiliAdapter().fetchMedia(ref, dir, { wantSubtitles: false, wantKeyframes: true });
      assert.equal(result.keyframePaths, undefined);
      assert.ok(result.storyboardError);
      assert.equal(await fs.readFile(result.videoPath!, "utf8"), "video bytes");
      assert.ok(urls.some((url) => url.includes("/x/player/playurl?")));
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
