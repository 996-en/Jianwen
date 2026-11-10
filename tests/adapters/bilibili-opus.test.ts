import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArticleDetail, parseDynamicDetail, parseOpusDetail, resolveDynamicRef } from "../../src/adapters/bilibili-opus.js";

/** opus/detail 的真实形状：modules 是数组，元素带 module_type */
function opusPayload(item: Record<string, unknown>) {
  return { code: 0, message: "0", data: { item } };
}

describe("parseOpusDetail（opus/detail 数组形状）", () => {
  it("解析标题、作者、正文段落、图片与互动数", () => {
    const parsed = parseOpusDetail(
      opusPayload({
        id_str: "1049275096172068880",
        type: "DYNAMIC_TYPE_DRAW",
        modules: [
          {
            module_type: "MODULE_TYPE_TITLE",
            module_title: { text: "一条图文动态 - 哔哩哔哩" },
          },
          {
            module_type: "MODULE_TYPE_AUTHOR",
            module_author: {
              name: "测试UP",
              mid: 946974,
              pub_ts: "1793209896",
            },
          },
          {
            module_type: "MODULE_TYPE_CONTENT",
            module_content: {
              paragraphs: [
                {
                  para_type: 1,
                  text: { nodes: [{ word: { words: "第一段" } }, { word: { words: "文字" } }] },
                },
                {
                  para_type: 1,
                  text: { nodes: [{ word: { words: "第二段" } }] },
                },
                {
                  para_type: 2,
                  pic: {
                    pics: [
                      { url: "http://i0.hdslb.com/bfs/new_dyn/a.jpg" },
                      { url: "https://i0.hdslb.com/bfs/new_dyn/b.jpg" },
                    ],
                  },
                },
              ],
            },
          },
          {
            module_type: "MODULE_TYPE_STAT",
            module_stat: {
              comment: { count: 12 },
              forward: { count: 3 },
              like: { count: 456 },
            },
          },
        ],
      }),
    );

    assert.ok(parsed);
    assert.equal(parsed.title, "一条图文动态");
    assert.equal(parsed.text, "第一段文字\n第二段");
    assert.deepEqual(parsed.imageUrls, [
      "https://i0.hdslb.com/bfs/new_dyn/a.jpg",
      "https://i0.hdslb.com/bfs/new_dyn/b.jpg",
    ]);
    assert.equal(parsed.authorName, "测试UP");
    assert.equal(parsed.authorId, 946974);
    assert.equal(parsed.publishedAt, new Date(1793209896 * 1000).toISOString());
    assert.deepEqual(parsed.stats, {
      comments: 12,
      likes: 456,
      shares: 3,
      coins: undefined,
      favorites: undefined,
    });
    assert.deepEqual(parsed.notes, []);
  });

  it("只有图片的动态给出说明性正文", () => {
    const parsed = parseOpusDetail(
      opusPayload({
        id_str: "1",
        modules: [
          {
            module_type: "MODULE_TYPE_CONTENT",
            module_content: {
              paragraphs: [{ para_type: 2, pic: { pics: [{ url: "https://i0.hdslb.com/x.jpg" }] } }],
            },
          },
        ],
      }),
    );
    assert.ok(parsed);
    assert.equal(parsed.text, "（该动态只有图片，共 1 张）");
  });
});

