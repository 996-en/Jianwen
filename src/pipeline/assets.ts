import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { getAsrProvider, keepDownloadedMedia, whisperBin, whisperLanguage, whisperModel, whisperVadModel } from "../config.js";
import type { CacheStore } from "../cache/store.js";
import type { PlatformAdapter } from "../adapters/types.js";
import { formatAsrSegments, parseWhisperJson } from "./asr-text.js";
import {
  VideoMcpError,
  type AssetManifest,
  type FetchAssetsOptions,
  type VideoRef,
} from "../types.js";

export function run(
  cmd: string,
  args: string[],
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      aborted = true;
      if (timer) clearTimeout(timer);
      child.kill("SIGKILL");
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        fail(new VideoMcpError(
          `Command not found: ${cmd}. Install it and ensure it is on PATH.`,
          cmd === "ffmpeg" ? "FFMPEG_MISSING" : "INTERNAL",
        ));
      } else fail(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      if (timedOut) return fail(new Error(`${cmd} timed out after ${Math.ceil(options.timeoutMs! / 1000)} seconds.`));
      if (aborted) return fail(new Error(`${cmd} cancelled by client.`));
      if (code !== 0) return fail(new Error(`${cmd} failed (${code}): ${stderr.slice(-1000) || stdout.slice(-1000)}`));
      settled = true;
      cleanup();
      resolve({ stdout, stderr });
    });
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs !== undefined && !aborted) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
    }
  });
}

/** 时长未知时给 30 分钟；已知时按 3 倍视频时长加 2 分钟预留，上限 24 小时。 */
export function estimateAsrTimeoutSec(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 1800;
  return Math.min(86400, Math.max(300, Math.ceil(durationSec * 3 + 120)));
}

async function ffmpegAvailable(): Promise<boolean> {
  try {
    await run("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

async function extractKeyframes(
  mediaPath: string,
  outDir: string,
  intervalSec: number,
): Promise<string[]> {
  const framesDir = path.join(outDir, "keyframes");
  await fs.mkdir(framesDir, { recursive: true });
  const pattern = path.join(framesDir, "frame_%04d.jpg");
  // fps = 1/interval
  const fps = intervalSec > 0 ? `1/${intervalSec}` : "1/10";
  await run("ffmpeg", [
    "-y",
    "-i",
    mediaPath,
    "-vf",
    `fps=${fps}`,
    "-q:v",
    "3",
    pattern,
  ]);
  const files = (await fs.readdir(framesDir))
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => path.join(framesDir, f));
  return files;
}

async function extractAudioWav(
  mediaPath: string,
  outPath: string,
  signal?: AbortSignal,
): Promise<void> {
  await run("ffmpeg", [
    "-y",
    "-i",
    mediaPath,
    "-vn",
    "-acodec",
    "pcm_s16le",
    "-ar",
    "16000",
    "-ac",
    "1",
    outPath,
  ], { signal });
}

/**
 * 组装 whisper-cli 参数，单独导出便于测试。
 * -mc 0：不携带上一窗口的文本，否则连续 BGM 下容易复读同一句并吞掉真实语音；
 *         代价是不再输出标点，由 asr-text 后处理补段落。
 * --vad：先做语音活动检测，纯音乐/静音段直接跳过，从源头掐掉复读与幻觉。
 */
export function whisperCliArgs(opts: {
  model: string;
  audioPath: string;
  outBase: string;
  language: string;
  vadModel?: string;
}): string[] {
  const args = [
    "-m", opts.model,
    "-f", opts.audioPath,
    "-l", opts.language,
    "-mc", "0",
    // 抑制 (音乐) 一类非语音标记。
    "-sns",
  ];
  if (opts.vadModel) args.push("--vad", "-vm", opts.vadModel);
  args.push("-oj", "-of", opts.outBase);
  return args;
}

async function runAsr(
  audioPath: string,
  destDir: string,
  timeoutSec: number,
  signal?: AbortSignal,
): Promise<{ text: string; path: string } | null> {
  const provider = getAsrProvider();
  if (provider === "none") return null;

  if (provider === "whisper_local") {
    const whisper = whisperBin();
    const model = whisperModel();
    if (!model) {
      throw new VideoMcpError(
        "Local ASR needs a whisper.cpp model: put ggml-*.bin in Release/models/ or set VIDEO_MCP_WHISPER_MODEL.",
        "ASR_UNAVAILABLE",
      );
    }
    const outBase = path.join(destDir, "asr");
    const vadModel = whisperVadModel();
    try {
      await fs.access(model);
      if (vadModel) await fs.access(vadModel);
      await run(
        whisper,
        whisperCliArgs({ model, audioPath, outBase, language: whisperLanguage(), vadModel }),
        { timeoutMs: timeoutSec * 1000, signal },
      );
      const jsonPath = `${outBase}.json`;
      const { language, segments } = parseWhisperJson(await fs.readFile(jsonPath, "utf8"));
      const text = formatAsrSegments(segments, language ?? whisperLanguage());
      const txtPath = `${outBase}.txt`;
      await fs.writeFile(txtPath, text ? `${text}\n` : "", "utf8");
      return { text, path: txtPath };
    } catch (err) {
      throw new VideoMcpError(
        `Local whisper ASR failed (${whisper}). Set VIDEO_MCP_WHISPER_BIN / VIDEO_MCP_WHISPER_VAD_MODEL, or drop whisper.cpp into Release/. ${
          err instanceof Error ? err.message : String(err)
        }`,
        "ASR_UNAVAILABLE",
      );
    }
  }

  if (provider === "openai_compatible") {
    const baseUrl = process.env.VIDEO_MCP_ASR_BASE_URL?.trim();
    const apiKey = process.env.VIDEO_MCP_ASR_API_KEY?.trim();
    const model =
      process.env.VIDEO_MCP_ASR_MODEL?.trim() || "whisper-1";
    if (!baseUrl || !apiKey) {
      throw new VideoMcpError(
        "ASR provider openai_compatible requires VIDEO_MCP_ASR_BASE_URL and VIDEO_MCP_ASR_API_KEY.",
        "ASR_UNAVAILABLE",
      );
    }
    const buf = await fs.readFile(audioPath);
    const form = new FormData();
    form.append("file", new Blob([buf]), path.basename(audioPath));
    form.append("model", model);
    const url = `${baseUrl.replace(/\/$/, "")}/audio/transcriptions`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal,
    });
    if (!res.ok) {
      throw new VideoMcpError(
        `Cloud ASR failed: HTTP ${res.status} ${await res.text()}`,
        "ASR_UNAVAILABLE",
      );
    }
    const json = (await res.json()) as { text?: string };
    const text = json.text ?? "";
    const asrPath = path.join(destDir, "asr.txt");
    await fs.writeFile(asrPath, text, "utf8");
    return { text, path: asrPath };
  }

  return null;
}

