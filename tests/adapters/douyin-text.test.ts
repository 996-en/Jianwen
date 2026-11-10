import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  cleanMarkdown,
  fetchDouyinTextMedia,
  imageUrlsOf,
  parseArticleInfo,
} from "../../src/adapters/douyin-text.js";
import type { VideoRef } from "../../src/types.js";

const ID = "7653690230587475314";
const IMAGE_1 = "https://p26-sign.douyinpic.com/a.jpeg?lk3s=1&x-signature=aaa";
const IMAGE_2 = "https://p26-sign.douyinpic.com/b.jpeg?lk3s=1&x-signature=bbb";

const MARKDOWN = [
  "朋友们好，我是莫言。今天是父亲节，聊聊我的父亲吧。",
  "",
  `![图片描述](${IMAGE_1} width=1053 height=400)`,
  "",
  `![图片描述](${IMAGE_2} width=1053 height=400)`,
].join("\n");

const articleInfo = {
  article_id: ID,
  article_title: "莫言：我的父亲",
  article_type: 999,
  read_time: 4,
  // 真实接口里 article_content 是 JSON 字符串
  article_content: JSON.stringify({ markdown: MARKDOWN, long_article_abstract: "摘要" }),
};

function ref(): VideoRef {
  return {
    platform: "douyin",
    id: ID,
    title: "莫言：我的父亲",
    durationSec: 0,
    author: "莫言",
    pageUrl: `https://www.douyin.com/article/${ID}`,
    extras: { awemeId: ID, kind: "article" },
  };
}

describe("抖音长文解析", () => {
  it("解开嵌套 JSON 字符串，保留原始 markdown", () => {
    const article = parseArticleInfo(articleInfo);
    assert.ok(article);
    assert.equal(article.title, "莫言：我的父亲");
    assert.equal(article.articleId, ID);
    assert.equal(article.readTime, 4);
    assert.equal(article.rawMarkdown, MARKDOWN);
    assert.deepEqual(article.imageUrls, [IMAGE_1, IMAGE_2]);
  });

  it("去掉图片尺寸尾巴，标准 Markdown 才能正常渲染", () => {
    const article = parseArticleInfo(articleInfo);
    assert.ok(article);
    assert.ok(article.markdown.includes(`![图片描述](${IMAGE_1})`));
    assert.ok(!article.markdown.includes("width="));
  });

  it("没有正文时返回 null，不会被当成视频或长文", () => {
    assert.equal(parseArticleInfo(undefined), null);
    assert.equal(parseArticleInfo({ article_title: "空" }), null);
    assert.equal(parseArticleInfo("not-json"), null);
  });

  it("cleanMarkdown 只清理图片语法，不动正文", () => {
    assert.equal(cleanMarkdown(`文字\n![a](${IMAGE_1} width=1 height=2)`), `文字\n![a](${IMAGE_1})`);
    assert.equal(cleanMarkdown("普通段落"), "普通段落");
  });
});

describe("抖音图文图片地址", () => {
  it("优先无水印 url_list，并去重", () => {
    const urls = imageUrlsOf({
      images: [
        {
          url_list: ["https://cdn/a.webp"],
          download_url_list: ["https://cdn/a-water.webp"],
        },
        { download_url_list: ["https://cdn/b.webp"] },
        { url_list: ["https://cdn/a.webp"] },
      ],
    });
    assert.deepEqual(urls, ["https://cdn/a.webp", "https://cdn/b.webp"]);
  });

  it("没有 images 的视频作品不算图文", () => {
    assert.deepEqual(imageUrlsOf({ images: null }), []);
    assert.deepEqual(imageUrlsOf({}), []);
  });
});

describe("fetchDouyinTextMedia", () => {
  it("长文默认落 article.md + 原始 markdown + JSON，且不下载图片", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-article-test-"));
    const originalFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = async () => {
      fetched += 1;
      throw new Error("默认不应该发起任何网络请求");
    };
    try {
      const media = await fetchDouyinTextMedia({ aweme_id: ID, article_info: articleInfo }, ref(), dir);
      assert.equal(fetched, 0);
      assert.ok(media.articleText?.includes("今天是父亲节"));
      assert.equal(media.imagePaths, undefined);

      const md = await fs.readFile(path.join(dir, "article.md"), "utf8");
      assert.ok(md.startsWith("# 莫言：我的父亲"));
      assert.ok(md.includes(`![图片1](${IMAGE_1})`));

      const original = await fs.readFile(path.join(dir, "article.original.md"), "utf8");
      assert.equal(original, MARKDOWN);

      const json = JSON.parse(await fs.readFile(path.join(dir, "article.json"), "utf8")) as {
        article_title?: string;
      };
      assert.equal(json.article_title, "莫言：我的父亲");
      assert.ok(media.notes?.some((note) => note.includes("默认不下载") || note.includes("article.original.md")));
    } finally {
      globalThis.fetch = originalFetch;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("图文只有文案，wantKeyframes=true 时才下载图片", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-images-test-"));
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/webp" },
      });
    };
    try {
      const aweme = {
        aweme_id: "7606203811229940709",
        desc: "2026年最新思想汇报！可借鉴！！！",
        images: [{ url_list: [IMAGE_1] }, { url_list: [IMAGE_2] }],
      };

      const plain = await fetchDouyinTextMedia(aweme, ref(), dir);
      assert.equal(requested.length, 0);
      assert.equal(plain.imagePaths, undefined);
      assert.equal(plain.articleText, "2026年最新思想汇报！可借鉴！！！");

      const withImages = await fetchDouyinTextMedia(aweme, ref(), dir, { wantKeyframes: true });
      assert.deepEqual(requested, [IMAGE_1, IMAGE_2]);
      assert.equal(withImages.imagePaths?.length, 2);
      assert.deepEqual(
        withImages.imagePaths?.map((file) => path.basename(file)),
        ["001.webp", "002.webp"],
      );
    } finally {
      globalThis.fetch = originalFetch;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
