/**
 * 抖音链接识别（纯字符串解析，不发网络请求）。
 *
 * 抖音同一个作品在网页端有多个入口：/video/<id>、/note/<id>（图文）、/article/<id>（长文），
 * 分享短链 v.douyin.com/<code> 打开后还会跳一次；主页弹出的作品详情则只有 ?modal_id=<id>。
 * 这里只负责把「用户给的东西」归类，具体是视频、图文还是长文由详情接口的数据决定（见 douyin.ts 的 resolve）。
 */

export type DouyinLinkKind =
  | "video"
  | "note"
  | "article"
  | "short"
  | "user"
  | "collection"
  | "live"
  | "unknown";

export interface DouyinLink {
  kind: DouyinLinkKind;
  /** video/note/article 是作品 ID；collection 是合集 ID；short 是短链码；其余为空串 */
  id: string;
}

const SHORT_LINK_RE = /(?:https?:\/\/)?v\.douyin\.com\/([A-Za-z0-9_-]+)/i;
const LIVE_RE = /(?:https?:\/\/)?live\.douyin\.com\/(\d{1,25})/i;
/** 作品路径：/video /note /article 是单个作品；/slides 是图文的分享页，/user /collection /mix 是列表页 */
const PAGE_RE =
  /(?:https?:\/\/)?(?:[\w-]+\.)?(?:ies)?douyin\.com\/(?:share\/)?(video|note|article|slides|user|collection|mix)\/([A-Za-z0-9_-]{5,})/i;
const MODAL_ID_RE = /[?&]modal_id=(\d{15,25})/i;
const HOST_RE = /(?:https?:\/\/)?(?:[\w-]+\.)?(?:ies)?douyin\.com(?:[/?#]|$)/i;
/** 裸作品 ID 只接受 19 位数字，避免与 B 站纯数字 aid 混淆 */
const BARE_ID_RE = /^\d{19}$/;

/** 只从「单个作品」的输入里取 ID；短链要跟随 302，列表页没有单个 ID */
export function extractAwemeId(input: string): string | null {
  const link = parseDouyinLink(input);
  if (!link) return null;
  if (link.kind === "video" || link.kind === "note" || link.kind === "article") return link.id;
  return null;
}

export function isDouyinInput(input: string): boolean {
  return parseDouyinLink(input) !== null;
}

export function parseDouyinLink(input: string): DouyinLink | null {
  const s = input.trim();
  if (!s) return null;

  if (BARE_ID_RE.test(s)) return { kind: "video", id: s };

  const live = s.match(LIVE_RE);
  if (live?.[1]) return { kind: "live", id: live[1] };

  // 短链要放在路径匹配之前：v.douyin.com 的短码正好也是一个路径段
  const short = s.match(SHORT_LINK_RE);
  if (short?.[1]) return { kind: "short", id: short[1] };

  const page = s.match(PAGE_RE);
  if (page?.[1] && page[2]) {
    const segment = page[1].toLowerCase();
    const id = page[2];
    if (segment === "video") return { kind: "video", id };
    if (segment === "note" || segment === "slides") return { kind: "note", id };
    if (segment === "article") return { kind: "article", id };
    if (segment === "user") return { kind: "user", id };
    return { kind: "collection", id };
  }

  // 主页里点开作品时地址栏只有 ?modal_id=<aweme_id>，没有作品路径
  const modal = s.match(MODAL_ID_RE);
  if (modal?.[1]) return { kind: "video", id: modal[1] };

  // 认得出是抖音域名，但不是单个作品：交给上层给出「不支持」的明确提示
  if (HOST_RE.test(s)) return { kind: "unknown", id: "" };
  return null;
}
