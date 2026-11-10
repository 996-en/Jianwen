import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DouyinAdapter, extractAwemeId, isDouyinInput, parseCookieFile } from "../../src/adapters/douyin.js";
import { canonicalizeQuery, computeWebSignature } from "../../src/adapters/douyin-sign.js";

const AWEME_ID = "7703476743591513353";

function withCookies(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const original = process.env.VIDEO_MCP_DOUYIN_COOKIES;
    process.env.VIDEO_MCP_DOUYIN_COOKIES = "ttwid=test-ttwid; UIFID=test-uifid";
    try {
      await fn();
    } finally {
      if (original === undefined) delete process.env.VIDEO_MCP_DOUYIN_COOKIES;
      else process.env.VIDEO_MCP_DOUYIN_COOKIES = original;
    }
  };
}

describe("douyin 输入解析", () => {
  it("从作品链接、图文链接和裸 ID 提取 aweme_id", () => {
    assert.equal(extractAwemeId(`https://www.douyin.com/video/${AWEME_ID}`), AWEME_ID);
    assert.equal(
      extractAwemeId(`https://www.iesdouyin.com/share/video/${AWEME_ID}/?region=CN`),
      AWEME_ID,
    );
    assert.equal(extractAwemeId(`https://www.douyin.com/note/${AWEME_ID}`), AWEME_ID);
    assert.equal(extractAwemeId(AWEME_ID), AWEME_ID);
  });

  it("分享文本里的短链只识别为抖音输入，提取 ID 需要跟随跳转", () => {
    const shareText = `7.43 复制打开抖音，看看【电影冷知识】的作品 https://v.douyin.com/j9yY-DusDuk/ 一定不会让你失望`;
    assert.equal(isDouyinInput(shareText), true);
    assert.equal(extractAwemeId(shareText), null);
  });

  it("不把 B 站输入和随机文本当成抖音", () => {
    assert.equal(isDouyinInput("BV1GJ411x7h7"), false);
    assert.equal(isDouyinInput("av170001"), false);
    assert.equal(isDouyinInput("https://www.bilibili.com/video/BV1GJ411x7h7"), false);
    assert.equal(isDouyinInput("hello"), false);
    // 纯数字 aid 位数不足 19，不会被误判
    assert.equal(isDouyinInput("12345678"), false);
  });
});

describe("抖音 Cookie 文件解析", () => {
  it("只保留抖音相关域，并支持 #HttpOnly_ 前缀", () => {
    const text = [
      "# Netscape HTTP Cookie File",
      "#HttpOnly_.douyin.com\tTRUE\t/\tTRUE\t1800000000\tUIFID\tabc%3D",
      ".douyin.com\tTRUE\t/\tTRUE\t1800000000\tttwid\ttt",
      ".example.com\tTRUE\t/\tTRUE\t1800000000\tsession\tsecret",
      "",
    ].join("\n");
    const cookies = parseCookieFile(text);
    assert.deepEqual(cookies.map((c) => c.name), ["UIFID", "ttwid"]);
  });
});

