import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractAwemeId,
  isDouyinInput,
  parseDouyinLink,
} from "../../src/adapters/douyin-parse.js";

const ID = "7606203811229940709";
const SEC_UID = "MS4wLjABAAAADl3WHEkaQ1tcD4-15S_njfDxf-DzI9AkhXGz-HzyVcwwP7GcoVu0dhm2b-MjmSUQ";

describe("parseDouyinLink", () => {
  it("识别视频、图文、长文三种单作品链接", () => {
    assert.deepEqual(parseDouyinLink(`https://www.douyin.com/video/${ID}`), {
      kind: "video",
      id: ID,
    });
    assert.deepEqual(parseDouyinLink(`https://www.douyin.com/note/${ID}?previous_page=web_code_link`), {
      kind: "note",
      id: ID,
    });
    assert.deepEqual(parseDouyinLink(`https://www.douyin.com/article/${ID}`), {
      kind: "article",
      id: ID,
    });
  });

  it("识别 iesdouyin 分享页，/share/slides 归为图文", () => {
    assert.deepEqual(
      parseDouyinLink(`https://www.iesdouyin.com/share/video/${ID}/?region=CN&mid=1`),
      { kind: "video", id: ID },
    );
    assert.deepEqual(parseDouyinLink(`https://www.iesdouyin.com/share/slides/${ID}/`), {
      kind: "note",
      id: ID,
    });
    assert.deepEqual(parseDouyinLink(`https://www.iesdouyin.com/share/note/${ID}/`), {
      kind: "note",
      id: ID,
    });
  });

  it("识别主页弹窗的 modal_id、裸 ID 和短链", () => {
    assert.deepEqual(parseDouyinLink(`https://www.douyin.com/user/${SEC_UID}?modal_id=${ID}`), {
      kind: "user",
      id: SEC_UID,
    });
    assert.deepEqual(parseDouyinLink(`https://www.douyin.com/?modal_id=${ID}`), {
      kind: "video",
      id: ID,
    });
    assert.deepEqual(parseDouyinLink(ID), { kind: "video", id: ID });
    assert.deepEqual(
      parseDouyinLink("4.17 复制打开抖音 https://v.douyin.com/6hrIkmZ5qcI/ 直接观看"),
      { kind: "short", id: "6hrIkmZ5qcI" },
    );
  });

  it("列表页和直播单独归类，方便给出明确提示", () => {
    assert.deepEqual(parseDouyinLink(`https://www.douyin.com/user/${SEC_UID}`), {
      kind: "user",
      id: SEC_UID,
    });
    assert.deepEqual(parseDouyinLink("https://www.douyin.com/collection/7123456789012345678"), {
      kind: "collection",
      id: "7123456789012345678",
    });
    assert.deepEqual(parseDouyinLink("https://www.iesdouyin.com/share/mix/7123456789012345678"), {
      kind: "collection",
      id: "7123456789012345678",
    });
    assert.deepEqual(parseDouyinLink("https://live.douyin.com/123456789"), {
      kind: "live",
      id: "123456789",
    });
    assert.deepEqual(parseDouyinLink("https://www.douyin.com/search/%E7%88%B1%E6%83%85"), {
      kind: "unknown",
      id: "",
    });
  });

  it("非抖音输入返回 null，短链只当输入、不当作 ID", () => {
    assert.equal(parseDouyinLink("https://www.bilibili.com/video/BV1GJ411x7h7"), null);
    assert.equal(parseDouyinLink("hello"), null);
    assert.equal(isDouyinInput("https://www.douyin.com/user/" + SEC_UID), true);
    assert.equal(isDouyinInput("https://www.bilibili.com/video/BV1GJ411x7h7"), false);
    assert.equal(extractAwemeId("https://v.douyin.com/6hrIkmZ5qcI/"), null);
    assert.equal(extractAwemeId(`https://www.douyin.com/article/${ID}`), ID);
  });
});
