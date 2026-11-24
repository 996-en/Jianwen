import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseXhsCookieFile } from "../../src/adapters/xiaohongshu-cookie.js";

describe("小红书 Cookie 解析", () => {
  it("只保留 xiaohongshu 域", () => {
    const text = ".xiaohongshu.com\tTRUE\t/\tTRUE\t1999999999\ta1\tabc\n";
    assert.equal(parseXhsCookieFile(text)[0]?.value, "abc");
    assert.equal(parseXhsCookieFile(".douyin.com\tTRUE\t/\tTRUE\t1\tx\ty\n").length, 0);
  });
});