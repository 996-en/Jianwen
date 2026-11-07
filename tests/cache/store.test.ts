import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { CacheStore } from "../../src/cache/store.js";
import type { AssetManifest, VideoRef } from "../../src/types.js";

describe("CacheStore", () => {
  it("roundtrips manifest under custom root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-mcp-"));
    const store = new CacheStore(root);
    const ref: VideoRef = {
      platform: "bilibili",
      id: "BV1TEST12345",
      title: "t",
      durationSec: 12,
      author: "up",
      pageUrl: "https://www.bilibili.com/video/BV1TEST12345",
    };
    const manifest: AssetManifest = {
      ref,
      createdAt: new Date().toISOString(),
      cacheDir: store.dirFor(ref),
      subtitleText: "hello",
      notes: ["n"],
    };
    await store.writeManifest(manifest);
    const read = await store.readManifest(ref);
    assert.ok(read);
    assert.equal(read!.ref.id, "BV1TEST12345");
    assert.equal(read!.subtitleText, "hello");
    assert.equal(
      store.dirFor(ref),
      path.join(root, "bilibili", "BV1TEST12345"),
    );
    const miss = await store.readManifest({
      platform: "bilibili",
      id: "BV_MISSING__",
    });
    assert.equal(miss, null);
  });

  it("respects VIDEO_MCP_CACHE_DIR via defaultCacheRoot", async () => {
    const { defaultCacheRoot } = await import("../../src/cache/store.js");
    const prev = process.env.VIDEO_MCP_CACHE_DIR;
    process.env.VIDEO_MCP_CACHE_DIR = "/tmp/custom-video-mcp-cache";
    try {
      assert.equal(defaultCacheRoot(), path.resolve("/tmp/custom-video-mcp-cache"));
    } finally {
      if (prev === undefined) delete process.env.VIDEO_MCP_CACHE_DIR;
      else process.env.VIDEO_MCP_CACHE_DIR = prev;
    }
  });

  it("defaults cache to <package>/cache when VIDEO_MCP_CACHE_DIR unset", async () => {
    const { defaultCacheRoot, packageRoot } = await import("../../src/cache/store.js");
    const prev = process.env.VIDEO_MCP_CACHE_DIR;
    delete process.env.VIDEO_MCP_CACHE_DIR;
    try {
      assert.equal(defaultCacheRoot(), path.join(packageRoot(), "cache"));
    } finally {
      if (prev === undefined) delete process.env.VIDEO_MCP_CACHE_DIR;
      else process.env.VIDEO_MCP_CACHE_DIR = prev;
    }
  });
});
