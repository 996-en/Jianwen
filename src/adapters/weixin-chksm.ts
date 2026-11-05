import fs from "node:fs";
import path from "node:path";
import { weixinChksmFile } from "../config.js";

/** 持久化的微信文章签名；seedUrl 是可重新下发 chksm 的短链。 */
export interface StoredWeixinChksm {
  chksm: string;
  seedUrl?: string;
  updatedAt: string;
}

const CHKSM_RE = /^[0-9a-f]{20,}$/i;
let loaded = false;
let cached: StoredWeixinChksm | null = null;

function validChksm(value: unknown): value is string {
  return typeof value === "string" && CHKSM_RE.test(value);
}

function validSeedUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\/mp\.weixin\.qq\.com\/s\//i.test(value);
}

/** 读取上次成功解析得到的 chksm；文件损坏或不存在都按“没有”处理。 */
export function loadPersistedChksm(): StoredWeixinChksm | null {
  if (loaded) return cached;
  loaded = true;
  try {
    const raw = fs.readFileSync(weixinChksmFile(), "utf8");
    const data = JSON.parse(raw) as Partial<StoredWeixinChksm>;
    if (!validChksm(data.chksm)) return null;
    cached = {
      chksm: data.chksm,
      seedUrl: validSeedUrl(data.seedUrl) ? data.seedUrl : undefined,
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : new Date().toISOString(),
    };
    return cached;
  } catch {
    return null;
  }
}

/** 成功打开文章后落盘，供下一次 MCP 进程直接复用。 */
export function savePersistedChksm(chksm: string, seedUrl?: string): void {
  if (!validChksm(chksm)) return;
  const previous = loadPersistedChksm();
  const data: StoredWeixinChksm = {
    chksm,
    seedUrl: validSeedUrl(seedUrl) ? seedUrl : previous?.seedUrl,
    updatedAt: new Date().toISOString(),
  };
  try {
    const file = weixinChksmFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
    cached = data;
    loaded = true;
  } catch {
    // 缓存目录不可写时不阻塞抓取，退化为进程内记忆。
  }
}

/** 测试用：清掉内存与磁盘上的 chksm。 */
export function clearPersistedChksm(): void {
  cached = null;
  loaded = true;
  try {
    fs.rmSync(weixinChksmFile(), { force: true });
  } catch {
    // 忽略删除失败。
  }
}