describe("parseOpusDetail（动态详情对象形状）", () => {
  it("互动抽奖/表情这种 rich 节点也能取到文字，标题不再只是「XX的动态」", () => {
    const parsed = parseOpusDetail(
      opusPayload({
        basic: { title: "小白测评的动态 - 哔哩哔哩" },
        modules: [
          {
            module_type: "MODULE_TYPE_AUTHOR",
            module_author: { name: "小白测评", mid: 8969156, pub_ts: 1760579934 },
          },
          {
            module_type: "MODULE_TYPE_CONTENT",
            module_content: {
              paragraphs: [
                {
                  para_type: 1,
                  text: {
                    nodes: [
                      {
                        type: "TEXT_NODE_TYPE_RICH",
                        word: null,
                        rich: { text: "互动抽奖", type: "RICH_TEXT_NODE_TYPE_LOTTERY" },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    assert.equal(parsed?.text, "互动抽奖");
    assert.equal(parsed?.title, "互动抽奖");
  });

  it("正文取 rich_text_nodes，图片取 major.draw.items", () => {
    const parsed = parseOpusDetail(
      opusPayload({
        id_str: "2",
        modules: {
          module_author: { name: "用户B", mid: 1 },
          module_dynamic: {
            desc: { rich_text_nodes: [{ text: "转发内容" }, { text: "第一行" }] },
            major: {
              draw: {
                items: [{ src: "https://i0.hdslb.com/bfs/x.jpg" }],
              },
            },
          },
        },
      }),
    );
    assert.ok(parsed);
    assert.equal(parsed.text, "转发内容第一行");
    assert.deepEqual(parsed.imageUrls, ["https://i0.hdslb.com/bfs/x.jpg"]);
    assert.equal(parsed.authorName, "用户B");
  });

  it("纯视频卡片动态：给出视频地址提示，不自动递归解析", () => {
    const parsed = parseOpusDetail(
      opusPayload({
        id_str: "3",
        modules: {
          module_author: { name: "用户C" },
          module_dynamic: {
            major: { archive: { bvid: "BV1GJ411x7h7" } },
          },
        },
      }),
    );
    assert.ok(parsed);
    assert.equal(parsed.videoBvid, "BV1GJ411x7h7");
    assert.match(parsed.text, /该动态只有视频卡片/);
    assert.match(parsed.text, /https:\/\/www\.bilibili\.com\/video\/BV1GJ411x7h7/);
    assert.equal(parsed.notes.length, 1);
    assert.match(parsed.notes[0]!, /BV1GJ411x7h7/);
  });

  it("转发动态记录原文 id 并给出提示", () => {
    const parsed = parseOpusDetail(
      opusPayload({
        id_str: "4",
        modules: {
          module_dynamic: { desc: { rich_text_nodes: [{ text: "转发" }] } },
          module_reprint_source: { id_str: "999" },
        },
      }),
    );
    assert.ok(parsed);
    assert.equal(parsed.reprintOpusId, "999");
    assert.match(parsed.notes[0]!, /https:\/\/www\.bilibili\.com\/opus\/999/);
  });

  it("缺少 data.item 时返回 null", () => {
    assert.equal(parseOpusDetail({ code: 0, data: {} }), null);
    assert.equal(parseOpusDetail({}), null);
  });
});

describe("parseDynamicDetail（web-dynamic/v1/detail 兑底）", () => {
  /** 投稿视频动态：opus/detail 给 item:null，只能从动态详情拿卡片的真实形状 */
  const AV_ITEM = {
    id_str: "1269095847425998856",
    type: "DYNAMIC_TYPE_AV",
    modules: {
      module_author: {
        name: "芝士华莱士",
        mid: 22697887,
        pub_ts: 1794322803,
        pub_action: "投稿了视频",
      },
      module_dynamic: {
        desc: null,
        major: {
          type: "MAJOR_TYPE_ARCHIVE",
          archive: {
            bvid: "BV18KW363EwV",
            aid: "117592698132502",
            title: "英伟达官方商城重新上架RTX5090和RTX5080｜显卡日报11月11日",
            duration_text: "02:10",
          },
        },
      },
      module_stat: {
        comment: { count: 754 },
        forward: { count: 5 },
        like: { count: 3047 },
      },
    },
  };

  it("投稿视频动态认出背后的 bvid", () => {
    const parsed = parseDynamicDetail({ code: 0, data: { item: AV_ITEM } });
    assert.equal(parsed?.kind, "video");
    assert.equal(parsed?.bvid, "BV18KW363EwV");
    assert.equal(parsed?.authorName, "芝士华莱士");
    assert.match(parsed?.title ?? "", /显卡日报11月11日/);
    assert.equal(parsed?.stats?.likes, 3047);
  });

  it("转发动态把原动态文字接在后面", () => {
    const parsed = parseDynamicDetail({
      code: 0,
      data: {
        item: {
          id_str: "1269091088558194713",
          type: "DYNAMIC_TYPE_FORWARD",
          modules: {
            module_author: { name: "芝士华莱士", mid: 1, pub_ts: 1794300000 },
            module_dynamic: {
              desc: { text: "开奖倒计时，下期想要什么！[思考]", rich_text_nodes: [] },
              major: null,
            },
          },
          orig: {
            modules: {
              module_author: { name: "原UP" },
              module_dynamic: {
                desc: { text: "原动态正文" },
                major: {
                  type: "MAJOR_TYPE_DRAW",
                  draw: { items: [{ src: "http://i0.hdslb.com/bfs/new_dyn/a.png" }] },
                },
              },
            },
          },
        },
      },
    });
    assert.equal(parsed?.kind, "image");
    assert.match(parsed?.text ?? "", /开奖倒计时/);
    assert.match(parsed?.text ?? "", /转发自 @原UP/);
    assert.match(parsed?.text ?? "", /原动态正文/);
    assert.deepEqual(parsed?.imageUrls, ["https://i0.hdslb.com/bfs/new_dyn/a.png"]);
  });

  it("专栏卡片转成 cv 号", () => {
    const parsed = parseDynamicDetail({
      code: 0,
      data: {
        item: {
          id_str: "1",
          modules: {
            module_author: { name: "a" },
            module_dynamic: {
              major: { type: "MAJOR_TYPE_ARTICLE", article: { id: "29130272", title: "专栏标题" } },
            },
          },
        },
      },
    });
    assert.equal(parsed?.kind, "article");
    assert.equal(parsed?.cvId, "29130272");
  });

  it("直播推荐卡明确标为不支持，并且不报“不存在”", () => {
    const parsed = parseDynamicDetail({
      code: 0,
      data: {
        item: {
          id_str: "2",
          modules: {
            module_author: { name: "a" },
            module_dynamic: { desc: { text: "来我直播间" }, major: { type: "MAJOR_TYPE_LIVE_RCMD" } },
          },
        },
      },
    });
    assert.equal(parsed?.kind, "unsupported");
    assert.match(parsed?.notes.join(" ") ?? "", /直播推荐/);
  });
});

describe("resolveDynamicRef（opus 拿不到就改问动态详情）", () => {
  it("转发动态会把原动态正文也补进正文", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/polymer/web-dynamic/v1/opus/detail")) {
        if (url.includes("id=1259617417219276802")) {
          // 原动态：opus 接口能拿到正文
          return Response.json({
            code: 0,
            data: {
              item: {
                basic: { title: "原动态 - 哔哩哔哩" },
                modules: [
                  {
                    module_type: "MODULE_TYPE_CONTENT",
                    module_content: {
                      paragraphs: [
                        {
                          para_type: 1,
                          text: { nodes: [{ word: { words: "原动态的正文内容" } }] },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          });
        }
        // 转发本身：opus 接口 item 为 null
        return Response.json({ code: 0, data: { item: null } });
      }
      if (url.includes("/polymer/web-dynamic/v1/detail")) {
        return Response.json({
          code: 0,
          data: {
            item: {
              id_str: "1269091088558194713",
              modules: {
                module_author: { name: "小白测评", mid: 8969156, pub_ts: 1794300000 },
                module_dynamic: { desc: { text: "开奖倒计时" } },
              },
              orig: {
                id_str: "1259617417219276802",
                modules: {
                  module_author: { name: "小白测评" },
                  module_dynamic: {
                    desc: null,
                    major: { draw: { items: [{ src: "https://i0.hdslb.com/a.jpg" }] } },
                  },
                },
              },
            },
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    try {
      const { fetchDynamicDetail } = await import("../../src/adapters/bilibili-opus.js");
      const dyn = await fetchDynamicDetail("1269091088558194713");
      assert.match(dyn?.text ?? "", /开奖倒计时/);
      assert.match(dyn?.text ?? "", /原动态的正文内容/);
      assert.equal(dyn?.imageUrls.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("投稿视频动态自动换成视频 ref，并记下 fromDynamic", async () => {
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("/polymer/web-dynamic/v1/opus/detail")) {
        return Response.json({
          code: 0,
          message: "0",
          data: { item: null, fallback: { type: 1, id: "1269095847425998856" } },
        });
      }
      if (url.includes("/polymer/web-dynamic/v1/detail")) {
        return Response.json({
          code: 0,
          message: "0",
          data: {
            item: {
              id_str: "1269095847425998856",
              modules: {
                module_author: { name: "芝士华莱士", mid: 22697887, pub_ts: 1794322803 },
                module_dynamic: {
                  major: {
                    type: "MAJOR_TYPE_ARCHIVE",
                    archive: { bvid: "BV18KW363EwV", title: "显卡日报11月11日" },
                  },
                },
              },
            },
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    try {
      const ref = await resolveDynamicRef("1269095847425998856", async (bvid) => ({
        platform: "bilibili",
        id: bvid,
        title: "显卡日报11月11日",
        durationSec: 130,
        author: "芝士华莱士",
        pageUrl: `https://www.bilibili.com/video/${bvid}`,
        extras: { aid: 1, cid: 2 },
      }));
      assert.equal(ref.id, "BV18KW363EwV");
      assert.equal(ref.extras?.fromDynamic, "1269095847425998856");
      assert.equal(ref.extras?.cid, 2);
      // 只应请求两次动态接口（外加一次取 buvid 指纹）
      assert.deepEqual(
        requested.filter((url) => url.includes("/polymer/web-dynamic/v1/")),
        [
          "https://api.bilibili.com/x/polymer/web-dynamic/v1/opus/detail?id=1269095847425998856",
          "https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=1269095847425998856",
        ],
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("parseArticleDetail（专栏）", () => {
  it("HTML 转文本，并按出现顺序抽图、去重", () => {
    const parsed = parseArticleDetail({
      code: 0,
      data: {
        title: "专栏标题",
        publish_time: 1700000000,
        author: { mid: 7, name: "作者" },
        stats: { view: 100, favorite: 5, like: 9, coin: 1, reply: 2, share: 3 },
        content:
          "<h1>小标题</h1><p>第一段\n文字</p>" +
          '<p><img src="//i0.hdslb.com/bfs/a.jpg"></p>' +
          '<p><img src="https://i0.hdslb.com/bfs/a.jpg"></p>',
        image_urls: ["https://i0.hdslb.com/bfs/a.jpg"],
      },
    });

    assert.ok(parsed);
    assert.equal(parsed.title, "专栏标题");
    assert.match(parsed.text, /小标题/);
    assert.match(parsed.text, /第一段\s*文字/);
    assert.doesNotMatch(parsed.text, /<p>/);
    assert.deepEqual(parsed.imageUrls, ["https://i0.hdslb.com/bfs/a.jpg"]);
    assert.equal(parsed.authorName, "作者");
    assert.equal(parsed.authorId, 7);
    assert.deepEqual(parsed.stats, {
      views: 100,
      favorites: 5,
      likes: 9,
      coins: 1,
      comments: 2,
      shares: 3,
    });
  });

  it("正文没有图片时退回 image_urls", () => {
    const parsed = parseArticleDetail({
      code: 0,
      data: {
        title: "t",
        content: "<p>纯文字</p>",
        image_urls: ["http://i0.hdslb.com/bfs/cover.jpg"],
      },
    });
    assert.ok(parsed);
    assert.deepEqual(parsed.imageUrls, ["https://i0.hdslb.com/bfs/cover.jpg"]);
  });
});
