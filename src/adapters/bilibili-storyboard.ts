import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { bilibiliUserAgent } from "../config.js";
import type { VideoRef } from "../types.js";

const MAX_FRAMES = 6;

interface VideoshotResponse {
  code: number;
  message?: string;
  data?: {
    image?: string[];
    index?: number[];
    img_x_len?: number;
    img_y_len?: number;
    img_x_size?: number;
    img_y_size?: number;
  };
}

function imageUrl(raw: string): string {
  const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".hdslb.com")) {
    throw new Error("Invalid Bilibili storyboard image URL");
  }
  return url.href;
}

/** 从 B 站视频快照的雪碧图裁出至多 6 帧，无需下载完整视频。失败时由调用方回退。 */
export async function fetchStoryboardFrames(
  ref: VideoRef,
  destDir: string,
  intervalSec: number,
): Promise<string[]> {
  const cid = Number(ref.extras?.cid ?? 0);
  if (!Number.isSafeInteger(cid) || cid <= 0) throw new Error("Missing video cid");

  // 多 P 视频的 ref.id 形如 BV1xx_p2，真正的 bvid 记在 extras.bvid 里
  const bvid = String(ref.extras?.bvid ?? ref.id);
  const api = `https://api.bilibili.com/x/player/videoshot?bvid=${encodeURIComponent(bvid)}&cid=${cid}&index=1`;
  const headers = {
    "User-Agent": bilibiliUserAgent(),
    Referer: "https://www.bilibili.com/",
  };
  const response = await fetch(api, { headers });
  if (!response.ok) throw new Error(`Storyboard API HTTP ${response.status}`);
  const json = (await response.json()) as VideoshotResponse;
  const data = json.data;
  if (json.code !== 0 || !data) {
    throw new Error(`Storyboard API failed: ${json.message ?? json.code}`);
  }

  const { image, index, img_x_len: columns, img_y_len: rows, img_x_size: width, img_y_size: height } = data;
  if (!image?.length || !index?.length || !columns || !rows || !width || !height ||
      ![columns, rows, width, height].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new Error("Storyboard images or timestamps unavailable");
  }
  const capacity = columns * rows;
  const count = Math.min(index.length, image.length * capacity);
  const duration = ref.durationSec > 0 ? ref.durationSec : index[count - 1]!;
  // 部分视频返回毫秒索引，统一转为秒。
  const scale = duration > 0 && index[count - 1]! > duration * 2 ? 1000 : 1;
  const seconds = index.slice(0, count).map((t) => t / scale);
  if (!seconds.every((t) => Number.isFinite(t) && t >= 0)) {
    throw new Error("Invalid storyboard timestamps");
  }
  const step = intervalSec > 0 ? intervalSec : 10;
  const frameCount = Math.min(MAX_FRAMES, count, Math.max(1, Math.ceil(duration / step)));
  const selected = new Set<number>();
  for (let i = 0; i < frameCount; i++) {
    // 避开片尾黑屏/片尾字幕，覆盖前 90% 的视频。
    const target = frameCount === 1 ? 0 : (i * duration * 0.9) / (frameCount - 1);
    let nearest = 0;
    for (let j = 1; j < count; j++) {
      if (Math.abs(seconds[j]! - target) < Math.abs(seconds[nearest]! - target)) nearest = j;
    }
    selected.add(nearest);
  }

  const framesDir = path.join(destDir, "keyframes");
  const sheets = new Map<number, Buffer>();
  const paths: string[] = [];
  try {
    await fs.rm(framesDir, { recursive: true, force: true });
    await fs.mkdir(framesDir, { recursive: true });
    for (const position of selected) {
      const sheetIndex = Math.floor(position / capacity);
      let sheet = sheets.get(sheetIndex);
      if (!sheet) {
        const res = await fetch(imageUrl(image[sheetIndex]!), { headers });
        if (!res.ok) throw new Error(`Storyboard image HTTP ${res.status}`);
        sheet = Buffer.from(await res.arrayBuffer());
        sheets.set(sheetIndex, sheet);
      }
      const tile = position % capacity;
      const framePath = path.join(framesDir, `frame_${String(paths.length + 1).padStart(4, "0")}.jpg`);
      await sharp(sheet)
        .extract({ left: (tile % columns) * width, top: Math.floor(tile / columns) * height, width, height })
        .jpeg({ quality: 85 })
        .toFile(framePath);
      paths.push(framePath);
    }
    if (!paths.length) throw new Error("Storyboard has no usable frames");
    return paths;
  } catch (err) {
    await Promise.all(paths.map((file) => fs.rm(file, { force: true })));
    throw err;
  }
}
