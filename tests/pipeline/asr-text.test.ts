import assert from "node:assert/strict";
import { it } from "node:test";
import {
  formatAsrSegments,
  parseWhisperJson,
  toSimplifiedChinese,
  type AsrSegment,
} from "../../src/pipeline/asr-text.js";

it("繁体转简体时按词处理「著」等易错字", () => {
  assert.equal(toSimplifiedChinese("原來愛情如茶"), "原来爱情如茶");
  assert.equal(toSimplifiedChinese("他跟著她，攙扶著妻子"), "他跟着她，搀扶着妻子");
  // 已经是简体的文本保持不变
  assert.equal(toSimplifiedChinese("原来爱情如茶"), "原来爱情如茶");
});

it("解析 whisper JSON，忽略空文本和非法时间戳", () => {
  const parsed = parseWhisperJson(
    JSON.stringify({
      result: { language: "zh" },
      transcription: [
        { offsets: { from: 0, to: 1200 }, text: " 第一句 " },
        { offsets: { from: 1200, to: 2400 }, text: "" },
        { offsets: { from: 3000 }, text: "没有结束时间" },
        { offsets: { from: 2400, to: 3600 }, text: "第二句" },
      ],
    }),
  );
  assert.equal(parsed.language, "zh");
  assert.deepEqual(parsed.segments, [
    { fromMs: 0, toMs: 1200, text: "第一句" },
    { fromMs: 2400, toMs: 3600, text: "第二句" },
  ]);
});

it("合并连续句子、压缩重复句并补段落标点", () => {
  const segments: AsrSegment[] = [
    { fromMs: 0, toMs: 1260, text: "原來愛情如茶" },
    { fromMs: 1260, toMs: 2340, text: "歷經廢水" },
    { fromMs: 2340, toMs: 3640, text: "尹熙勋非但沒有跟著對方的節奏走" },
    { fromMs: 3640, toMs: 5000, text: "我愛的人" },
    { fromMs: 5000, toMs: 6000, text: "我愛的人" },
    { fromMs: 6000, toMs: 7000, text: "我愛的人" },
  ];
  assert.equal(
    formatAsrSegments(segments, "zh"),
    "原来爱情如茶历经废水尹熙勋非但没有跟着对方的节奏走我爱的人。",
  );
});

it("停顿超过阈值时另起一段，超过字数上限也会分段", () => {
  const paused = formatAsrSegments(
    [
      { fromMs: 0, toMs: 1000, text: "第一句" },
      { fromMs: 3000, toMs: 4000, text: "第二句" },
    ],
    "zh",
  );
  assert.equal(paused, "第一句。\n第二句。");

  const limited = formatAsrSegments(
    [
      { fromMs: 0, toMs: 1000, text: "一二三" },
      { fromMs: 1000, toMs: 2000, text: "四五六" },
      { fromMs: 2000, toMs: 3000, text: "七八九" },
    ],
    "zh",
    { maxChars: 5 },
  );
  assert.equal(limited, "一二三四五六。\n七八九。");
});

it("非中文转写按空格合并，且不补中文句号", () => {
  const text = formatAsrSegments(
    [
      { fromMs: 0, toMs: 1000, text: "hello" },
      { fromMs: 1000, toMs: 2000, text: "world" },
      { fromMs: 2000, toMs: 3000, text: "again" },
    ],
    "en",
  );
  assert.equal(text, "hello world again");
});
