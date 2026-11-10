import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VideoRef } from "../../src/types.js";
import { assertPgcWatchable, fetchPgcPlayurl, resolveBangumiRef, resolveCheeseRef } from "../../src/adapters/bilibili-pgc.js";
import { isRateLimit } from "../../src/adapters/bilibili-api.js";

/** 用假的 fetch 冒充 B 站接口，测试里不联网 */
function stubFetch(routes: Record<string, unknown>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    for (const [prefix, body] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return Response.json(body);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const BANGUMI_SEASON = {
  code: 0,
  message: "success",
  result: {
    season_id: 33415,
    season_title: "名侦探柯南（中配）",
    title: "名侦探柯南（中配）",
    cover: "https://i0.hdslb.com/bfs/cover.jpg",
    up_info: { uname: "哔哩哔哩番剧" },
    stat: { views: 123456, favorites: 1000, likes: 20, coins: 3, replies: 4, share: 5, danmakus: 6 },
    episodes: [
      {
        id: 323084,
        aid: 111,
        bvid: "BV1aa411c7dd",
        cid: 222,
        title: "1",
        long_title: "云霄飞车杀人事件",
        duration: 1494000,
        cover: "https://i0.hdslb.com/bfs/ep1.jpg",
        pub_time: 1700000000,
      },
      {
        id: 323085,
        aid: 333,
        bvid: "BV1bb411c7ee",
        cid: 444,
        title: "2",
        long_title: "董事长千金绑架事件",
        duration: 1470000,
        pub_time: 1700100000,
      },
    ],
  },
};

describe("resolveBangumiRef", () => {
  it("按 ep 号取到对应剧集：标题、毫秒时长、extras", async () => {
    const restore = stubFetch({
      "https://api.bilibili.com/pgc/view/web/season?ep_id=323085": BANGUMI_SEASON,
    });
    try {
      const ref = await resolveBangumiRef({ kind: "bangumi", id: "323085", page: 1, seasonType: "ep" });
      assert.equal(ref.platform, "bilibili");
      assert.equal(ref.id, "BV1bb411c7ee");
      assert.equal(ref.title, "名侦探柯南（中配） · 董事长千金绑架事件");
      assert.equal(ref.durationSec, 1470);
      assert.equal(ref.author, "哔哩哔哩番剧");
      assert.equal(ref.publishedAt, new Date(1700100000 * 1000).toISOString());
      assert.equal(ref.pageUrl, "https://www.bilibili.com/bangumi/play/ep323085");
      assert.deepEqual(ref.extras, {
        kind: "bangumi",
        epId: 323085,
        seasonId: 33415,
        aid: 333,
        cid: 444,
        bvid: "BV1bb411c7ee",
        badge: null,
      });
      assert.equal(ref.stats?.views, 123456);
    } finally {
      restore();
    }
  });

  it("按 ss 号取第一集", async () => {
    const restore = stubFetch({
      "https://api.bilibili.com/pgc/view/web/season?season_id=33415": BANGUMI_SEASON,
    });
    try {
      const ref = await resolveBangumiRef({ kind: "bangumi", id: "33415", page: 1, seasonType: "ss" });
      assert.equal(ref.title, "名侦探柯南（中配） · 云霄飞车杀人事件");
      assert.equal(ref.durationSec, 1494);
      assert.equal(ref.extras?.epId, 323084);
    } finally {
      restore();
    }
  });

  it("付费/地区受限时报 VIP_OR_LOGIN", async () => {
    const restore = stubFetch({
      "https://api.bilibili.com/pgc/view/web/season": {
        code: -10403,
        message: "抱歉您所在地区不可观看！",
      },
    });
    try {
      await assert.rejects(
        () => resolveBangumiRef({ kind: "bangumi", id: "1", page: 1, seasonType: "ep" }),
        (err: unknown) => {
          assert.equal((err as { code?: string }).code, "VIP_OR_LOGIN");
          return true;
        },
      );
    } finally {
      restore();
    }
  });
});

describe("resolveCheeseRef", () => {
  const COURSE = {
    code: 0,
    message: "success",
    data: {
      title: "剪辑基础课",
      up_info: { uname: "某老师", mid: 42 },
      episodes: [
        {
          id: 9,
          aid: 100,
          cid: 200,
          index: 1,
          title: "认识时间线",
          duration: 759,
          release_date: 1690000000,
        },
      ],
    },
  };

  it("课程时长是秒，标题带季名与课时", async () => {
    const restore = stubFetch({
      "https://api.bilibili.com/pugv/view/web/season?ep_id=9": COURSE,
    });
    try {
      const ref = await resolveCheeseRef({ kind: "cheese", id: "9", page: 1, seasonType: "ep" });
      assert.equal(ref.id, "ep9");
      assert.equal(ref.title, "剪辑基础课 · 第1课 · 认识时间线");
      assert.equal(ref.durationSec, 759);
      assert.equal(ref.author, "某老师");
      assert.equal(ref.authorId, 42);
      assert.equal(ref.pageUrl, "https://www.bilibili.com/cheese/play/ep9");
      assert.deepEqual(ref.extras, { kind: "cheese", epId: 9, aid: 100, cid: 200, playable: true });
    } finally {
      restore();
    }
  });
});

describe("番剧/课程的付费限制", () => {
  const VIP_SEASON = {
    code: 0,
    message: "success",
    result: {
      season_id: 47836,
      season_title: "鬼灭之刃 柱训练篇",
      up_info: { uname: "哔哩哔哩番剧" },
      total: 8,
      episodes: [
        {
          id: 826498,
          aid: 1005750540,
          bvid: "BV1Xx4y1b7Nf",
          cid: 1602741611,
          title: "2",
          long_title: "水柱·富冈义勇的痛楚",
          duration: 1426000,
          badge: "会员",
          badge_info: { text: "会员" },
        },
      ],
    },
  };

  it("会员集的角标会写进 extras.badge", async () => {
    const restore = stubFetch({
      "https://api.bilibili.com/pgc/view/web/season": VIP_SEASON,
    });
    try {
      const ref = await resolveBangumiRef({ kind: "bangumi", id: "826498", page: 1, seasonType: "ep" });
      assert.equal(ref.extras?.badge, "会员");
    } finally {
      restore();
    }
  });

  it("会员集在下载前就报 VIP_OR_LOGIN，不会把 180 秒试看当成正片", () => {
    assert.throws(
      () =>
        assertPgcWatchable({
          platform: "bilibili",
          id: "BV1Xx4y1b7Nf",
          title: "t",
          durationSec: 1426,
          author: "a",
          pageUrl: "https://www.bilibili.com/bangumi/play/ep826498",
          extras: { kind: "bangumi", epId: 826498, badge: "会员" },
        }),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, "VIP_OR_LOGIN");
        assert.match((err as Error).message, /180 秒试看/);
        return true;
      },
    );
  });

  it("未购课程（playable=false）报 VIP_OR_LOGIN", () => {
    assert.throws(
      () =>
        assertPgcWatchable({
          platform: "bilibili",
          id: "ep459972",
          title: "t",
          durationSec: 1135,
          author: "a",
          pageUrl: "https://www.bilibili.com/cheese/play/ep459972",
          extras: { kind: "cheese", epId: 459972, playable: false },
        }),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, "VIP_OR_LOGIN");
        return true;
      },
    );
  });

  it("playurl 只给短试看时也报 VIP_OR_LOGIN", async () => {
    const restore = stubFetch({
      "https://api.bilibili.com/pgc/player/web/playurl": {
        code: 0,
        message: "success",
        result: { durl: [{ url: "https://a.example/preview.mp4", length: 180000 }] },
      },
    });
    try {
      await assert.rejects(
        () => fetchPgcPlayurl(pgcRef("bangumi")),
        (err: unknown) => {
          assert.equal((err as { code?: string }).code, "VIP_OR_LOGIN");
          assert.match((err as Error).message, /试看片段/);
          return true;
        },
      );
    } finally {
      restore();
    }
  });

  it("尚未开播的季（episodes 为空）提示总话数而不是“已下架”", async () => {
    const restore = stubFetch({
      "https://api.bilibili.com/pgc/view/web/season": {
        code: 0,
        message: "success",
        result: { season_id: 112827, season_title: "间谍过家家 第三季", total: 13, episodes: [] },
      },
    });
    try {
      await assert.rejects(
        () => resolveBangumiRef({ kind: "bangumi", id: "112827", page: 1, seasonType: "ss" }),
        (err: unknown) => {
          assert.equal((err as { code?: string }).code, "NOT_FOUND");
          assert.match((err as Error).message, /暂无正片可解析（共 13 话/);
          return true;
        },
      );
    } finally {
      restore();
    }
  });

  it("接口限流（-509）会被识别为限流而不是登录问题", () => {
    assert.equal(isRateLimit(-509, "请求过于频繁，请稍后再试"), true);
    assert.equal(isRateLimit(-799, "请求过于频繁"), true);
    assert.equal(isRateLimit(undefined, "请求过于频繁，请稍后再试"), true);
    assert.equal(isRateLimit(-352, "风控校验失败"), false);
  });
});

