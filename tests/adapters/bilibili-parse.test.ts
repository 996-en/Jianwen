import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBiliLink } from "../../src/adapters/bilibili-parse.js";

function kindOf(input: string): string | undefined {
  return parseBiliLink(input)?.kind;
}

describe("parseBiliLink 链接分类", () => {
  it("视频：BV / av / 带 query 的页面", () => {
    assert.deepEqual(parseBiliLink("BV1GJ411x7h7"), {
      kind: "video",
      id: "BV1GJ411x7h7",
      page: 1,
    });
    assert.equal(parseBiliLink("av170001")?.id, "av170001");
    assert.equal(
      parseBiliLink("https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=333.1")?.kind,
      "video",
    );
  });

  it("视频分 P：?p=N 解析，非法值归 1", () => {
    assert.equal(
      parseBiliLink("https://www.bilibili.com/video/BV1GJ411x7h7?p=3")?.page,
      3,
    );
    assert.equal(parseBiliLink("https://www.bilibili.com/video/BV1GJ411x7h7?p=0")?.page, 1);
    assert.equal(parseBiliLink("https://www.bilibili.com/video/BV1GJ411x7h7?p=abc")?.page, 1);
  });

  it("番剧：ep / ss / md", () => {
    assert.deepEqual(parseBiliLink("https://www.bilibili.com/bangumi/play/ep323085"), {
      kind: "bangumi",
      id: "323085",
      page: 1,
      seasonType: "ep",
    });
    assert.equal(
      parseBiliLink("https://www.bilibili.com/bangumi/play/ss33415")?.seasonType,
      "ss",
    );
    assert.equal(
      parseBiliLink("https://www.bilibili.com/bangumi/play/md28223022")?.seasonType,
      "md",
    );
  });

  it("课程：cheese ep / ss", () => {
    assert.deepEqual(parseBiliLink("https://www.bilibili.com/cheese/play/ep9"), {
      kind: "cheese",
      id: "9",
      page: 1,
      seasonType: "ep",
    });
    assert.equal(
      parseBiliLink("https://www.bilibili.com/cheese/play/ss100")?.seasonType,
      "ss",
    );
  });

  it("动态：/opus/、t.bilibili.com、m 站 dynamic", () => {
    assert.equal(
      parseBiliLink("https://www.bilibili.com/opus/1049275096172068880")?.id,
      "1049275096172068880",
    );
    assert.equal(parseBiliLink("https://t.bilibili.com/1049275096172068880")?.kind, "opus");
    assert.equal(
      parseBiliLink("https://m.bilibili.com/dynamic/1049275096172068880")?.kind,
      "opus",
    );
    // 旧版动态页链接里的 ?id= 形式
    assert.equal(
      parseBiliLink("https://t.bilibili.com/?id=1049275096172068880")?.id,
      "1049275096172068880",
    );
  });

  it("专栏：read/cv 与 read/mobile?id=", () => {
    assert.deepEqual(parseBiliLink("https://www.bilibili.com/read/cv29130272"), {
      kind: "article",
      id: "29130272",
      page: 1,
    });
    assert.equal(
      parseBiliLink("https://www.bilibili.com/read/mobile?id=29130272")?.kind,
      "article",
    );
  });

  it("音频：/audio/au<id>", () => {
    assert.equal(parseBiliLink("https://www.bilibili.com/audio/au12345")?.kind, "audio");
  });

  it("短链：b23.tv", () => {
    assert.deepEqual(parseBiliLink("https://b23.tv/abcdefg"), {
      kind: "short",
      id: "abcdefg",
      page: 1,
    });
    // 分享文案里夹着短链
    assert.equal(
      parseBiliLink("【标题】 https://b23.tv/abcdefg 复制打开")?.kind,
      "short",
    );
  });

  it("其他 bilibili.com 链接归为 unknown，非 B 站输入返回 null", () => {
    assert.equal(kindOf("https://live.bilibili.com/12345"), "unknown");
    assert.equal(kindOf("https://space.bilibili.com/946974"), "unknown");
    assert.equal(kindOf("https://www.bilibili.com/video/BV1GJ411x7h7/favlist?fid=1"), "video");
    assert.equal(parseBiliLink("https://www.youtube.com/watch?v=1"), null);
    assert.equal(parseBiliLink("随便一段话"), null);
  });
});
