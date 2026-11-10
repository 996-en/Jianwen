import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  BilibiliAdapter,
  extractAvId,
  extractBvId,
  isBilibiliInput,
  subtitleJsonToText,
} from "../../src/adapters/bilibili.js";

describe("bilibili parsing", () => {
  it("extracts BV from bare id", () => {
    assert.equal(extractBvId("BV1GJ411x7h7"), "BV1GJ411x7h7");
  });

  it("extracts BV from URL", () => {
    assert.equal(
      extractBvId("https://www.bilibili.com/video/BV1GJ411x7h7/?spm=1"),
      "BV1GJ411x7h7",
    );
  });

  it("extracts av id", () => {
    assert.equal(extractAvId("av2"), "2");
    assert.equal(extractAvId("https://www.bilibili.com/video/av2"), "2");
  });

  it("canHandle bilibili forms", () => {
    const a = new BilibiliAdapter();
    assert.equal(a.canHandle("BV1GJ411x7h7"), true);
    assert.equal(a.canHandle("https://www.bilibili.com/video/BV1GJ411x7h7"), true);
    assert.equal(a.canHandle("https://b23.tv/abcdefg"), true);
    assert.equal(a.canHandle("av170001"), true);
    assert.equal(a.canHandle("https://www.youtube.com/watch?v=1"), false);
    assert.equal(isBilibiliInput("not-a-video"), false);
  });

  it("subtitleJsonToText flattens BCC body", () => {
    const text = subtitleJsonToText(
      JSON.stringify({
        body: [
          { from: 0, to: 1, content: "你好" },
          { from: 1, to: 2, content: "世界" },
        ],
      }),
    );
    assert.equal(text, "你好\n世界");
  });
});

