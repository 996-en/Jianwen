import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it } from "node:test";
import {
  WEBSIGN_SALT,
  buildDetailQuery,
  canonicalizeQuery,
  computeWebSignature,
  detailParams,
} from "../../src/adapters/douyin-sign.js";

describe("抖音详情接口签名", () => {
  it("规范化 query：key 不重编码、value 重编码、只剔除签名参数（timestamp 参与签名）", () => {
    const raw =
      "device_platform=webapp&aweme_id=123&keyword=a+b%26c&timestamp=1700000000&x-secsdk-web-signature=deadbeef";
    assert.equal(
      canonicalizeQuery(raw),
      "device_platform=webapp&aweme_id=123&keyword=a%20b%26c&timestamp=1700000000",
    );
  });

  it("签名是 md5(uifid_timestamp_salt_query) 的小写十六进制", () => {
    const query = "aid=6383&aweme_id=1&uifid=u1";
    const sig = computeWebSignature(query, "u1", 1700000000);
    const expected = crypto
      .createHash("md5")
      .update(`u1_1700000000_${WEBSIGN_SALT}_${query}`, "utf8")
      .digest("hex");
    assert.equal(sig, expected);
    assert.match(sig, /^[0-9a-f]{32}$/);
  });

  it("生成的 query 带 uifid/timestamp/签名，且签名可被独立复算", () => {
    const uifid = "abc+/=def";
    const query = buildDetailQuery(
      [
        ["device_platform", "webapp"],
        ["aid", "6383"],
      ],
      uifid,
      1700000000,
    );
    const params = new URLSearchParams(query);
    assert.equal(params.get("uifid"), uifid);
    assert.equal(params.get("timestamp"), "1700000000");
    const signature = params.get("x-secsdk-web-signature");
    assert.match(String(signature), /^[0-9a-f]{32}$/);
    assert.equal(
      signature,
      computeWebSignature(canonicalizeQuery(query), uifid, 1700000000),
    );
    // 回归：timestamp 必须参与签名（浏览器真实请求验证过，剔除 timestamp 会得到不同签名）
    const canonicalWithoutTs = canonicalizeQuery(query)
      .split("&")
      .filter((p) => !p.startsWith("timestamp="))
      .join("&");
    assert.notEqual(signature, computeWebSignature(canonicalWithoutTs, uifid, 1700000000));
  });

  it("网页端参数顺序固定，且包含详情接口要求的 aweme_id", () => {
    const params = detailParams("7703476743591513353");
    assert.deepEqual(params.slice(0, 4), [
      ["device_platform", "webapp"],
      ["aid", "6383"],
      ["channel", "channel_pc_web"],
      ["aweme_id", "7703476743591513353"],
    ]);
    const keys = params.map(([k]) => k);
    assert.equal(new Set(keys).size, keys.length);
  });
});
