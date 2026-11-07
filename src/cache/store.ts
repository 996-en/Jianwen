import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AssetManifest, VideoRef } from "../types.js";

/** Package root: parent of `dist/` or `src/` depending on runtime. */
export function packageRoot(): string {
  // This file lives at <root>/(dist|src)/cache/store.(js|ts)
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Cache root. Override with VIDEO_MCP_CACHE_DIR;
 * default: `<mcp-package>/cache`.
 */
export function defaultCacheRoot(): string {
  const override = process.env.VIDEO_MCP_CACHE_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(packageRoot(), "cache");
}

export class CacheStore {
  constructor(private readonly root: string = defaultCacheRoot()) {}

  getRoot(): string {
    return this.root;
  }

  dirFor(ref: Pick<VideoRef, "platform" | "id">): string {
    const safeId = ref.id.replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(this.root, ref.platform, safeId);
  }

  manifestPath(ref: Pick<VideoRef, "platform" | "id">): string {
    return path.join(this.dirFor(ref), "manifest.json");
  }

  async ensureDir(ref: Pick<VideoRef, "platform" | "id">): Promise<string> {
    const dir = this.dirFor(ref);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async writeManifest(manifest: AssetManifest): Promise<string> {
    const dir = await this.ensureDir(manifest.ref);
    const p = path.join(dir, "manifest.json");
    await fs.writeFile(p, JSON.stringify(manifest, null, 2), "utf8");
    return p;
  }

  async readManifest(
    ref: Pick<VideoRef, "platform" | "id">,
  ): Promise<AssetManifest | null> {
    const p = this.manifestPath(ref);
    try {
      const raw = await fs.readFile(p, "utf8");
      return JSON.parse(raw) as AssetManifest;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return null;
      throw err;
    }
  }
}