describe("DouyinAdapter.resolve", () => {
  it(
    "解析元数据并发出签名正确的详情请求",
    withCookies(async () => {
      const originalFetch = globalThis.fetch;
      let requested = "";
      globalThis.fetch = async (input) => {
        requested = String(input);
        return Response.json({
          status_code: 0,
          aweme_detail: {
            aweme_id: AWEME_ID,
            desc: "这些电影场景远比想象的更真实",
            create_time: 1793209896,
            author: { nickname: "电影冷知识", sec_uid: "MS4wLjABAAAA" },
            statistics: {
              play_count: 1289130,
              digg_count: 46517,
              comment_count: 6676,
              share_count: 0,
              collect_count: 4276,
            },
            video: { duration: 246480 },
          },
        });
      };
      try {
        const ref = await new DouyinAdapter().resolve(AWEME_ID);
        assert.equal(ref.platform, "douyin");
        assert.equal(ref.id, AWEME_ID);
        assert.equal(ref.title, "这些电影场景远比想象的更真实");
        assert.equal(ref.durationSec, 246);
        assert.equal(ref.author, "电影冷知识");
        assert.equal(ref.publishedAt, "2026-10-28T17:51:36.000Z");
        assert.deepEqual(ref.stats, {
          views: 1289130,
          likes: 46517,
          comments: 6676,
          shares: 0,
          favorites: 4276,
        });
        assert.equal(ref.pageUrl, `https://www.douyin.com/video/${AWEME_ID}`);
        assert.equal(ref.extras?.authorSecUid, "MS4wLjABAAAA");

        // 发出的请求必须自带可复算的签名，且 uifid 与 Cookie 一致
        const url = new URL(requested);
        assert.equal(url.pathname, "/aweme/v1/web/aweme/detail/");
        const params = url.searchParams;
        assert.equal(params.get("aweme_id"), AWEME_ID);
        assert.equal(params.get("uifid"), "test-uifid");
        const timestamp = Number(params.get("timestamp"));
        assert.ok(Number.isInteger(timestamp) && timestamp > 0);
        assert.equal(
          params.get("x-secsdk-web-signature"),
          computeWebSignature(canonicalizeQuery(url.search.slice(1)), "test-uifid", timestamp),
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    }),
  );

  it(
    "网页端不返回播放量时不把 0 当成真实播放数",
    withCookies(async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        Response.json({
          status_code: 0,
          aweme_detail: {
            aweme_id: AWEME_ID,
            desc: "测试",
            statistics: { play_count: 0, digg_count: 1 },
            video: { duration: 1000 },
          },
        });
      try {
        const ref = await new DouyinAdapter().resolve(AWEME_ID);
        assert.equal(ref.stats?.views, undefined);
        assert.equal(ref.stats?.likes, 1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }),
  );

  it("缺少 Cookie 时明确报 COOKIE_REQUIRED", async () => {
    const originalFetch = globalThis.fetch;
    const originalRaw = process.env.VIDEO_MCP_DOUYIN_COOKIES;
    const originalFile = process.env.VIDEO_MCP_DOUYIN_COOKIE_FILE;
    delete process.env.VIDEO_MCP_DOUYIN_COOKIES;
    // 默认会回退到项目根的 .douyin-cookies.txt，这里指向一个不存在的路径模拟“完全没配置”
    process.env.VIDEO_MCP_DOUYIN_COOKIE_FILE = path.join(os.tmpdir(), "jianwen-missing-cookies.txt");
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return Response.json({ status_code: 0 });
    };
    try {
      await assert.rejects(
        () => new DouyinAdapter().resolve(AWEME_ID),
        (err: { code?: string }) => err.code === "COOKIE_REQUIRED",
      );
      assert.equal(called, false);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalRaw !== undefined) process.env.VIDEO_MCP_DOUYIN_COOKIES = originalRaw;
      if (originalFile !== undefined) process.env.VIDEO_MCP_DOUYIN_COOKIE_FILE = originalFile;
    }
  });

  it(
    "403 Uifid Not Found 报 COOKIE_REQUIRED，空响应报 DOWNLOAD_FAILED",
    withCookies(async () => {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async () =>
          new Response("Blocked by ArgusSecurityPlugin Uifid Not Found", { status: 403 });
        await assert.rejects(
          () => new DouyinAdapter().resolve(AWEME_ID),
          (err: { code?: string }) => err.code === "COOKIE_REQUIRED",
        );

        globalThis.fetch = async () => new Response("", { status: 200 });
        await assert.rejects(
          () => new DouyinAdapter().resolve(AWEME_ID),
          (err: { code?: string }) => err.code === "DOWNLOAD_FAILED",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    }),
  );
});

describe("DouyinAdapter.resolve 图文与长文", () => {
  it(
    "图片作品不再报错：kind=images，页面地址指向 /note/，时长为 0",
    withCookies(async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        Response.json({
          status_code: 0,
          aweme_detail: {
            aweme_id: AWEME_ID,
            aweme_type: 68,
            desc: "2026年最新思想汇报！可借鉴！！！",
            author: { nickname: "李老师", sec_uid: "MS4wLjABAAAA" },
            images: [
              { url_list: ["https://cdn.example.com/1.webp"] },
              { url_list: ["https://cdn.example.com/2.webp"] },
              { url_list: ["https://cdn.example.com/3.webp"] },
            ],
            video: { duration: 0, play_addr: { url_list: ["https://cdn.example.com/bgm.mp3"] } },
          },
        });
      try {
        const ref = await new DouyinAdapter().resolve(`https://www.douyin.com/note/${AWEME_ID}`);
        assert.equal(ref.extras?.kind, "images");
        assert.equal(ref.extras?.imageCount, 3);
        assert.equal(ref.durationSec, 0);
        assert.equal(ref.title, "2026年最新思想汇报！可借鉴！！！");
        assert.equal(ref.pageUrl, `https://www.douyin.com/note/${AWEME_ID}`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }),
  );

  it(
    "长文用 article_title 作标题，页面地址指向 /article/，并带 readTime",
    withCookies(async () => {
      const originalFetch = globalThis.fetch;
      const markdown = "正文段落";
      globalThis.fetch = async () =>
        Response.json({
          status_code: 0,
          aweme_detail: {
            aweme_id: AWEME_ID,
            aweme_type: 163,
            desc: "朋友们好，我是莫言。",
            author: { nickname: "莫言", sec_uid: "MS4wLjABAAAA" },
            article_info: {
              article_id: AWEME_ID,
              article_title: "莫言：我的父亲",
              read_time: 4,
              article_content: JSON.stringify({ markdown }),
            },
          },
        });
      try {
        const ref = await new DouyinAdapter().resolve(`https://www.douyin.com/article/${AWEME_ID}`);
        assert.equal(ref.extras?.kind, "article");
        assert.equal(ref.extras?.articleId, AWEME_ID);
        assert.equal(ref.extras?.readTime, 4);
        assert.equal(ref.title, "莫言：我的父亲");
        assert.equal(ref.pageUrl, `https://www.douyin.com/article/${AWEME_ID}`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }),
  );

  it("主页/合集给明确提示，且不发详情请求", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return Response.json({ status_code: 0 });
    };
    try {
      await assert.rejects(
        () =>
          new DouyinAdapter().resolve(
            "https://www.douyin.com/user/MS4wLjABAAAADl3WHEkaQ1tcD4-15S_njfDxf-DzI9AkhXGz-HzyVcwwP7GcoVu0dhm2b-MjmSUQ",
          ),
        (err: { code?: string; message?: string }) =>
          err.code === "UNSUPPORTED_URL" && /主页/.test(err.message ?? ""),
      );
      await assert.rejects(
        () => new DouyinAdapter().resolve("https://www.douyin.com/collection/7123456789012345678"),
        (err: { code?: string; message?: string }) =>
          err.code === "UNSUPPORTED_URL" && /合集/.test(err.message ?? ""),
      );
      assert.equal(called, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("DouyinAdapter.fetchMedia 图文", () => {
  it(
    "图文即使不要画面也返回正文，只写 article.md，不请求任何 mp4",
    withCookies(async () => {
      const originalFetch = globalThis.fetch;
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-note-media-"));
      const mediaRequests: string[] = [];
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url.startsWith("https://www.douyin.com/aweme/v1/web/aweme/detail/")) {
          return Response.json({
            status_code: 0,
            aweme_detail: {
              aweme_id: AWEME_ID,
              desc: "图文文案",
              images: [{ url_list: ["https://cdn.example.com/1.webp"] }],
              video: { duration: 0, play_addr: { url_list: ["https://cdn.example.com/bgm.mp3"] } },
            },
          });
        }
        mediaRequests.push(url);
        throw new Error(`图文不应该下载媒体: ${url}`);
      };
      try {
        const ref = {
          platform: "douyin",
          id: AWEME_ID,
          title: "图文文案",
          durationSec: 0,
          author: "作者",
          pageUrl: `https://www.douyin.com/note/${AWEME_ID}`,
          extras: { awemeId: AWEME_ID, kind: "images" },
        };
        const result = await new DouyinAdapter().fetchMedia(ref, dir, {});
        assert.deepEqual(mediaRequests, []);
        assert.equal(result.articleText, "图文文案");
        assert.equal(result.imagePaths, undefined);
        assert.ok(result.articlePath);
        const md = await fs.readFile(result.articlePath, "utf8");
        assert.ok(md.includes("## 图片"));
        assert.ok(md.includes("https://cdn.example.com/1.webp"));
      } finally {
        globalThis.fetch = originalFetch;
        await fs.rm(dir, { recursive: true, force: true });
      }
    }),
  );
});

describe("DouyinAdapter.fetchMedia", () => {
  it(
    "优先下载带音轨的 play_addr 完整 mp4",
    withCookies(async () => {
      const originalFetch = globalThis.fetch;
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-fetch-test-"));
      const mediaRequests: string[] = [];
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url.startsWith("https://www.douyin.com/aweme/v1/web/aweme/detail/")) {
          return Response.json({
            status_code: 0,
            aweme_detail: {
              aweme_id: AWEME_ID,
              desc: "测试",
              video: {
                duration: 10000,
                play_addr: { url_list: ["https://cdn.example.com/play.mp4"] },
                download_addr: { url_list: ["https://cdn.example.com/download.mp4"] },
              },
            },
          });
        }
        mediaRequests.push(url);
        if (url === "https://cdn.example.com/play.mp4") return new Response("video bytes");
        throw new Error(`意外请求: ${url}`);
      };
      try {
        const adapter = new DouyinAdapter();
        const ref = {
          platform: "douyin",
          id: AWEME_ID,
          title: "测试",
          durationSec: 10,
          author: "作者",
          pageUrl: `https://www.douyin.com/video/${AWEME_ID}`,
          extras: { awemeId: AWEME_ID },
        };

        const result = await adapter.fetchMedia(ref, dir, {
          wantAsr: true,
          wantKeyframes: false,
        });
        assert.deepEqual(mediaRequests, ["https://cdn.example.com/play.mp4"]);
        assert.equal(await fs.readFile(result.videoPath!, "utf8"), "video bytes");
        assert.equal(result.subtitleText, undefined);

        // 既不要字幕也不要画面和音频时，不应发起下载
        mediaRequests.length = 0;
        const skipped = await adapter.fetchMedia(ref, dir, {
          wantSubtitles: true,
          wantAsr: false,
          wantKeyframes: false,
        });
        assert.deepEqual(skipped, {});
        assert.deepEqual(mediaRequests, []);
      } finally {
        globalThis.fetch = originalFetch;
        await fs.rm(dir, { recursive: true, force: true });
      }
    }),
  );
});
