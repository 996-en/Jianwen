import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeXhsShareShortUrl, pickXhsShareShortUrl } from "../../src/adapters/xiaohongshu-api.js";
import {
  XiaohongshuAdapter,
  extractXhsSearchKeywords,
  shareQueryExtras,
  extractXsecSource,
  extractXsecSources,
  extractXsecTokens,
  notePageCandidates,
  parseXhsState,
  resolveUrl,
  xhsInputUrl,
} from "../../src/adapters/xiaohongshu.js";
import { findAdapter } from "../../src/adapters/registry.js";

describe("小红书链接识别", () => {
  it("同时出现短链与长链时优先短链", () => {
    const text = "标题 http://www.xiaohongshu.com/explore/6ad811a1000000002b00dda7 复制 https://xhslink.cn/o/test";
    assert.equal(xhsInputUrl(text)?.hostname, "xhslink.cn");
  });

  it("识别电脑、手机长链接和分享文本里的短链，不误判其他域名", () => {
    const id = "6ad811a1000000002b00dda7";
    assert.equal(findAdapter(`https://www.xiaohongshu.com/explore/${id}?xsec_token=test`).platform, "xiaohongshu");
    assert.equal(findAdapter(`https://www.xiaohongshu.com/discovery/item/${id}?xsec_token=test`).platform, "xiaohongshu");
    assert.equal(findAdapter("复制打开小红书 http://xhslink.com/o/abc ，看看").platform, "xiaohongshu");
    assert.equal(findAdapter("https://xhslink.cn/o/abc").platform, "xiaohongshu");
    assert.equal(xhsInputUrl("https://xhslink.cn.evil.example/o/abc"), null);
    assert.equal(xhsInputUrl("https://xiaohongshu.com.evil.example/explore/abc"), null);
    assert.equal(xhsInputUrl("https://xiaohongshu.com@evil.example/"), null);
    assert.equal(xhsInputUrl("https://evil.example@xiaohongshu.com/"), null);
  });

  it("短链跳到手机笔记后保留完整令牌", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "https://www.xiaohongshu.com/discovery/item/6ad811a1000000002b00dda7?xsec_token=a%2Bb%3D&xsec_source=app_share" } });
    try {
      const url = await resolveUrl("复制链接 https://xhslink.cn/o/test 然后打开");
      assert.equal(url.pathname, "/discovery/item/6ad811a1000000002b00dda7");
      assert.equal(url.searchParams.get("xsec_token"), "a+b=");
      assert.equal(url.searchParams.get("xsec_source"), "app_share");
    } finally { globalThis.fetch = original; }
  });

  it("不跟随短链跳转到非小红书域名", async () => {
    const original = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => { requests++; return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }); };
    try {
      await assert.rejects(new XiaohongshuAdapter().resolve("https://xhslink.com/o/test"), /短链接跳转无效/);
      assert.equal(requests, 1);
    } finally { globalThis.fetch = original; }
  });
});

describe("畸形分享链接", () => {
  it("从分享正文截取搜索用词", () => {
    const raw = "奇瑞风云t9l提车一个月毛病不断\nhttp://www.xiaohongshu.com/explore/6a96374e0000000012035f3b?xsec_token=a";
    assert.deepEqual(extractXhsSearchKeywords(raw, "6a96374e0000000012035f3b"), ["奇瑞风云t9l提车一个月毛病不断"]);
  });

  it("从 short_url 响应里抽出 xhslink", () => {
    assert.equal(pickXhsShareShortUrl({ data: { share_link: "https://xhslink.cn/o/abc123" } }), "https://xhslink.cn/o/abc123");
    assert.equal(pickXhsShareShortUrl({ data: { short_url: "xhslink.com/m/5zCyMph6vOj" } }), "https://xhslink.com/m/5zCyMph6vOj");
    assert.equal(normalizeXhsShareShortUrl("xhslink.cn/o/abc"), "https://xhslink.cn/o/abc");
    assert.equal(pickXhsShareShortUrl({ nested: { url: "前缀 https://xhslink.com/a/XYZ 后缀" } }), "https://xhslink.com/a/XYZ");
  });

  it("从原文提取多个 xsec_token 并生成候选 URL", () => {
    const raw = "http://www.xiaohongshu.com/explore/6a96374e0000000012035f3b?xsec_token=CB-a&xsec_source=app_share?xsec_token=CB-b";
    assert.deepEqual(extractXsecTokens(raw), ["CB-a", "CB-b"]);
    assert.deepEqual(extractXsecSources(raw), ["app_share"]);
    const urls = notePageCandidates("6a96374e0000000012035f3b", ["CB-b"], ["app_share"], "");
    assert.ok(urls.some((u) => /xsec_token=CB-b/.test(u)));
    assert.ok(urls.some((u) => u.includes("/discovery/item/")));
    assert.ok(urls.some((u) => u.includes("/explore/")));
  });

  it("App 分享候选 URL 带上 app_platform", () => {
    const urls = notePageCandidates("6aae57820000000025034052", ["t"], ["app_share"], "");
    assert.ok(urls.some((u) => u.includes("app_platform=ios")));
  });

  it("shareQueryExtras 从原链接复制 app 参数", () => {
    const raw = "https://www.xiaohongshu.com/discovery/item/x?app_platform=android&type=video";
    assert.equal(shareQueryExtras(raw, "app_share").app_platform, "android");
    assert.equal(shareQueryExtras(raw, "app_share").type, "video");
  });

  it("不把畸形 query 拼进 xsec_source", () => {
    const raw = "?xsec_source=pc_share?xsec_token=CBd&source=webshare";
    assert.equal(extractXsecSource(raw), "pc_share");
    assert.deepEqual(extractXsecSources(raw), ["pc_share", "webshare"]);
  });
});

describe("小红书网页状态", () => {
  it("解析 undefined，同时保留字符串中的同名文本与转义字符", () => {
    const result = parseXhsState('<script>window.__INITIAL_STATE__={"a":undefined,"text":"undefined and \\\"quoted\\\""}</script>');
    assert.equal(result.a, null);
    assert.equal(result.text, 'undefined and "quoted"');
  });
  it("不执行网页 JavaScript", () => {
    assert.throws(() => parseXhsState('<script>window.__INITIAL_STATE__={"x":(globalThis.__xhsUnsafe=1)}</script>'));
    assert.equal((globalThis as Record<string, unknown>).__xhsUnsafe, undefined);
  });
  it("无状态时明确报错", () => assert.throws(() => parseXhsState("<html></html>"), /可能需要登录/));
});
