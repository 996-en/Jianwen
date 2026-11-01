# 见闻 · Jianwen

[English](README.md) | 简体中文

**让 AI 先“看见”和“听见”，再讨论视频。** 见闻是一个运行在本机、通过 stdio 提供服务的 MCP 工具：解析 B 站视频，整理标题和互动数据、字幕／语音转写、画面关键帧，再把可读取的文字与本地文件路径交给 Pi、Cursor、Claude Desktop 等客户端。

名字虽然不绑定平台，**目前真正实现的只有 B 站**；抖音仅预留了扩展方向，暂不能直接解析抖音链接。

## 能做什么

| MCP 工具 | 作用 |
| --- | --- |
| `resolve_video` | 解析 B 站链接、`b23.tv` 短链、BV／av 号，返回标题、首 P 时长、作者／UID、发布时间、互动数及 `aid`/`cid`。 |
| `fetch_assets` | 获取字幕，按需进行语音转写或抽取关键帧，写入本地 `AssetManifest`。 |
| `get_cached` | 读取已有缓存清单，不重复下载媒体。 |
| `summarize` | 可选：将已有文字与最多六张关键帧发送到配置好的 OpenAI 兼容聊天／视觉 API，生成结构化摘要。 |

典型流程：**解析链接 → 获取素材 → 在客户端分析**。不配置摘要 API 也可以把字幕、转写、关键帧路径交给客户端中的模型。`fetch_assets` 每次会重新抓取，不会自动命中旧清单；想复用先用 `get_cached`。这里能返回**评论数量**，不能获取评论正文。

### B 站数据从哪里来

1. `resolve_video` 使用 B 站网页接口 `GET https://api.bilibili.com/x/web-interface/view?bvid=BV...`（也支持 `aid=...`）。`publishedAt` 转为 UTC ISO 8601；`stats.comments` 对应 `stat.reply`，只是当次请求的数量快照。多 P 视频目前只处理**第一 P** 的 `cid` 与时长。
2. 请求字幕时读取播放器接口；有可用平台字幕时，`wantAsr: true` 也会**优先使用字幕**，跳过语音识别。不少视频并没有开放字幕。
3. 画面优先从 B 站视频快照雪碧图中裁剪**最多六张**关键帧，覆盖视频前约 90%，不必下载整段视频；故事板不可用才回退到媒体下载 + ffmpeg 按间隔抽帧。后者生成的帧数可能超过六张。
4. 显式请求 ASR 且没有取到字幕时，优先只下载音轨（`yt-dlp`，失败时尝试公开 playurl），用 ffmpeg 转成单声道 16 kHz WAV，然后调用本地 whisper.cpp；也可明确配置兼容 API 进行云端转写。没有独立音轨时可能下载视频。

`fetch_assets` 默认 `wantSubtitles: true`、`wantAsr: false`、`wantKeyframes: true`、`keyframeIntervalSec: 10`。语音转写**默认关闭**；故事板图是预览缩略图而不是原视频高清帧，模型结论与 ASR 内容应对照原视频核查。

## 安装前准备

- **Node.js 20+** 和 npm。
- **ffmpeg**：转码音频或从下载的视频抽帧时需要，须位于 `PATH`；仅查看元数据／故事板时不需要。
- **yt-dlp**：建议装在 `PATH` 上，提高公开视频下载成功率；代码也有公开 playurl 回退。
- 本地 ASR 才需要 **whisper.cpp 的 `whisper-cli`** 和兼容的多语言 `ggml-*.bin` 模型；云端 ASR／摘要另需相应 API 设置。

取得项目源码后，在项目目录执行：

```sh
npm ci
npm run build
npm test
```

`npm ci` 会触发项目的 `prepare` 构建；显式执行 `npm run build` 便于单独检查 TypeScript。入口是 `node dist/index.js`，这是 **stdio MCP 服务**，不是浏览器打开的 HTTP 网站。

### 获取并配置 Whisper（只有本地 ASR 才需要）

