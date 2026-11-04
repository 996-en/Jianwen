import { Converter } from "opencc-js/t2cn";

/** whisper.cpp `-oj` 输出里我们关心的最小结构。 */
export interface WhisperJsonSegment {
  offsets?: { from?: number; to?: number };
  text?: string;
}

export interface WhisperJson {
  result?: { language?: string };
  transcription?: WhisperJsonSegment[];
}

export interface AsrSegment {
  fromMs: number;
  toMs: number;
  text: string;
}

export interface AsrFormatOptions {
  /** 两个 segment 之间停顿超过该毫秒数就另起一段，默认 800ms。 */
  pauseMs?: number;
  /** 单段最多累积多少字符，避免整篇变成一大段，默认 120。 */
  maxChars?: number;
}

const DEFAULT_PAUSE_MS = 800;
const DEFAULT_MAX_CHARS = 120;

// whisper 经常混出繁体，且 `-mc 0` 时 --prompt 不参与解码，只能在文本层兜底。
// 用台湾正体词表（tw→cn）才能把「跟著 / 攙扶著」这类 `著` 正确转成 `着`。
const toSimplified = Converter({ from: "tw", to: "cn" });

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const TERMINAL_PUNCTUATION = /[。！？!?…]$/;

/** 去掉零宽字符、把连续空白压成一个空格。 */
export function normalizeSegmentText(text: string): string {
  return text
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 繁体转简体；对已经是简体的文本是幂等的。 */
export function toSimplifiedChinese(text: string): string {
  return toSimplified(text);
}

/** 解析 whisper.cpp `-oj` 的 JSON；忽略缺时间戳或空文本的条目。 */
export function parseWhisperJson(raw: string): { language?: string; segments: AsrSegment[] } {
  const parsed = JSON.parse(raw) as WhisperJson;
  const segments: AsrSegment[] = [];
  for (const item of parsed.transcription ?? []) {
    const text = normalizeSegmentText(item.text ?? "");
    const from = item.offsets?.from;
    const to = item.offsets?.to;
    if (!text || !Number.isFinite(from) || !Number.isFinite(to) || to! < from!) continue;
    segments.push({ fromMs: from!, toMs: to!, text });
  }
  return { language: parsed.result?.language, segments };
}

/**
 * 把逐句的 whisper segment 整理成适合模型阅读的段落：
 * 1. 中文转简体；
 * 2. 丢弃连续重复的句子（BGM 或解码循环会反复输出同一句）；
 * 3. 按停顿或最大字数合并成段，避免一句话被拆成很多行。
 */
export function formatAsrSegments(
  segments: AsrSegment[],
  language?: string,
  options: AsrFormatOptions = {},
): string {
  const pauseMs = options.pauseMs ?? DEFAULT_PAUSE_MS;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const chinese = language?.toLowerCase().startsWith("zh") ?? false;

  const kept: AsrSegment[] = [];
  for (const segment of segments) {
    const text = normalizeSegmentText(chinese ? toSimplifiedChinese(segment.text) : segment.text);
    if (!text) continue;
    const key = repeatKey(text);
    if (!key) continue;
    const previous = kept.at(-1);
    if (previous && repeatKey(previous.text) === key) continue;
    kept.push({ ...segment, text });
  }

  const paragraphs: string[] = [];
  let current = "";
  let previousEnd = kept[0]?.fromMs ?? 0;
  for (const segment of kept) {
    if (current) {
      const gap = segment.fromMs - previousEnd;
      if (gap >= pauseMs || current.length >= maxChars) {
        paragraphs.push(current);
        current = "";
      }
    }
    current = joinText(current, segment.text);
    previousEnd = Math.max(previousEnd, segment.toMs);
  }
  if (current) paragraphs.push(current);

  return paragraphs
    .map((paragraph) => (chinese ? finishChineseParagraph(paragraph) : paragraph))
    .join("\n");
}

/** 用于比较重复句的键：忽略空白、标点和符号。 */
function repeatKey(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}

function joinText(left: string, right: string): string {
  if (!left) return right;
  if (/\s$/.test(left) || /^\s/.test(right)) return left + right;
  if (CJK.test(left.at(-1)!) || CJK.test(right[0])) return left + right;
  return `${left} ${right}`;
}

/**
 * `-mc 0` 时 whisper 不再输出标点。段落边界本身就是停顿，
 * 在这里补一个句号（并把残留的逗号/顿号改成句号），让转写结果可读。
 */
function finishChineseParagraph(paragraph: string): string {
  const trimmed = paragraph.replace(/[，,、；;：:]+$/, "");
  if (TERMINAL_PUNCTUATION.test(trimmed)) return trimmed;
  return `${trimmed}。`;
}
