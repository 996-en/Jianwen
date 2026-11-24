import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const id = "6ad811a1000000002b00dda7";
const pageUrl = `https://www.xiaohongshu.com/explore/${id}`;
const note = { noteId: id, type: "normal", title: "测试笔记" };
const desktop = (data: object) => ({ note: { noteDetailMap: { [id]: { note: { ...note, ...data } } } } });

test("小红书互动数（离线）", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "jianwen-xhs-stats-"));
  const env = {
    VIDEO_MCP_CACHE_DIR: tmp,
    VIDEO_MCP_XHS_COOKIE_FILE: path.join(tmp, "not-present.txt"),
    VIDEO_MCP_XHS_COOKIES: "",
  };
  const previous = Object.entries(env).map(([key]) => [key, process.env[key]] as const);
  Object.assign(process.env, env);
  t.after(async () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(tmp, { recursive: true, force: true });
  });

  let state: object = {};
  let htmlRequests = 0;
  const originalExecFile = childProcess.execFile;
  // 使用普通函数替代 execFile，避免 mock 代理保留旧的 promisify.custom 而调用真实 curl。
  Object.assign(childProcess, { execFile(
    _file: string, _args: string[], _options: object, callback: (error: null, result: { stdout: string }) => void,
  ) {
    htmlRequests++;
    callback(null, { stdout: `<script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>` });
  } });
  syncBuiltinESMExports();
  const { resolveInput } = await import("../../src/resolve.js").finally(() => {
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
  });

  await t.test("电脑网页：从原有请求读取四类数字，保留 0", async (sub) => {
    sub.mock.method(globalThis, "fetch", async () => assert.fail("读取互动数不应额外请求"));
    state = desktop({ interactInfo: { likedCount: "1.2万", commentCount: 0, collectedCount: "1，234", shareCount: "99+" } });
    const result = await resolveInput({ url: pageUrl });
    assert.equal(result.extras?.kind, "images");
    assert.equal(htmlRequests, 1);
    assert.deepEqual(result.stats, { likes: 12_000, comments: 0, favorites: 1234, shares: 99 });
  });

  await t.test("手机网页：视频笔记读取缩写，跳过未知数字", async () => {
    state = { noteData: { data: { noteData: { ...note, type: "video",
      interactInfo: { likedCount: "1.2345W", commentCount: "未知", collectedCount: "0", shareCount: "1.1亿" },
    } } } };
    const result = await resolveInput({ url: `https://www.xiaohongshu.com/discovery/item/${id}` });
    assert.equal(result.extras?.kind, "video");
    assert.deepEqual(result.stats, { likes: 12345, favorites: 0, shares: 110_000_000 });
  });

  await t.test("平台没提供有效数字时，整个 stats 留空", async () => {
    for (const data of [
      {},
      { interactInfo: { likedCount: null, commentCount: -1, collectedCount: "9,1", shareCount: "9007199254740992" } },
    ]) {
      state = desktop(data);
      assert.ok(!Object.hasOwn(await resolveInput({ url: pageUrl }), "stats"));
    }
  });

  await t.test("网页没有笔记时，Feed 回源也保留互动数", async (sub) => {
    state = {};
    process.env.VIDEO_MCP_XHS_COOKIES = "a1=fixture-value";
    const feed = sub.mock.method(globalThis, "fetch", async (url: string) => {
      assert.equal(url, "https://edith.xiaohongshu.com/api/sns/web/v1/feed");
      return Response.json({ data: { items: [{ note_card: {
        note_id: id, type: "normal",
        interact_info: { liked_count: 15, comment_count: "7", collected_count: "1.5k", share_count: "0" },
      } }] } });
    });
    const result = await resolveInput({ url: pageUrl });
    assert.equal(feed.mock.callCount(), 1);
    assert.deepEqual(result.stats, { likes: 15, comments: 7, favorites: 1500, shares: 0 });
  });
});
