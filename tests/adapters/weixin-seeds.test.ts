import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseWeixinInput } from "../../src/adapters/weixin.js";
import { WEIXIN_SEED_ARTICLES } from "../../src/adapters/weixin-seeds.js";

describe("weixin 种子文章", () => {
  it("包含 20 条自带 chksm 的人民日报长链，并覆盖多个时间段", () => {
    assert.equal(WEIXIN_SEED_ARTICLES.length, 20);
    assert.equal(new Set(WEIXIN_SEED_ARTICLES.map((seed) => seed.url)).size, 20);
    assert.equal(WEIXIN_SEED_ARTICLES[0]?.month.slice(0, 4), "2017");
    assert.equal(WEIXIN_SEED_ARTICLES.at(-1)?.month.slice(0, 4), "2026");

    for (const seed of WEIXIN_SEED_ARTICLES) {
      const parsed = parseWeixinInput(seed.url);
      assert.equal(parsed?.kind, "long");
      assert.match(parsed?.chksm ?? "", /^[0-9a-f]{20,}$/i);
      assert.match(seed.url, new RegExp(`chksm=${parsed?.chksm}`));
    }
  });
});
