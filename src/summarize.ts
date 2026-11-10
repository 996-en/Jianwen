import fs from "node:fs/promises";
import { getSummaryConfig } from "./config.js";
import { VideoMcpError, type AssetManifest } from "./types.js";

export interface SummaryResult {
  title: string;
  chapters: Array<{ heading: string; points: string[] }>;
  keyPoints: string[];
  conclusion: string;
  rawModelText?: string;
}

function imageMimeType(file: string): string {
  const ext = file.toLowerCase().split(".").pop();
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "bmp") return "image/bmp";
  return "image/jpeg";
}

export async function summarizeManifest(
  manifest: AssetManifest,
  focus?: string,
): Promise<SummaryResult> {
  const cfg = getSummaryConfig();
  if (!cfg) {
    throw new VideoMcpError(
      "Summarize model is not configured. Set VIDEO_MCP_SUMMARY_BASE_URL, VIDEO_MCP_SUMMARY_API_KEY, and VIDEO_MCP_SUMMARY_MODEL (OpenAI-compatible chat completions). Or use fetch_assets / get_cached and feed subtitle/asr text + keyframe paths to a multimodal client yourself.",
      "SUMMARY_UNSET",
    );
  }

  // 图文/长文没有字幕/ASR，但 articleText 就是完整正文；视频仍按原优先级。
  // 抖音图文只有文案，真正的信息在图片里，而图片只在 wantKeyframes 时才缓存。
  const isArticle = Boolean(manifest.articleText || manifest.articlePath);
  const transcript =
    manifest.articleText ||
    manifest.subtitleText ||
    manifest.asrText ||
    "(no transcript available)";

  const visualPaths = manifest.imagePaths?.length
    ? manifest.imagePaths
    : manifest.keyframePaths;
  const frameNote = visualPaths?.length
    ? `${isArticle ? "Article image" : "Keyframe image"} paths on disk (client may read): ${visualPaths
        .slice(0, 12)
        .join(", ")}${visualPaths.length > 12 ? " ..." : ""}`
    : isArticle
      ? "No article images cached."
      : "No keyframes cached.";

  const system = isArticle
    ? `You are a careful article analyst. Given the text of an article or text post (Weixin public-account article, Bilibili dynamic/column, Douyin long article, or the caption of a Douyin image post) and its metadata, produce a structured Chinese or English summary (match the article language) as JSON with keys: chapters (array of {heading, points[]}), keyPoints (string[]), conclusion (string). When the text is only a short caption and images are not available, say so in the conclusion instead of inventing content.`
    : `You are a careful video analyst. Given a transcript and metadata from a video, produce a structured Chinese or English summary (match the transcript language) as JSON with keys: chapters (array of {heading, points[]}), keyPoints (string[]), conclusion (string).`;

  const user = [
    `Title: ${manifest.ref.title}`,
    `Author: ${manifest.ref.author}`,
    manifest.ref.durationSec > 0 ? `DurationSec: ${manifest.ref.durationSec}` : "",
    `URL: ${manifest.ref.pageUrl}`,
    focus ? `Focus: ${focus}` : "",
    "",
    isArticle ? "Article text:" : "Transcript:",
    transcript.slice(0, 60000),
    "",
    frameNote,
  ]
    .filter(Boolean)
    .join("\n");

  // Attach a few keyframes as data URLs if small enough (optional best-effort)
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [{ type: "text", text: user }];

  const frames = (visualPaths ?? []).slice(0, 6);
  for (const fp of frames) {
    try {
      const buf = await fs.readFile(fp);
      if (buf.length > 1_500_000) continue;
      const b64 = buf.toString("base64");
      content.push({
        type: "image_url",
        image_url: { url: `data:${imageMimeType(fp)};base64,${b64}` },
      });
    } catch {
      // skip unreadable
    }
  }

  const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content },
      ],
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    throw new VideoMcpError(
      `Summary API failed: HTTP ${res.status} ${await res.text()}`,
      "INTERNAL",
    );
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = json.choices?.[0]?.message?.content ?? "";

  try {
    const fenced = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(fenced?.[0] ?? raw) as {
      chapters?: Array<{ heading: string; points: string[] }>;
      keyPoints?: string[];
      conclusion?: string;
    };
    return {
      title: manifest.ref.title,
      chapters: parsed.chapters ?? [],
      keyPoints: parsed.keyPoints ?? [],
      conclusion: parsed.conclusion ?? raw,
      rawModelText: raw,
    };
  } catch {
    return {
      title: manifest.ref.title,
      chapters: [],
      keyPoints: [],
      conclusion: raw,
      rawModelText: raw,
    };
  }
}
