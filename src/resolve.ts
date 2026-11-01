import { adapterByPlatform, findAdapter } from "./adapters/registry.js";
import type { VideoRef } from "./types.js";
import { VideoMcpError } from "./types.js";

/** Resolve from url/id string or a partial VideoRef-like object */
export async function resolveInput(input: {
  url?: string;
  id?: string;
  ref?: VideoRef;
}): Promise<VideoRef> {
  if (input.ref?.platform && input.ref?.id && input.ref?.pageUrl) {
    return input.ref;
  }
  const token = (input.url ?? input.id ?? "").trim();
  if (!token) {
    throw new VideoMcpError(
      "Provide url, id, or a full VideoRef.",
      "UNSUPPORTED_URL",
    );
  }
  // If looks like platform:id
  const m = token.match(/^([a-z]+):(.+)$/i);
  if (m && !token.includes("://")) {
    try {
      const adapter = adapterByPlatform(m[1]!.toLowerCase());
      return adapter.resolve(m[2]!);
    } catch {
      // fall through
    }
  }
  const adapter = findAdapter(token);
  return adapter.resolve(token);
}
