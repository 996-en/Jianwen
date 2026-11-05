import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  WeixinAdapter,
  canHandleWeixin,
  clearWeixinCache,
  parseWeixinArticle,
  parseWeixinInput,
} from "../../src/adapters/weixin.js";
import { WEIXIN_SEED_ARTICLES } from "../../src/adapters/weixin-seeds.js";

// 测试不碰真实缓存，避免把 mock 页里的 chksm 写进项目缓存。
process.env.VIDEO_MCP_WEIXIN_CHKSM_FILE = path.join(
  os.tmpdir(),
  `jianwen-weixin-chksm-${process.pid}.json`,
);

const ARTICLE_HTML = String.raw`<!doctype html>
<html><head>
<meta property="og:title" content="测试文章 &amp; 标题">
<title>备用标题</title>
</head><body>
<script>
var msg_title = '测试文章标题';
var nickname = htmlDecode("测试公众号");
var author = "作者甲";
var ct = "1793235722";
var biz = "MzI0NjUxMzkzMg==";
var mid = "2247722014";
var idx = "1";
var sn = "22eec806d6a5608c3c65dfc32200d676";
var msg_link = "https://mp.weixin.qq.com/s?__biz=MzI0NjUxMzkzMg==&amp;mid=2247722014&amp;idx=1&amp;sn=22eec806d6a5608c3c65dfc32200d676&amp;chksm=e9b30c7ddec4856beb96904e0559d392e81beb57e5bdfe2792cdfb916c51ba342d3510851c5f";
</script>
<div id="js_content" class="rich_media_content">
  <p>第一段 &amp; 内容</p>
  <section><div>嵌套段落</div><p>第二段</p></section>
  <img data-src="https://mmbiz.qpic.cn/mmbiz_jpg/abc/0?wx_fmt=jpeg&amp;from=appmsg" src="data:image/gif;base64,xxx">
</div>
</body></html>`;

const IMAGE_HTML = String.raw`<!doctype html>
<html><head><meta property="og:title" content="图片文章"></head><body>
<script>
var msg_title = "图片文章";
var nickname = "图片号";
var ct = "1793235722";
var biz = "MzI0NjUxMzkzMg==";
var mid = "2247722014";
var idx = "1";
var sn = "22eec806d6a5608c3c65dfc32200d676";
var msg_link = "https://mp.weixin.qq.com/s?__biz=MzI0NjUxMzkzMg==&mid=2247722014&idx=1&sn=22eec806d6a5608c3c65dfc32200d676&chksm=e9b30c7ddec4856beb96904e0559d392e81beb57e5bdfe2792cdfb916c51ba342d3510851c5f";
</script>
<script>var picture_page_info_list = [{"cdn_url":"https:\/\/mmbiz.qpic.cn\/mmbiz_jpg\/abc\/0?wx_fmt=jpeg"}]</script>
</body></html>`;

const CAPTCHA_HTML = `<html><body>环境异常，完成验证后即可继续访问。<script src="https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=x"></script></body></html>`;

const DELETED_HTML = `<html><body><div class="weui-msg"><p>此账号已自主注销，内容无法查看</p></div></body></html>`;
const PRIVATE_HTML = `<html><head><script src="//res.wx.qq.com/mmbizappmsg/zh_CN/htmledition/js/assets/private.mw20q90b6092de3d.js"></script></head><body><div id="app"></div></body></html>`;

const SHORT_URL = "https://mp.weixin.qq.com/s/__eualYM-v92zEARWVszhQ";
const LONG_URL =
  "https://mp.weixin.qq.com/s?__biz=MzI0NjUxMzkzMg==&mid=2247722014&idx=1&sn=22eec806d6a5608c3c65dfc32200d676";
const CHKSM = "e9b30c7ddec4856beb96904e0559d392e81beb57e5bdfe2792cdfb916c51ba342d3510851c5f";
const OWN_CHKSM = "a".repeat(64);

