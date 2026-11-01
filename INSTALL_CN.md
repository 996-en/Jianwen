# 在个人 Windows 电脑上用 Cursor 接入见闻（Jianwen）

适合：本机安装、个人用 Cursor 聊天里丢 B 站链接，让 AI 读懂视频内容。

## 1. 准备环境

1. 安装 **Node.js 20+**（[nodejs.org](https://nodejs.org/) 或 `winget install OpenJS.NodeJS.LTS`）。
2. 安装 **ffmpeg**，并确认命令行能运行 `ffmpeg -version`。
3. **强烈建议**安装 **yt-dlp**（`winget install yt-dlp.yt-dlp`），下载公开视频更稳。
4. 把本项目文件夹拷到本机，例如：`C:\Users\你的用户名\jianwen`。

## 2. 安装并编译

在 PowerShell 或「命令提示符」里：

```bat
cd C:\Users\你的用户名\jianwen
npm install
npm run build
```

成功后应存在文件：`dist\index.js`。

可选自测：

```bat
npm test
```

## 3. 配置 Cursor MCP

1. 打开 Cursor → **Settings** → **MCP**（或直接编辑 `mcp.json`）。
2. 增加类似配置（**路径改成你的绝对路径**）：

```json
{
  "mcpServers": {
    "jianwen": {
      "command": "node",
      "args": [
        "C:\\Users\\你的用户名\\jianwen\\dist\\index.js"
      ],
      "env": {
        "VIDEO_MCP_ASR_PROVIDER": "none"
      }
    }
  }
}
```

注意 Windows 路径里的反斜杠要写成 `\\`，或改用正斜杠 `/`。

3. **完全退出并重启 Cursor**。
4. 在 MCP 面板确认 `jianwen` 已连接（绿灯/已启用）。

## 4. 怎么用

在 Cursor 聊天里直接发 B 站链接或 BV 号，例如：

- `帮我看看这个视频讲了什么：https://www.bilibili.com/video/BVxxxx`
- 或先让助手调用 `resolve_video`，再 `fetch_assets`。

默认会尽量拉**字幕**；需要画面关键帧时依赖本机 ffmpeg。  
第一版**不支持登录/大会员**专享视频；若报 VIP/登录错误，请换公开视频。

## 5. 可选：一键摘要

若要在 MCP 内调用 `summarize`，在 Cursor 的 `env` 里再加：

- `VIDEO_MCP_SUMMARY_BASE_URL`（OpenAI 兼容，例如 `https://api.openai.com/v1`）
- `VIDEO_MCP_SUMMARY_API_KEY`
- `VIDEO_MCP_SUMMARY_MODEL`

不配也可以：用 `fetch_assets` 拿到的字幕/关键帧路径，交给 Cursor 里本身的多模态模型读。

## 6. 缓存目录

默认：放在本 MCP 项目目录下的 `cache\`（例如 `D:\Code\Jianwen\cache\`）  
可用环境变量 `VIDEO_MCP_CACHE_DIR` 指定到任意路径。

## 7. 常见问题

| 现象 | 处理 |
|------|------|
| MCP 连不上 | 检查 `node` 是否在 PATH；`args` 是否指向存在的 `dist\index.js`；重启 Cursor |
| 下载失败 | 安装 yt-dlp；换公开视频；检查网络 |
| 缺少关键帧 | 安装 ffmpeg |
| summarize 报错 | 未配置 `VIDEO_MCP_SUMMARY_*` 时属预期，请配齐或改用素材 |

更细的英文说明见 [README.md](./README.md) 与 [docs/install-cursor-claude.md](./docs/install-cursor-claude.md)。