function pgcRef(kind: string): VideoRef {
  return {
    platform: "bilibili",
    id: "BV1aa411c7dd",
    title: "t",
    durationSec: 1470,
    author: "a",
    pageUrl: "https://www.bilibili.com/bangumi/play/ep323085",
    extras: { kind, epId: 323085 },
  };
}

describe("fetchPgcPlayurl", () => {
  it("番剧：地址在 result.dash 里", async () => {
    const restore = stubFetch({
      "https://api.bilibili.com/pgc/player/web/playurl": {
        code: 0,
        message: "success",
        result: {
          dash: {
            audio: [{ baseUrl: "https://a.example/audio.m4s" }],
            video: [{ baseUrl: "https://a.example/video.m4s" }],
          },
        },
      },
    });
    try {
      const playurl = await fetchPgcPlayurl(pgcRef("bangumi"));
      assert.equal(playurl.audioUrl, "https://a.example/audio.m4s");
      assert.equal(playurl.videoUrl, "https://a.example/video.m4s");
    } finally {
      restore();
    }
  });

  it("课程：地址在 data.dash 里，只有 durl 也能取到", async () => {
    const restore = stubFetch({
      "https://api.bilibili.com/pugv/player/web/playurl": {
        code: 0,
        message: "success",
        data: { durl: [{ url: "https://a.example/whole.mp4" }] },
      },
    });
    try {
      const playurl = await fetchPgcPlayurl(pgcRef("cheese"));
      assert.equal(playurl.audioUrl, undefined);
      assert.equal(playurl.videoUrl, "https://a.example/whole.mp4");
    } finally {
      restore();
    }
  });

  it("未购买课程（-403）报 VIP_OR_LOGIN", async () => {
    const restore = stubFetch({
      "https://api.bilibili.com/pugv/player/web/playurl": {
        code: -403,
        message: "抱歉，您尚未购买该课程",
      },
    });
    try {
      await assert.rejects(
        () => fetchPgcPlayurl(pgcRef("cheese")),
        (err: unknown) => {
          assert.equal((err as { code?: string }).code, "VIP_OR_LOGIN");
          return true;
        },
      );
    } finally {
      restore();
    }
  });
});