function articleResponse(): Response {
  return new Response(ARTICLE_HTML, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

describe("weixin 输入识别", () => {
  it("识别短链、长链和分享文案", () => {
    const short = parseWeixinInput(SHORT_URL);
    assert.equal(short?.kind, "short");
    assert.equal(short?.shortId, "__eualYM-v92zEARWVszhQ");

    const long = parseWeixinInput(LONG_URL);
    assert.equal(long?.kind, "long");
    assert.equal(long?.biz, "MzI0NjUxMzkzMg==");
    assert.equal(long?.mid, "2247722014");
    assert.equal(long?.sn, "22eec806d6a5608c3c65dfc32200d676");

    assert.equal(canHandleWeixin(`看看这篇 ${SHORT_URL}，很有意思`), true);
    assert.equal(canHandleWeixin("https://www.bilibili.com/video/BV1GJ411x7h7"), false);
  });
});

describe("weixin HTML 解析", () => {
  it("提取标题、公众号、作者、时间、正文和图片", () => {
    const article = parseWeixinArticle(ARTICLE_HTML, parseWeixinInput(SHORT_URL)!);
    assert.equal(article.title, "测试文章标题");
    assert.equal(article.accountName, "测试公众号");
    assert.equal(article.author, "作者甲");
    assert.equal(article.sn, "22eec806d6a5608c3c65dfc32200d676");
    assert.match(article.publishedAt ?? "", /^2026-10-29T/);
    assert.match(article.text, /第一段 & 内容/);
    assert.match(article.text, /嵌套段落/);
    assert.equal(article.imageUrls.length, 1);
    assert.equal(article.imageUrls[0], "https://mmbiz.qpic.cn/mmbiz_jpg/abc/0?wx_fmt=jpeg&from=appmsg");
    assert.equal(article.articleType, "text");
    assert.equal(article.canonicalUrl, SHORT_URL);
  });

  it("图片分享页没有 js_content 时仍返回标题和图片", () => {
    const article = parseWeixinArticle(IMAGE_HTML, parseWeixinInput(LONG_URL)!);
    assert.equal(article.title, "图片文章");
    assert.equal(article.articleType, "image");
    assert.equal(article.imageUrls.length, 1);
    assert.match(article.text, /图片分享，共 1 张图片/);
  });
});

describe("WeixinAdapter.resolve", () => {
  it("短链解析为以 sn 为 id 的 VideoRef", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => articleResponse();
    try {
      clearWeixinCache();
      const ref = await new WeixinAdapter().resolve(SHORT_URL);
      assert.equal(ref.platform, "weixin");
      assert.equal(ref.id, "22eec806d6a5608c3c65dfc32200d676");
      assert.equal(ref.title, "测试文章标题");
      assert.equal(ref.author, "测试公众号");
      assert.equal(ref.durationSec, 0);
      assert.equal(ref.pageUrl, SHORT_URL);
      assert.equal(ref.extras?.sn, "22eec806d6a5608c3c65dfc32200d676");
      assert.equal(ref.extras?.chksm, CHKSM);
      assert.equal(ref.extras?.articleType, "text");
    } finally {
      globalThis.fetch = originalFetch;
      clearWeixinCache();
    }
  });

  it("长链遇到验证码且没有 chksm 时返回 WEIXIN_CAPTCHA", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(CAPTCHA_HTML, { status: 200, headers: { "content-type": "text/html" } });
    try {
      clearWeixinCache();
      delete process.env.VIDEO_MCP_WEIXIN_CHKSM;
      await assert.rejects(
        () => new WeixinAdapter().resolve(LONG_URL),
        (err: { code?: string }) => err.code === "WEIXIN_CAPTCHA",
      );
    } finally {
      globalThis.fetch = originalFetch;
      clearWeixinCache();
    }
  });

  it("没有缓存时从内置人民日报文章种子学习 chksm", async () => {
    const originalFetch = globalThis.fetch;
    const seedChksm = chksmOf(WEIXIN_SEED_ARTICLES[0]!.url);
    const originalSearch = process.env.VIDEO_MCP_WEIXIN_SEARCH;
    let targetRequest = "";
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("getappmsgext")) {
        return new Response(JSON.stringify({ base_resp: { ret: 0 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes(`chksm=${seedChksm}`)) {
        targetRequest = url;
        return articleResponse();
      }
      return new Response(CAPTCHA_HTML, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };
    try {
      clearWeixinCache();
      delete process.env.VIDEO_MCP_WEIXIN_CHKSM;
      process.env.VIDEO_MCP_WEIXIN_SEARCH = "0";
      const ref = await new WeixinAdapter().resolve(LONG_URL);
      assert.equal(ref.title, "测试文章标题");
      assert.match(targetRequest, new RegExp(`chksm=${seedChksm}`));
    } finally {
      globalThis.fetch = originalFetch;
      if (originalSearch === undefined) delete process.env.VIDEO_MCP_WEIXIN_SEARCH;
      else process.env.VIDEO_MCP_WEIXIN_SEARCH = originalSearch;
      clearWeixinCache();
    }
  });

  it("第一个种子签名失效时继续尝试下一个", async () => {
    const originalFetch = globalThis.fetch;
    const first = chksmOf(WEIXIN_SEED_ARTICLES[0]!.url);
    const second = chksmOf(WEIXIN_SEED_ARTICLES[1]!.url);
    const originalSearch = process.env.VIDEO_MCP_WEIXIN_SEARCH;
    const requested: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("getappmsgext")) {
        return new Response(JSON.stringify({ base_resp: { ret: 0 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      requested.push(url);
      if (url.includes(`chksm=${second}`)) return articleResponse();
      if (url.includes(`chksm=${first}`)) {
        return new Response(CAPTCHA_HTML, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response(CAPTCHA_HTML, { status: 200, headers: { "content-type": "text/html" } });
    };
    try {
      clearWeixinCache();
      delete process.env.VIDEO_MCP_WEIXIN_CHKSM;
      process.env.VIDEO_MCP_WEIXIN_SEARCH = "0";
      const ref = await new WeixinAdapter().resolve(LONG_URL);
      assert.equal(ref.title, "测试文章标题");
      assert.equal(requested.some((url) => url.includes(`chksm=${first}`)), true);
      assert.equal(requested.some((url) => url.includes(`chksm=${second}`)), true);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalSearch === undefined) delete process.env.VIDEO_MCP_WEIXIN_SEARCH;
      else process.env.VIDEO_MCP_WEIXIN_SEARCH = originalSearch;
      clearWeixinCache();
    }
  });

  it("作者隐私设置页返回 NOT_FOUND 并说明原因", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(PRIVATE_HTML, { status: 200, headers: { "content-type": "text/html" } });
    try {
      clearWeixinCache();
      delete process.env.VIDEO_MCP_WEIXIN_CHKSM;
      await assert.rejects(
        () => new WeixinAdapter().resolve(LONG_URL),
        (err: { code?: string; message?: string }) =>
          err.code === "NOT_FOUND" && /作者隐私设置/.test(err.message ?? ""),
      );
    } finally {
      globalThis.fetch = originalFetch;
      clearWeixinCache();
    }
  });

  it("账号注销或内容下架时返回 NOT_FOUND 并说明原因", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(DELETED_HTML, { status: 200, headers: { "content-type": "text/html" } });
    try {
      clearWeixinCache();
      delete process.env.VIDEO_MCP_WEIXIN_CHKSM;
      await assert.rejects(
        () => new WeixinAdapter().resolve(LONG_URL),
        (err: { code?: string; message?: string }) =>
          err.code === "NOT_FOUND" && /账号已注销/.test(err.message ?? ""),
      );
    } finally {
      globalThis.fetch = originalFetch;
      clearWeixinCache();
    }
  });

  it("带 chksm 命中注销页时也返回 NOT_FOUND", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      return new Response(url.includes("chksm=") ? DELETED_HTML : CAPTCHA_HTML, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };
    try {
      clearWeixinCache();
      process.env.VIDEO_MCP_WEIXIN_CHKSM = "test-chksm";
      await assert.rejects(
        () => new WeixinAdapter().resolve(LONG_URL),
        (err: { code?: string; message?: string }) =>
          err.code === "NOT_FOUND" && /账号已注销/.test(err.message ?? ""),
      );
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.VIDEO_MCP_WEIXIN_CHKSM;
      clearWeixinCache();
    }
  });

  it("长链自带的 chksm 优先于缓存值", async () => {
    const originalFetch = globalThis.fetch;
    let requested = "";
    globalThis.fetch = async (input) => {
      const url = String(input);
      requested = url;
      return url.includes(`chksm=${OWN_CHKSM}`)
        ? articleResponse()
        : new Response(CAPTCHA_HTML, { status: 200, headers: { "content-type": "text/html" } });
    };
    const originalChksm = process.env.VIDEO_MCP_WEIXIN_CHKSM;
    process.env.VIDEO_MCP_WEIXIN_CHKSM = CHKSM;
    try {
      clearWeixinCache();
      const url = `${LONG_URL}&chksm=${OWN_CHKSM}`;
      await new WeixinAdapter().resolve(url);
      assert.match(requested, new RegExp(`chksm=${OWN_CHKSM}`));
    } finally {
      globalThis.fetch = originalFetch;
      if (originalChksm === undefined) delete process.env.VIDEO_MCP_WEIXIN_CHKSM;
      else process.env.VIDEO_MCP_WEIXIN_CHKSM = originalChksm;
      clearWeixinCache();
    }
  });

  it("配置 chksm 后请求自动带上该参数", async () => {
    const originalFetch = globalThis.fetch;
    let requested = "";
    globalThis.fetch = async (input) => {
      requested = String(input);
      return articleResponse();
    };
    const originalChksm = process.env.VIDEO_MCP_WEIXIN_CHKSM;
    process.env.VIDEO_MCP_WEIXIN_CHKSM = CHKSM;
    try {
      clearWeixinCache();
      const ref = await new WeixinAdapter().resolve(LONG_URL);
      assert.match(requested, new RegExp(`chksm=${CHKSM}`));
      assert.equal(ref.id, "22eec806d6a5608c3c65dfc32200d676");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalChksm === undefined) delete process.env.VIDEO_MCP_WEIXIN_CHKSM;
      else process.env.VIDEO_MCP_WEIXIN_CHKSM = originalChksm;
      clearWeixinCache();
    }
  });
});

describe("WeixinAdapter.fetchMedia", () => {
  it("写入 article.md/html，并按 wantKeyframes 下载正文图片", async () => {
    const originalFetch = globalThis.fetch;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "weixin-fetch-test-"));
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("mmbiz.qpic.cn")) {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      return articleResponse();
    };
    try {
      clearWeixinCache();
      const adapter = new WeixinAdapter();
      const ref = await adapter.resolve(SHORT_URL);
      const media = await adapter.fetchMedia(ref, dir, { wantKeyframes: true });
      assert.match(media.articleText ?? "", /第二段/);
      assert.equal(media.imagePaths?.length, 1);
      assert.equal(path.extname(media.imagePaths![0]!), ".png");
      assert.equal(await exists(media.articlePath!), true);
      assert.equal(await exists(media.articleHtmlPath!), true);
      assert.match(await fs.readFile(media.articlePath!, "utf8"), /## 图片/);
    } finally {
      globalThis.fetch = originalFetch;
      clearWeixinCache();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

function chksmOf(url: string): string {
  const match = /[?&]chksm=([0-9a-f]+)/i.exec(url);
  assert.ok(match?.[1], `seed URL should contain chksm: ${url}`);
  return match[1]!;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
