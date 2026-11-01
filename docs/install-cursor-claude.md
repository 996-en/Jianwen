# Install Jianwen for Cursor and Claude Desktop

## Absolute path examples

- Windows: `C:\\Users\\YOU\\jianwen\\dist\\index.js`
- macOS: `/Users/YOU/jianwen/dist/index.js`
- Linux: `/home/YOU/jianwen/dist/index.js`

## Cursor mcp.json

```json
{
  "mcpServers": {
    "jianwen": {
      "command": "node",
      "args": ["PATH_TO_REPO/dist/index.js"],
      "env": {
        "VIDEO_MCP_ASR_PROVIDER": "none"
      }
    }
  }
}
```

## Claude Desktop

```json
{
  "mcpServers": {
    "jianwen": {
      "command": "node",
      "args": ["PATH_TO_REPO/dist/index.js"]
    }
  }
}
```

Restart the app after editing.

## MCP Inspector smoke test

```bash
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

1. `resolve_video` with `{ "id": "BV1GJ411x7h7" }` (replace with a known public BV).
2. `fetch_assets` with the same id (`wantKeyframes: true` needs ffmpeg).
3. `get_cached` should return the manifest.
4. `summarize` without env → expect `SUMMARY_UNSET` message.

## Douyin later

Add `src/adapters/douyin.ts` implementing `PlatformAdapter`, register in `registry.ts`. No MCP tool renames.
