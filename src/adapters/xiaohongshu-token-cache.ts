import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "../config.js";

type TokenRow = { token: string; xsecSource: string; savedAt: string };

function cacheFile(): string {
  const root = process.env.VIDEO_MCP_CACHE_DIR?.trim();
  return path.join(root ? path.resolve(root) : path.join(projectRoot, "cache"), "xhs", "xsec-tokens.json");
}

async function readAll(): Promise<Record<string, TokenRow>> {
  try {
    const raw = await fs.readFile(cacheFile(), "utf8");
    const parsed = JSON.parse(raw) as Record<string, TokenRow>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function readCachedXsecToken(noteId: string): Promise<TokenRow | null> {
  const row = (await readAll())[noteId];
  if (!row?.token) return null;
  const xsecSource = /^[a-z0-9_]+$/i.test(row.xsecSource ?? "") ? row.xsecSource : "app_share";
  return { ...row, xsecSource };
}

export async function writeCachedXsecToken(noteId: string, token: string, xsecSource: string): Promise<void> {
  if (!token) return;
  const file = cacheFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const all = await readAll();
  all[noteId] = { token, xsecSource, savedAt: new Date().toISOString() };
  await fs.writeFile(file, JSON.stringify(all, null, 2), "utf8");
}