上游仓库是 **[ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp)**，程序下载见 [Releases](https://github.com/ggml-org/whisper.cpp/releases)，GGML 格式模型见 [ggerganov/whisper.cpp 模型库](https://huggingface.co/ggerganov/whisper.cpp)。**Whisper 程序和模型是两个独立的文件**：本项目的 `npm ci` 不会安装它们，云端 ASR 或不使用 ASR 时也不需要它们。

1. **选程序：**Windows x64 可从 Releases 下载适合自己电脑的 CPU 版压缩包，解压后将 `whisper-cli.exe` **连同同包 DLL** 放在同一目录，例如 `Release/whisper-cpu-windows-x64/`。使用 NVIDIA GPU 时，需要针对自己显卡架构构建／取得匹配的 CUDA 版本；不要以为任意标注“CUDA”的包都通用。其他系统需获取对应的 whisper.cpp 可执行文件。上游也提供源码和编译说明，不想使用预编译包时可参考[上游 README](https://github.com/ggml-org/whisper.cpp#readme)自行构建。
2. **下载模型：**从上述模型库获取多语言版 `ggml-large-v3-turbo.bin`（约 1.6 GB），放到 `Release/models/ggml-large-v3-turbo.bin`；也可使用其他支持中文的**多语言** GGML 模型并按实际文件名配置。只有 `.en` 后缀的英语模型不适合中文视频。可以从 whisper.cpp 源码目录使用其 [Windows 模型下载脚本](https://github.com/ggml-org/whisper.cpp/blob/master/models/download-ggml-model.cmd)：在 PowerShell 中运行 `& .\models\download-ggml-model.cmd large-v3-turbo`，下载后将模型放到所需位置。
3. **配置路径并重启客户端：**设置 `VIDEO_MCP_ASR_PROVIDER=whisper_local`、`VIDEO_MCP_WHISPER_BIN=<whisper-cli 完整路径>`、`VIDEO_MCP_WHISPER_MODEL=<模型完整路径>`；下方有 MCP 客户端 `env` 示例。确认 ffmpeg 在 `PATH` 中，然后对没有平台字幕的视频调用 `fetch_assets`，传 `wantAsr: true`（想只要文字可同时传 `wantKeyframes: false`）。

**Windows x64 打包下载：**[夸克网盘分享](https://pan.quark.cn/s/3f1f83689bec?pwd=CSxJ)，提取码 `CSxJ`。网盘中有 `models/`、`whisper-cpu-windows-x64/` 和 `whisper-cuda13.2-rtx20-50-windows-x64/`；按需下载并放到项目的 `Release/` 下，保持目录结构不变（程序选 CPU 或 CUDA 其一，模型需单独下载）。网盘提供的是 Whisper 程序和模型，**不包含本项目源码或 npm 依赖**。

本机曾准备过 Windows x64 的 CPU 版及 CUDA 13.2 GPU 版；详见 [`Release/README.md`](Release/README.md)。**这些二进制及模型被 Git 忽略，克隆源码不会附带**；若未自行下载／单独提供，请将上面的路径改为你实际安装的位置。CUDA 包编译了 SM 75／86／89／120（RTX 20／30／40／50 架构），仅 RTX 5060 Ti 做过实机验证；需兼容驱动、足够显存和 Microsoft Visual C++ 运行库。附带所需 CUDA DLL 的打包版本无需在使用者电脑上安装 CUDA Toolkit。GTX 10、macOS、Linux、Windows ARM64 应选择适用的其他构建；**服务不会自动探测硬件并切换 CPU/GPU 版本**。分发二进制／模型时请遵守各自许可。

## 接入 MCP 客户端

将下例的 `PATH_TO_JIANWEN` 换成项目**绝对路径**。Windows 的 JSON 路径可用正斜杠，例如 `D:/Code/Jianwen/dist/index.js`；若 `node` 不在客户端的 `PATH`，改用 node.exe 绝对路径。

Cursor 的 MCP 配置或 Claude Desktop 配置（Windows：`%APPDATA%\Claude\claude_desktop_config.json`）可写：

```json
{
  "mcpServers": {
    "jianwen": {
      "command": "node",
      "args": ["PATH_TO_JIANWEN/dist/index.js"],
      "env": { "VIDEO_MCP_ASR_PROVIDER": "none" }
    }
  }
}
```

**Pi：**把相同的 `mcpServers.jianwen` 条目加入用户级 `~/.pi/agent/mcp.json`（Windows 为 `%USERPROFILE%\.pi\agent\mcp.json`），可按需要加 `"timeout": 300` 和 `"exposure": "codemode"`。不要覆盖原有其他 MCP 配置。运行 `pi mcp list` 查看是否连接；已经打开的 Pi 会话修改配置后执行 `/reload`。Pi 能用进度通知延续长耗时请求，但具体超时仍须按自己的环境配置。

**启用本地转写：**把客户端配置中的 `env` 改为（路径均须替换为自己的实际文件）：

```json
{
  "VIDEO_MCP_ASR_PROVIDER": "whisper_local",
  "VIDEO_MCP_WHISPER_BIN": "PATH_TO_JIANWEN/Release/whisper-cpu-windows-x64/whisper-cli.exe",
  "VIDEO_MCP_WHISPER_MODEL": "PATH_TO_JIANWEN/Release/models/ggml-large-v3-turbo.bin",
  "VIDEO_MCP_WHISPER_LANGUAGE": "auto"
}
```

符合条件且已备好 GPU 包时，改用 `PATH_TO_JIANWEN/Release/whisper-cuda13.2-rtx20-50-windows-x64/whisper-cli.exe`；其他系统指向自己的 whisper.cpp 可执行文件。这是**明确指定程序**，并非自动适配硬件。

### 环境变量

早期项目名为 `video-understand-mcp`，沿用 `VIDEO_MCP_` 前缀以兼容已有配置。

| 变量 | 用途 |
| --- | --- |
| `VIDEO_MCP_CACHE_DIR` | 缓存根目录；默认 `<项目目录>/cache`。 |
| `VIDEO_MCP_ASR_PROVIDER` | `none`（默认）、`whisper_local` 或 `openai_compatible`。 |
| `VIDEO_MCP_WHISPER_BIN` / `VIDEO_MCP_WHISPER_MODEL` | 本地程序（默认调用 PATH 上的 `whisper-cli`）／**必需**的模型完整路径。 |
| `VIDEO_MCP_WHISPER_LANGUAGE` | 默认 `auto`，纯中文可设 `zh`。 |
| `VIDEO_MCP_ASR_BASE_URL` / `VIDEO_MCP_ASR_API_KEY` / `VIDEO_MCP_ASR_MODEL` | 兼容语音转写 API；模型默认 `whisper-1`。**音频会发送给服务商。** |
| `VIDEO_MCP_SUMMARY_BASE_URL` / `VIDEO_MCP_SUMMARY_API_KEY` / `VIDEO_MCP_SUMMARY_MODEL` | 兼容 chat completions 的摘要 API。**文本和可读取的画面图片可能发给服务商。** |
| `VIDEO_MCP_BILIBILI_UA` | 自定义 B 站请求的 User-Agent。 |

不配置摘要 API 时，`summarize` 返回 `SUMMARY_UNSET`，其他工具仍能使用。不要提交密钥。已下载的音频、WAV、帧图、字幕和清单会留在本机缓存，需自行清理；常规 MCP 工具返回文字与**本地路径**，不会自动把所有帧编码到聊天上下文。

## 调用示例与长视频

```text
resolve_video  { "url": "https://www.bilibili.com/video/BV1VqsQ6KEoy" }
fetch_assets   { "id": "BV1VqsQ6KEoy", "wantKeyframes": false }
fetch_assets   { "id": "BV1VqsQ6KEoy", "wantAsr": true, "wantKeyframes": false }
get_cached     { "id": "BV1VqsQ6KEoy" }
```

第二条只要字幕：如果原视频没有开放字幕，结果**不会凭标题编造内容**；要转写则需启用 ASR 并设置 `wantAsr: true`。素材放在 `<缓存目录>/bilibili/<BV号>/`，包含 `manifest.json`，以及可能存在的 `subtitle.txt`、`asr.txt`、`audio_16k.wav`、`keyframes/` 等。需要新的互动数快照时重新调用 `fetch_assets`。

**本地 Whisper 进程超时**随首 P 时长（秒）估算：`min(86400, max(300, ceil(durationSec * 3 + 120)))`；时长未知或非法则是 **1800 秒**。调用 `fetch_assets` 时可传 `asrTimeoutSec`（整数 **30～86400**）覆盖。这仅限制**本地 Whisper 子进程**，并不能延长 MCP 客户端自己的超时，也不限制解析、下载、ffmpeg 或云端 ASR。客户端提供进度令牌时，阶段变化及约每 **20 秒**会发送进度通知；支持收到进度后重置超时的客户端（包括 Pi）可以继续等待。取消操作会终止正在运行的 ffmpeg／Whisper，但可能无法立即中断媒体下载。

曾在维护者电脑上用 `BV1VqsQ6KEoy` 验证：不下载视频取得六张故事板图，启用本地 ASR 后取得转写。另对 **2397 秒**的 `BV1fKeg6mEY4` 做过一次 GPU 转写测试：约 **94 秒**完成，收到八次进度通知。这只是一次特定环境实测，**不代表所有客户端都能跨过 300 秒请求上限**，也不保证其他长视频速度相同。

## 排查问题与已知边界

- **验证 B 站上游：**Postman 新建 GET 请求 `https://api.bilibili.com/x/web-interface/view`，Params 填 `bvid=BV1VqsQ6KEoy`；既检查 HTTP 状态，也检查 JSON `code`（成功为 `0`）。`data.pubdate` 是 Unix 秒级时间戳，`data.owner.mid` 是 UID，`data.stat.reply` 是评论／回复**数量**。这是本项目调用的 B 站网页接口，**不是 MCP HTTP 接口，也不能视作承诺长期稳定的开放平台契约**；遇风控不要高频重试。
- **没有字幕：**视频可能本来就没有字幕；按需开启 ASR、安装 ffmpeg 和 Whisper 或配置云端接口。ASR 默认关闭。
- **没有关键帧：**故事板可能不可用；回退抽帧要求能下载媒体、能执行 ffmpeg，通常建议安装 yt-dlp。暂不支持登录态、Cookie、大会员或付费视频。
- **缓存未命中：**先调用 `fetch_assets`；`get_cached` 才能读取。旧缓存的互动数据不会自动刷新。
- **长任务中断：**要看客户端自身的请求超时；单独增大 `asrTimeoutSec` 并不能改变客户端超时。Pi 修改 MCP 配置后可能需要 `/reload`。
- **平台范围：**`src/adapters/registry.ts` 只注册 B 站。抖音目前没有实现；其授权 API 与网页访问／Cookie 条件和 B 站不同。

扩展平台需在 `src/adapters/` 实现 `PlatformAdapter` 并于 `src/adapters/registry.ts` 注册，变更后运行 `npm test`、`npm run build`。Windows Cursor 详细安装另见 [INSTALL_CN.md](INSTALL_CN.md)。

## 许可证

项目为 MIT（见 `package.json`）；模型及第三方二进制另受各自许可约束。