export async function fetchAssets(
  adapter: PlatformAdapter,
  ref: VideoRef,
  cache: CacheStore,
  options: FetchAssetsOptions = {},
  context: { signal?: AbortSignal; onProgress?: (stage: string) => void } = {},
): Promise<AssetManifest> {
  const wantSubtitles = options.wantSubtitles !== false;
  const provider = getAsrProvider();
  // ASR 默认开启：只要配置了 provider 且调用方没显式 wantAsr:false 就转写。
  // 平台带字幕时会在下面自动跳过，不会白跑一遍转写。
  const asrEnabled = options.wantAsr !== false && provider !== "none";
  // 关键帧默认不取：只要文字时不必下载整段视频（抖音尤其明显）。
  const wantKeyframes = options.wantKeyframes === true;
  const interval = options.keyframeIntervalSec ?? 10;

  const destDir = await cache.ensureDir(ref);
  const notes: string[] = [];

  context.onProgress?.("正在获取字幕、画面或音频");
  const media = await adapter.fetchMedia(ref, destDir, {
    wantSubtitles,
    wantAsr: asrEnabled,
    wantKeyframes,
    keyframeIntervalSec: interval,
  });

  notes.push(...(media.notes ?? []));

  // 图文内容（微信公众号文章、B 站动态/专栏、抖音长文/图文）不是音视频：拿到正文后直接写 manifest，
  // 不进入 ffmpeg / ASR / 抽帧分支，也不受 durationSec=0 的影响。
  if (
    media.articleText !== undefined ||
    media.articlePath !== undefined ||
    media.articleHtmlPath !== undefined
  ) {
    // 平台名保持简单：bilibili 的图文是动态/专栏，weixin 是公众号文章，douyin 是长文/图文
    const platformLabel =
      ref.platform === "weixin"
        ? "Weixin"
        : ref.platform === "bilibili"
          ? "Bilibili"
          : ref.platform === "douyin"
            ? "Douyin"
            : ref.platform;
    notes.push(`${platformLabel} text post parsed; ASR and video keyframes were skipped.`);
    const manifest: AssetManifest = {
      ref,
      createdAt: new Date().toISOString(),
      cacheDir: destDir,
      articleText: media.articleText,
      articlePath: media.articlePath,
      articleHtmlPath: media.articleHtmlPath,
      articleSourcePath: media.articleSourcePath,
      articleJsonPath: media.articleJsonPath,
      imagePaths: media.imagePaths,
      notes,
    };
    await cache.writeManifest(manifest);
    return manifest;
  }

  let subtitleText = wantSubtitles ? media.subtitleText : undefined;
  let subtitlePath = wantSubtitles ? media.subtitlePath : undefined;

  if (!wantSubtitles) {
    subtitleText = undefined;
    subtitlePath = undefined;
  }

  let audioPath = media.audioPath;
  let videoPath = media.videoPath;
  if (wantKeyframes && media.storyboardError) {
    notes.push(`Storyboard unavailable (${media.storyboardError}); falling back to video download + ffmpeg.`);
  }
  if (!subtitleText && !audioPath && !videoPath && !media.keyframePaths?.length) {
    notes.push("No subtitles or media available. Enable wantAsr or wantKeyframes to try downloading media.");
  }

  // Ensure audio for ASR if needed
  let asrText: string | undefined;
  let asrPath: string | undefined;

  if (asrEnabled && subtitleText) {
    notes.push("ASR skipped because platform subtitles were available.");
  } else if (!asrEnabled && options.wantAsr === true) {
    notes.push("ASR skipped: VIDEO_MCP_ASR_PROVIDER is none. Set whisper_local or openai_compatible.");
  } else if (!asrEnabled && !subtitleText) {
    notes.push(
      "No platform subtitles; set VIDEO_MCP_ASR_PROVIDER=whisper_local (or openai_compatible) to transcribe the audio.",
    );
  } else if (asrEnabled && !subtitleText) {
    const source = audioPath ?? videoPath;
    if (!source) {
      notes.push("ASR requested but no audio available.");
    } else {
      if (!(await ffmpegAvailable())) {
        throw new VideoMcpError("ffmpeg is required to convert audio for ASR.", "FFMPEG_MISSING");
      }
      const localAsr = provider === "whisper_local";
      const timeoutSec = options.asrTimeoutSec ?? estimateAsrTimeoutSec(ref.durationSec);
      if (localAsr && (!Number.isInteger(timeoutSec) || timeoutSec < 30 || timeoutSec > 86400)) {
        throw new VideoMcpError("asrTimeoutSec must be an integer from 30 to 86400 seconds.", "ASR_UNAVAILABLE");
      }
      const wav = path.join(destDir, "audio_16k.wav");
      let wavPath: string;
      if (media.audioReady && audioPath) {
        // 适配器已经流式抽好 16 kHz 单声道 WAV（例如抖音 fast-audio），不必再转一次。
        wavPath = audioPath;
        notes.push("ASR used the streamed audio track; no full video was downloaded.");
      } else {
        context.onProgress?.("正在将音频转换为 16 kHz WAV");
        await extractAudioWav(source, wav, context.signal);
        wavPath = wav;
        audioPath = wav;
      }
      context.onProgress?.(localAsr ? `正在使用 Whisper 转写（最长 ${timeoutSec} 秒）` : "正在请求云端 ASR 转写");
      const asr = await runAsr(wavPath, destDir, timeoutSec, context.signal);
      if (asr) {
        asrText = asr.text;
        asrPath = asr.path;
      }
    }
  }

  let keyframePaths: string[] | undefined = wantKeyframes ? media.keyframePaths : undefined;
  if (wantKeyframes && keyframePaths?.length) {
    notes.push(`Fetched ${keyframePaths.length} storyboard keyframes (max 6).`);
  } else if (wantKeyframes) {
    const source = videoPath ?? audioPath;
    if (!source) {
      notes.push("Keyframes skipped: no video/audio file in cache.");
    } else if (!(await ffmpegAvailable())) {
      throw new VideoMcpError(
        "ffmpeg not found on PATH. Install ffmpeg to extract keyframes.",
        "FFMPEG_MISSING",
      );
    } else if (!videoPath) {
      notes.push(
        "Keyframes skipped: only audio present (no video stream to sample).",
      );
    } else {
      try {
        keyframePaths = await extractKeyframes(videoPath, destDir, interval);
        notes.push(`Extracted ${keyframePaths.length} keyframes @ ${interval}s.`);
      } catch (err) {
        notes.push(
          `Keyframe extraction failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  // 整段视频只在抽帧/转写时当临时文件用；用完默认删掉，避免缓存里躺着几百 MB 的 mp4。
  // 只删本平台自己下载到缓存目录内的文件，平台自带的路径（例如故事板）一律不动。
  if (
    videoPath &&
    !keepDownloadedMedia() &&
    (keyframePaths?.length || asrText) &&
    path.resolve(videoPath).startsWith(`${path.resolve(destDir)}${path.sep}`)
  ) {
    try {
      await fs.rm(videoPath, { force: true });
      videoPath = undefined;
      notes.push(
        "Removed the downloaded video after extraction (set VIDEO_MCP_KEEP_MEDIA=1 to keep it).",
      );
    } catch (err) {
      notes.push(
        `Could not remove the downloaded video: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const manifest: AssetManifest = {
    ref,
    createdAt: new Date().toISOString(),
    cacheDir: destDir,
    subtitleText,
    subtitlePath,
    asrText,
    asrPath,
    audioPath,
    videoPath,
    keyframePaths,
    notes,
  };

  await cache.writeManifest(manifest);
  return manifest;
}
