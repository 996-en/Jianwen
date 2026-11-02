import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AsrProvider = "none" | "whisper_local" | "openai_compatible";

/** 项目根目录：`src/config.ts` 与编译产物 `dist/config.js` 都在根目录下一层 */
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 默认抖音 Cookie 文件：项目根目录下的 `.douyin-cookies.txt`。
 * 由 `npm run douyin:cookies` 生成，已在 `.gitignore` 中排除。
 */
export const DEFAULT_DOUYIN_COOKIE_FILE = path.join(projectRoot, ".douyin-cookies.txt");

let nvidiaProbe: boolean | undefined;

/** 只探测一次：有 NVIDIA 显卡时才优先选 Release/ 里的 CUDA 版 whisper */
function hasNvidiaGpu(): boolean {
  if (nvidiaProbe !== undefined) return nvidiaProbe;
  try {
    const res = spawnSync(
      "nvidia-smi",
      ["--query-gpu=name", "--format=csv,noheader"],
      { timeout: 3000, encoding: "utf8" },
    );
    nvidiaProbe = res.status === 0 && Boolean(res.stdout?.trim());
  } catch {
    nvidiaProbe = false;
  }
  return nvidiaProbe;
}

function pickWhisperBin(releaseDir: string): string | undefined {
  if (!existsSync(releaseDir)) return undefined;
  const dirs = readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("whisper-"))
    .map((entry) => entry.name)
    .sort((a, b) => Number(b.includes("cuda")) - Number(a.includes("cuda")) || a.localeCompare(b));
  const cudaOk = hasNvidiaGpu();
  for (const dir of dirs) {
    if (dir.includes("cuda") && !cudaOk) continue;
    const exe = path.join(releaseDir, dir, "whisper-cli.exe");
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

function pickWhisperModel(releaseDir: string): string | undefined {
  const modelsDir = path.join(releaseDir, "models");
  if (!existsSync(modelsDir)) return undefined;
  const files = readdirSync(modelsDir)
    .filter((file) => file.startsWith("ggml-") && file.endsWith(".bin"))
    .sort();
  const preferred = files.find((file) => file.includes("turbo")) ?? files[0];
  return preferred ? path.join(modelsDir, preferred) : undefined;
}

/**
 * 自动探测 `Release/` 下的打包版 whisper.cpp 与模型。
 * 有 NVIDIA 显卡时优先 CUDA 版，否则用 CPU 版；都没有就返回空，交给环境变量或 PATH。
 */
export function detectReleaseWhisper(root: string = projectRoot): { bin?: string; model?: string } {
  const releaseDir = path.join(root, "Release");
  return { bin: pickWhisperBin(releaseDir), model: pickWhisperModel(releaseDir) };
}

/** whisper.cpp 可执行文件：环境变量 > Release/ 打包版 > PATH 上的 whisper-cli */
export function whisperBin(): string {
  return process.env.VIDEO_MCP_WHISPER_BIN?.trim() || detectReleaseWhisper().bin || "whisper-cli";
}

/** whisper.cpp 模型：环境变量 > Release/models/ 下的 ggml-*.bin（优先 turbo） */
export function whisperModel(): string | undefined {
  return process.env.VIDEO_MCP_WHISPER_MODEL?.trim() || detectReleaseWhisper().model;
}

export function whisperLanguage(): string {
  return process.env.VIDEO_MCP_WHISPER_LANGUAGE?.trim() || "auto";
}

export function getAsrProvider(): AsrProvider {
  const v = (process.env.VIDEO_MCP_ASR_PROVIDER ?? "").trim().toLowerCase();
  if (v === "whisper_local" || v === "openai_compatible" || v === "none") {
    return v;
  }
  // 未显式配置时：本机已经能用本地 whisper（例如带了 Release/ 打包版）就默认开启转写，
  // 否则保持关闭，避免在没装模型的机器上白白报错。
  return whisperModel() ? "whisper_local" : "none";
}

/** 抽完帧后是否保留下载的整段视频；默认删除以节省空间，设 VIDEO_MCP_KEEP_MEDIA=1 可保留 */
export function keepDownloadedMedia(): boolean {
  const v = (process.env.VIDEO_MCP_KEEP_MEDIA ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export interface SummaryConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function getSummaryConfig(): SummaryConfig | null {
  const baseUrl = process.env.VIDEO_MCP_SUMMARY_BASE_URL?.trim();
  const apiKey = process.env.VIDEO_MCP_SUMMARY_API_KEY?.trim();
  const model = process.env.VIDEO_MCP_SUMMARY_MODEL?.trim();
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl, apiKey, model };
}

export function bilibiliUserAgent(): string {
  return (
    process.env.VIDEO_MCP_BILIBILI_UA?.trim() ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );
}

/** 抖音请求 UA；抖音详情接口对 UA 与 Cookie 的来源浏览器一致性较敏感，需要时可用环境变量覆盖 */
export function douyinUserAgent(): string {
  return (
    process.env.VIDEO_MCP_DOUYIN_UA?.trim() ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"
  );
}

/**
 * 抖音只要音频时是否让 ffmpeg 直读远程地址抽音轨（省掉整片 mp4 的下载与落盘）。
 * 默认开启：实测抖音 CDN 支持 Range 且 moov 在文件头，失败会自动回落到整片下载，
 * 因此默认开着不会改变结果，只是省流量。设 VIDEO_MCP_DOUYIN_FAST_AUDIO=0 可关掉。
 */
export function douyinFastAudio(): boolean {
  const v = (process.env.VIDEO_MCP_DOUYIN_FAST_AUDIO ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

/** 直接提供 `name=value; name2=value2` 形式的 Cookie 头 */
export function douyinCookiesRaw(): string | undefined {
  const v = process.env.VIDEO_MCP_DOUYIN_COOKIES?.trim();
  return v ? v : undefined;
}

/**
 * 浏览器导出的 Netscape 格式 cookies.txt 路径。
 * 优先取环境变量；未配置时回退到项目根目录的 `.douyin-cookies.txt`（存在才用）。
 */
export function douyinCookieFile(): string | undefined {
  const v = process.env.VIDEO_MCP_DOUYIN_COOKIE_FILE?.trim();
  if (v) return v;
  return existsSync(DEFAULT_DOUYIN_COOKIE_FILE) ? DEFAULT_DOUYIN_COOKIE_FILE : undefined;
}
