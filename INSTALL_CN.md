# 在个人 Windows 电脑上用 Cursor 接入见闻（Jianwen）

适合：本机安装、个人用 Cursor 聊天里丢 B 站或抖音链接，让 AI 读懂视频内容。

## 1. 准备环境

1. 安装 **Node.js 20+**（[nodejs.org](https://nodejs.org/) 或 `winget install OpenJS.NodeJS.LTS`）。
2. 安装 **ffmpeg**，并确认命令行能运行 `ffmpeg -version`。
3. 准备 **whisper.cpp**（可选，只有要本地转写时）：把程序和模型放进项目的 `Release/`，服务会自动探测，详见 [README.zh-CN.md](./README.zh-CN.md) 的 Whisper 章节。
4. 把本项目文件夹拷到本机，例如：`C:\Users\你的用户名\jianwen`。
5. 要解析抖音时，再准备一个能打开抖音网页的浏览器（导出 Cookie 用）。

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
      ]
    }
  }
}
```

注意 Windows 路径里的反斜杠要写成 `\\`，或改用正斜杠 `/`。除非要覆盖默认值，`env` 一般不用写：本地 ASR 会自动使用 `Release/` 里的 whisper，抖音 Cookie 默认读项目根目录的 `.douyin-cookies.txt`。

3. **完全退出并重启 Cursor**。
4. 在 MCP 面板确认 `jianwen` 已连接（绿灯/已启用）。

## 4. 怎么用

在 Cursor 聊天里直接发链接，例如：

- `帮我看看这个视频讲了什么：https://www.bilibili.com/video/BVxxxx`
- `帮我看看这个抖音：https://v.douyin.com/xxxx/`（也可直接贴整段分享文字）
- 或先让助手调用 `resolve_video`，再 `fetch_assets`。

默认只取**文字**：B 站优先用平台字幕，没有字幕（以及抖音全部情况）则用本地 whisper 转写；需要画面关键帧时显式传 `wantKeyframes: true`，并依赖本机 ffmpeg。  
抖音需要浏览器访客 Cookie，先在项目目录运行一次 `npm run douyin:cookies`。  
不支持登录/大会员专享视频和抖音图文作品；若报 VIP/登录错误，请换公开视频。

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
| 抖音报 `COOKIE_REQUIRED` | 在项目目录跑 `npm run douyin:cookies`，然后重启 Cursor |
| 抖音返回 200 但内容为空 | Cookie 过期或被软风控，重跑 `npm run douyin:cookies`，不要循环重试 |
| B 站下载失败 | 换公开视频；检查网络或大会员限制 |
| 没有文字 | 确认 `Release/` 里有 whisper 程序与模型（或配 `VIDEO_MCP_ASR_*`），`ffmpeg` 在 PATH |
| 需要关键帧但没有图 | 调用时传 `wantKeyframes: true`，并安装 ffmpeg |
| summarize 报错 | 未配置 `VIDEO_MCP_SUMMARY_*` 时属预期，请配齐或改用素材 |

更细的说明见 [README.zh-CN.md](./README.zh-CN.md)（英文：[README.md](./README.md)），其中「接入 MCP 客户端」一节含 Cursor / Claude Desktop / Pi 的完整配置与不接客户端时的自测步骤。
