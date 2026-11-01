export type AsrProvider = "none" | "whisper_local" | "openai_compatible";

export function getAsrProvider(): AsrProvider {
  const v = (process.env.VIDEO_MCP_ASR_PROVIDER ?? "none").toLowerCase();
  if (v === "whisper_local" || v === "openai_compatible" || v === "none") {
    return v;
  }
  return "none";
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