describe("BilibiliAdapter.resolve", () => {
  it("记录发布时间、作者 ID 和播放及互动数（包括零值）", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      assert.equal(String(input), "https://api.bilibili.com/x/web-interface/view?bvid=BV1VqsQ6KEoy");
      return Response.json({
        code: 0, message: "0", data: {
          bvid: "BV1VqsQ6KEoy", aid: 123, title: "测试视频", duration: 116,
          owner: { name: "影视飓风", mid: 946974 }, pubdate: 1793209896,
          pages: [{ cid: 456, page: 1, part: "", duration: 116 }],
          stat: { view: 1289130, share: 0, reply: 6676, like: 46517,
            favorite: 4276, coin: 4643, danmaku: 1914 },
        },
      });
    };
    try {
      const ref = await new BilibiliAdapter().resolve("BV1VqsQ6KEoy");
      assert.equal(ref.author, "影视飓风");
      assert.equal(ref.authorId, 946974);
      assert.equal(ref.publishedAt, "2026-10-28T17:51:36.000Z");
      assert.deepEqual(ref.stats, {
        views: 1289130, shares: 0, comments: 6676, likes: 46517,
        favorites: 4276, coins: 4643, danmaku: 1914,
      });
      assert.deepEqual(ref.extras, { aid: 123, cid: 456 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("接口未返回发布时间和统计数据时仍可解析", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({
      code: 0, message: "0", data: {
        bvid: "BV1VqsQ6KEoy", aid: 123, title: "测试视频", duration: 116,
        owner: { name: "UP" }, pages: [{ cid: 456, duration: 116 }],
      },
    });
    try {
      const ref = await new BilibiliAdapter().resolve("BV1VqsQ6KEoy");
      assert.equal(ref.publishedAt, undefined);
      assert.equal(ref.stats, undefined);
      assert.equal(ref.authorId, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("短链跳转失败时报错说明是短链问题，而不是“解析不到 BV”", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      assert.equal(String(input), "https://b23.tv/abcdefg");
      throw new TypeError("fetch failed");
    };
    try {
      await assert.rejects(
        () => new BilibiliAdapter().resolve("https://b23.tv/abcdefg"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal((err as { code?: string }).code, "UNSUPPORTED_URL");
          assert.match(err.message, /short link https:\/\/b23\.tv\/abcdefg/);
          assert.match(err.message, /fetch failed/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("短链跳到非作品页时报出最终地址", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      ({
        url: "https://www.bilibili.com/blackboard/activity.html",
        headers: new Headers(),
        status: 200,
      }) as unknown as Response;
    try {
      await assert.rejects(
        () => new BilibiliAdapter().resolve("b23.tv/abcdefg"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal((err as { code?: string }).code, "UNSUPPORTED_URL");
          assert.match(err.message, /led to https:\/\/www\.bilibili\.com\/blackboard/);
          assert.match(err.message, /not a video page/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("失效短链（200 + 错误 JSON）报已失效，而不是“led to”", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ code: -404, message: "啥都木有" }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    };
    try {
      await assert.rejects(
        () => new BilibiliAdapter().resolve("https://b23.tv/pigt3PQ"),
        (err: unknown) => {
          assert.equal((err as { code?: string }).code, "NOT_FOUND");
          assert.match((err as Error).message, /已失效或不存在/);
          assert.match((err as Error).message, /啥都木有/);
          return true;
        },
      );
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("分享文案里的短链只请求链接本身，不拿整段文字当 URL", async () => {
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.startsWith("https://b23.tv/")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://www.bilibili.com/video/BV1VqsQ6KEoy?share_source=copy_web" },
        });
      }
      return Response.json({
        code: 0, message: "0", data: {
          bvid: "BV1VqsQ6KEoy", aid: 123, title: "测试视频", duration: 116,
          owner: { name: "UP" }, pages: [{ cid: 456, duration: 116 }],
        },
      });
    };
    try {
      const ref = await new BilibiliAdapter().resolve(
        "【影视飓风】某标题 https://b23.tv/abcdefg 分享自B站",
      );
      assert.equal(ref.id, "BV1VqsQ6KEoy");
      assert.equal(ref.pageUrl, "https://www.bilibili.com/video/BV1VqsQ6KEoy");
      assert.deepEqual(requested, [
        "https://b23.tv/abcdefg",
        "https://api.bilibili.com/x/web-interface/view?bvid=BV1VqsQ6KEoy",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("短链 Location 是相对地址时能拼成绝对地址", async () => {
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.startsWith("https://b23.tv/")) {
        return new Response(null, { status: 302, headers: { location: "/video/BV1VqsQ6KEoy" } });
      }
      return Response.json({
        code: 0, message: "0", data: {
          bvid: "BV1VqsQ6KEoy", aid: 123, title: "测试视频", duration: 116,
          owner: { name: "UP" }, pages: [{ cid: 456, duration: 116 }],
        },
      });
    };
    try {
      const ref = await new BilibiliAdapter().resolve("https://b23.tv/relative1");
      assert.equal(ref.id, "BV1VqsQ6KEoy");
      assert.equal(requested[0], "https://b23.tv/relative1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("BilibiliAdapter.fetchMedia", () => {
  it("无字幕、只需 ASR 时仅下载音轨，不请求视频流", async () => {
    const originalFetch = globalThis.fetch;
    const originalPath = process.env.PATH;
    // 不依赖本机是否安装了 yt-dlp，固定测试公开接口的音频下载分支。
    process.env.PATH = os.tmpdir();
    const requested: string[] = [];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bili-audio-only-test-"));
    globalThis.fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("/x/player/v2?")) {
        return Response.json({ code: 0, data: { subtitle: { subtitles: [] } } });
      }
      if (url.includes("/x/player/playurl?")) {
        return Response.json({ code: 0, data: {
          dash: {
            audio: [{ baseUrl: "https://example.com/audio.m4s" }],
            video: [{ baseUrl: "https://example.com/video.m4s" }],
          },
        } });
      }
      if (url === "https://example.com/audio.m4s") return new Response("audio bytes");
      throw new Error(`意外请求: ${url}`);
    };
    try {
      const ref = {
        platform: "bilibili", id: "BV1GJ411x7h7", title: "测试视频",
        durationSec: 10, author: "UP", pageUrl: "https://www.bilibili.com/video/BV1GJ411x7h7",
        extras: { aid: 123, cid: 456 },
      };
      const result = await new BilibiliAdapter().fetchMedia(ref, dir, {
        wantSubtitles: true, wantAsr: true, wantKeyframes: false,
      });
      assert.equal(await fs.readFile(result.audioPath!, "utf8"), "audio bytes");
      assert.equal(result.videoPath, undefined);
      assert.ok(!requested.includes("https://example.com/video.m4s"));
    } finally {
      globalThis.fetch = originalFetch;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("只请求字幕时不下载媒体，字幕可用时也不为 ASR 下载媒体", async () => {
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bili-subtitle-test-"));
    globalThis.fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("/x/player/v2?")) {
        return new Response(JSON.stringify({
          data: { subtitle: { subtitles: [{ lan: "zh-CN", lan_doc: "中文", subtitle_url: "//example.com/subtitle.json" }] } },
        }));
      }
      if (url === "https://example.com/subtitle.json") {
        return new Response(JSON.stringify({ body: [{ content: "测试字幕" }] }));
      }
      throw new Error(`意外请求: ${url}`);
    };

    try {
      const adapter = new BilibiliAdapter();
      const ref = {
        platform: "bilibili",
        id: "BV1GJ411x7h7",
        title: "测试视频",
        durationSec: 10,
        author: "UP",
        pageUrl: "https://www.bilibili.com/video/BV1GJ411x7h7",
        extras: { aid: 123, cid: 456 },
      };
      for (const wantAsr of [false, true]) {
        const result = await adapter.fetchMedia(ref, dir, {
          wantSubtitles: true,
          wantAsr,
          wantKeyframes: false,
        });
        assert.equal(result.subtitleText, "测试字幕");
        assert.equal(result.videoPath, undefined);
        assert.equal(result.audioPath, undefined);
      }
      assert.equal(requested.length, 4);
    } finally {
      globalThis.fetch = originalFetch;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
