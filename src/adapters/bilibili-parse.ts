/**
 * B 站链接分类器：纯函数、不联网。
 * 先把一条链接（或裸 id）认成某种类型，再交给对应的解析流程，
 * 这样视频、番剧、动态、专栏可以共用同一个 adapter，而不用写一堆 adapter 类。
 */

export type BiliKind =
  | "video"
  | "bangumi"
  | "cheese"
  | "opus"
  | "article"
  | "audio"
  | "short"
  /** 是 bilibili.com 的链接，但类型还没支持（直播、收藏夹、空间等） */
  | "unknown";

export interface BiliLink {
  kind: BiliKind;
  /**
   * video：BV 号或 `av<数字>`；
   * bangumi/cheese：ep/ss/md 后面的数字；
   * opus/article/audio：数字 id；
   * short：b23.tv 的短码；
   * unknown：空字符串。
   */
  id: string;
  /** 视频分 P，从 1 开始；非视频类型恒为 1 */
  page: number;
  /** bangumi / cheese 的 id 类型 */
  seasonType?: "ep" | "ss" | "md";
}

export const BV_RE = /BV[0-9A-Za-z]{10}/;
export const AV_RE = /(?:av|AV)(\d+)/;
export const B23_RE = /(?:https?:\/\/)?(?:www\.)?b23\.tv\/([A-Za-z0-9]+)(?![A-Za-z0-9/])/i;
export const BILIBILI_HOST_RE = /(?:https?:\/\/)?(?:www\.|m\.)?bilibili\.com\//i;

/** 从任意文本里抠出 BV 号 */
export function extractBvId(input: string): string | null {
  const match = BV_RE.exec(input);
  return match ? match[0] : null;
}

/** 从任意文本里抠出 av 号数字部分 */
export function extractAvId(input: string): string | null {
  const match = AV_RE.exec(input);
  return match ? match[1]! : null;
}

/** 从任意文本里抠出 b23.tv 短链的完整 URL */
export function extractShortLink(input: string): string | null {
  const match = /(?:https?:\/\/)?(?:www\.)?b23\.tv\/[A-Za-z0-9]+(?![A-Za-z0-9/])/i.exec(input);
  if (!match) return null;
  return match[0].startsWith("http") ? match[0] : `https://${match[0]}`;
}

/** 分 P 参数：`?p=2` / `&p=2`，缺省或非法都按第 1 P 处理 */
function parsePage(input: string): number {
  const match = /[?&]p=(\d+)/i.exec(input);
  if (!match) return 1;
  const page = Number.parseInt(match[1]!, 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

/**
 * 把输入认成 B 站链接类型；完全不像 B 站内容时返回 null。
 * 顺序有讲究：短链最先（它可能跳转到任何类型），
 * 然后是 /bangumi/、/cheese/、/opus/、/read/、/audio/ 这些专属路径，最后才是视频。
 */
export function parseBiliLink(input: string): BiliLink | null {
  const text = input.trim();
  if (!text) return null;

  if (B23_RE.test(text) || extractShortLink(text)) {
    const match = B23_RE.exec(text);
    return { kind: "short", id: match ? match[1]! : "", page: 1 };
  }

  const bangumi = /bilibili\.com\/bangumi\/play\/(ep|ss|md)(\d+)/i.exec(text);
  if (bangumi) {
    return {
      kind: "bangumi",
      id: bangumi[2]!,
      page: 1,
      seasonType: bangumi[1]!.toLowerCase() as "ep" | "ss" | "md",
    };
  }

  const cheese = /bilibili\.com\/cheese\/play\/(ep|ss)(\d+)/i.exec(text);
  if (cheese) {
    return {
      kind: "cheese",
      id: cheese[2]!,
      page: 1,
      seasonType: cheese[1]!.toLowerCase() as "ep" | "ss",
    };
  }

  // 动态：新版是 /opus/<id>，老版是 t.bilibili.com/<id> 或 m.bilibili.com/dynamic/<id>
  const opus =
    /bilibili\.com\/opus\/(\d+)/i.exec(text) ??
    /t\.bilibili\.com\/(?:h5\/dynamic\/)?(\d+)/i.exec(text) ??
    /t\.bilibili\.com[^"'\s]*?\bid=(\d+)/i.exec(text) ??
    /m\.bilibili\.com\/dynamic\/(\d+)/i.exec(text);
  if (opus) return { kind: "opus", id: opus[1]!, page: 1 };

  // 专栏：/read/cv123 与移动端 /read/mobile?id=123
  const article =
    /bilibili\.com\/read\/cv(\d+)/i.exec(text) ??
    /bilibili\.com\/read\/mobile[^"'\s]*?\bid=(\d+)/i.exec(text);
  if (article) return { kind: "article", id: article[1]!, page: 1 };

  const audio = /bilibili\.com\/audio\/au(\d+)/i.exec(text);
  if (audio) return { kind: "audio", id: audio[1]!, page: 1 };

  const bv = extractBvId(text);
  if (bv) return { kind: "video", id: bv, page: parsePage(text) };

  const av = extractAvId(text);
  if (av) return { kind: "video", id: `av${av}`, page: parsePage(text) };

  if (BILIBILI_HOST_RE.test(text)) return { kind: "unknown", id: "", page: 1 };

  return null;
}

/** 是否是我们能识别的 B 站输入 */
export function isBilibiliInput(input: string): boolean {
  return parseBiliLink(input) !== null;
}
