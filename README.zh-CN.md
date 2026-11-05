# 见闻 · Jianwen

[English](README.md) | 简体中文

**让 AI 先“看见”和“听见”，再讨论视频。** 见闻是一个运行在本机、通过 stdio 提供服务的 MCP 工具：解析 B 站或抖音视频、微信公众号图文，整理标题和互动数据、字幕／语音转写、画面关键帧或文章正文，再把可读取的文字与本地文件路径交给 Pi、Cursor、Claude Desktop 等客户端。

名字虽然不绑定平台，**目前实现了 B 站、抖音与微信公众号图文**。抖音需要浏览器签发的访客 Cookie，因为它的详情接口要求浏览器身份和签名（见下文）；微信长链可能需要 `chksm`，短链通常可直接读取。微信视频号（Channels）尚未实现。

## 能做什么

| MCP 工具 | 作用 |
| --- | --- |
| `resolve_video` | 解析 B 站链接、`b23.tv` 短链、BV／av 号，返回标题、首 P 时长、作者／UID、发布时间、互动数及 `aid`/`cid`；也解析抖音作品链接、`v.douyin.com` 分享链接或 aweme id，返回标题、时长、作者、发布时间与互动数；还解析微信文章短链／长链，返回标题、公众号、作者、发布时间、正文与图片地址。 |
| `fetch_assets` | 获取字幕，按需进行语音转写或抽取关键帧，写入本地 `AssetManifest`。默认只取文字，需要画面必须显式要帧；微信文章写 `article.md`／`article.html`，按需下载正文图片。 |
| `get_cached` | 读取已有缓存清单，不重复下载媒体。 |
| `summarize` | 可选：将已有文字与最多六张关键帧发送到配置好的 OpenAI 兼容聊天／视觉 API，生成结构化摘要。 |

典型流程：**解析链接 → 获取素材 → 在客户端分析**。不配置摘要 API 也可以把字幕、转写、关键帧路径交给客户端中的模型。`fetch_assets` 每次会重新抓取，不会自动命中旧清单；想复用先用 `get_cached`。这里能返回**评论数量**，不能获取评论正文。

### B 站数据从哪里来

1. `resolve_video` 使用 B 站网页接口 `GET https://api.bilibili.com/x/web-interface/view?bvid=BV...`（也支持 `aid=...`）。`publishedAt` 转为 UTC ISO 8601；`stats.comments` 对应 `stat.reply`，只是当次请求的数量快照。多 P 视频目前只处理**第一 P** 的 `cid` 与时长。
2. 请求字幕时读取播放器接口；有可用平台字幕时即使开着 ASR 也会**优先使用字幕**，跳过语音识别。不少视频并没有开放字幕，此时只有配置了 ASR provider 才会得到文字。
3. 画面优先从 B 站视频快照雪碧图中裁剪**最多六张**关键帧，覆盖视频前约 90%，不必下载整段视频；故事板不可用才回退到媒体下载 + ffmpeg 按间隔抽帧。后者生成的帧数可能超过六张。
4. 显式请求 ASR 且没有取到字幕时，优先只下载音轨（`yt-dlp`，失败时尝试公开 playurl），用 ffmpeg 转成单声道 16 kHz WAV，然后调用本地 whisper.cpp；也可明确配置兼容 API 进行云端转写。没有独立音轨时可能下载视频。
5. 本地 whisper.cpp 的转写在写入前会做后处理：用 OpenCC 把繁体统一成简体，去掉背景音乐导致的连续重复段，再把分段按停顿或字数上限合并成段落，而不是一句一行。带时间戳的原始分段保留在同目录的 `asr.json`。

`fetch_assets` 默认 `wantSubtitles: true`、`wantKeyframes: false`、`keyframeIntervalSec: 10`，所以**不传参就是“只要文字”**：平台字幕或转写稿，绝不会为了截帧去下载整片视频。`wantAsr` 在配置了 `VIDEO_MCP_ASR_PROVIDER` 时**自动开启**（有了平台字幕会自动跳过），显式传 `false` 才会关闭。需要看画面时传 `wantKeyframes: true`；B 站会用故事板雪碧图裁切，不下载视频，抖音没有故事板则会下整片 mp4（抽完默认删除，`VIDEO_MCP_KEEP_MEDIA=1` 可保留）。故事板图是预览缩略图而不是原视频高清帧，模型结论与 ASR 内容应对照原视频核查。

### 抖音数据从哪里来

1. 支持 `https://www.douyin.com/video/<aweme_id>`、`v.douyin.com/...` 分享短链（App 复制的整段分享文字也可以，短链会被跟随拿到作品 ID），以及 19 位裸 aweme id。图文作品（`/note/...`）返回 `UNSUPPORTED_URL`。
2. 元数据来自网页版详情接口 `GET https://www.douyin.com/aweme/v1/web/aweme/detail/`。该接口不接受裸请求：既需要浏览器签发的访客身份（`UIFID`、`ttwid` 等），也需要 query 签名。所以本项目按 `VIDEO_MCP_DOUYIN_COOKIES` → `VIDEO_MCP_DOUYIN_COOKIE_FILE` → 项目根目录 `.douyin-cookies.txt` 的顺序取 Cookie（最后一个就是默认值，通常不用配 `env`），并自行计算 `x-secsdk-web-signature`；签名公式写在 `src/adapters/douyin-sign.ts` 顶部，与浏览器实际发出的签名逐字节一致。
3. Cookie 缺失或失效返回 `COOKIE_REQUIRED`。Cookie 必须来自**同一个浏览器会话**（访客 `UIFID` 与 `ttwid` 是成套签发的），自行拼接或伪造 `UIFID` 会得到 `403 Blocked by ArgusSecurityPlugin`。不需要 `a_bogus` 和 `msToken`。
4. 抖音**没有字幕轨道，也没有故事板**。请求 ASR 或关键帧时会下载 `play_addr` 的完整 mp4（h264 + aac）；`bit_rate[*].play_addr` 多是纯视频 DASH 流、没有音轨，所以不使用。之后复用原有管线：ffmpeg 转单声道 16 kHz WAV 做 ASR、ffmpeg 抽帧。
   **只要文字、不要画面时（即默认路径）**：ffmpeg 会直接读 CDN 地址，而不是先下整片 —— 抖音 CDN 支持 `206 Partial Content` 且 `moov` 在文件头，因此只需下载音轨部分（11 分钟的视频约 10 MB，而不是 35 MB），并一次性写成 16 kHz WAV。任何一步失败（没装 ffmpeg、CDN 拒 Range、签名过期）都会静默回落到整片下载，所以**产物完全一样，只是省流量／省磁盘**；总耗时基本不变，因为大头是 Whisper。想恢复“总是先下整片”设 `VIDEO_MCP_DOUYIN_FAST_AUDIO=0`。
5. 抖音网页接口通常把 `play_count` 返回为 0，因此 `stats.views` 会留空而不是填 0。作者 ID 是 `sec_uid` 字符串，放不进数字型的 `authorId`，改放在 `extras.authorSecUid`。

### 微信公众号数据从哪里来

1. 支持短链 `https://mp.weixin.qq.com/s/<id>`、长链 `https://mp.weixin.qq.com/s?__biz=...&mid=...&idx=...&sn=...`，以及包含链接的整段分享文字。`resolve_video` 提取标题、公众号、作者、发布时间（`ct`）、`#js_content` 正文和最多 50 个正文图片地址；`fetch_assets` 写 `article.md` 与 `article.html`，传 `wantKeyframes: true` 时最多下载 20 张正文图到 `images/`。文章会完全跳过 ffmpeg 与 ASR。
2. 短链通常直接返回正文；长链更容易跳 `mp/wappoc_appmsgcaptcha`（“环境异常”）。长链自带有效 `chksm` 时优先使用；否则依次尝试配置值、已学／已持久化的缓存、`mp/getappmsgext` 返回的 `pre_article_link`/`next_article_link`、百度索引，最后才用 `src/adapters/weixin-seeds.ts` 内置的 20 条人民日报文章长链兜底（每条都自带公开索引里的 `chksm`）。首次成功的 token 会立即写缓存，下次优先复用。
3. `chksm` 是服务端签名，不能由 `biz`/`mid`/`idx`/`sn` 算出，也可能过期或轮换。内置文章只负责“起个头”：某个 token 失效会自动试下一条，全部失败才返回 `WEIXIN_CAPTCHA`，提示改用短链或配置 token。
4. 只支持公众号**图文**；视频号视频、付费文章、已删除文章不支持。账号注销、发布者删除、作者隐私设置不可见、违规/侵权下架会返回 `NOT_FOUND`，并在错误信息里带上具体原因；只有确实遇到验证码时才返回 `WEIXIN_CAPTCHA`。请遵守微信的访问频率与使用条款；本项目不会尝试破解滑块验证码。

Cookie 获取方式：用浏览器打开目标作品，用任意 Cookie 导出扩展导出 `douyin.com` 的 `cookies.txt`；或在开发者工具 Network 里找到 `aweme/detail` 请求，复制其 `Cookie` 请求头。`VIDEO_MCP_DOUYIN_UA` 最好与签发 Cookie 的浏览器一致，UA 不一致可能导致空响应。

如果本机装了 [browser-harness](https://github.com/browser-use/browser-harness) 且 Chrome 里能正常打开抖音，可以直接用它从当前浏览器导出，不用装扩展：

```powershell
npm run douyin:cookies                # 写入 <项目根>/.douyin-cookies.txt
npm run douyin:cookies -- --guest-only  # 剔除登录态，只保留访客身份
npm run douyin:cookies -- --out D:/path/cookies.txt
```

Cookie 会过期（几周到几个月），失效表现是 `COOKIE_REQUIRED` 或 200 空响应，重跑上面的命令即可。`scripts/douyin-cookies.mjs` 只是本机便利脚本，不参与 MCP 运行时，也不会打进 `dist`。

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

### 目录结构

```text
src/                         正式代码，`npm run build` 只编译这里（→ dist/）
  index.ts                   MCP 服务入口：定义并注册 resolve_video / fetch_assets /
                             get_cached / summarize 四个工具，启动 stdio 传输
  resolve.ts                 入参归一化：url、id、"platform:id"、完整 VideoRef 四种写法 → VideoRef
  types.ts                   全局类型：VideoRef、VideoStats、AssetManifest、VideoMcpError 与错误码
  config.ts                  读取 VIDEO_MCP_* 环境变量，给出项目根路径、默认抖音 Cookie 文件、
                             三个平台的 UA、ASR 与摘要模型配置
  summarize.ts               调用 OpenAI 兼容的 chat completions，把元数据 + 字幕/转写 +
                             关键帧清单整理成分段提要
  adapters/                  平台适配层，一个平台一组文件
    types.ts                 PlatformAdapter 契约（platform / canHandle / resolve / fetchMedia）
                             与 MediaFetchResult
    registry.ts              注册表：findAdapter(用户输入) 按顺序挑适配器，
                             adapterByPlatform(平台名) 给缓存复用
    bilibili.ts              B 站：URL/BV/av 识别、view + player 元数据、字幕、下载
    bilibili-storyboard.ts   B 站故事板：videoshot 雪碧图接口 + sharp 裁帧；失败时由
                             bilibili.ts 降级为下载整段视频
    douyin.ts                抖音：短链跳转、Cookie 会话、签名后的详情请求、媒体候选下载
    douyin-sign.ts           抖音 query 签名 x-secsdk-web-signature 与固定网页端参数（纯函数）
    weixin.ts                微信公众号图文：URL 识别、HTML 标题/正文/图片解析、chksm 兜底、
                             article.md/article.html 写入
    weixin-seeds.ts          内置人民日报文章长链，每条自带 chksm
    weixin-chksm.ts          chksm 持久化与种子短链缓存
  cache/
    store.ts                 缓存根目录、<platform>/<id>/ 布局、manifest.json 读写
  pipeline/
    assets.ts                下载后处理：ffmpeg 转 16 kHz 单声道 WAV、ASR（本地 whisper 或
                             云端 API）、抽关键帧、落盘 manifest
    asr-text.ts              把 whisper.cpp 的 JSON 分段转简体、去掉重复句、按停顿并段
tests/                       测试，与 src/ 同构镜像；`npm test` 跑这里，不进入 dist
  config.test.ts             默认路径与环境变量优先级（含默认抖音 Cookie 文件）
  adapters/bilibili.test.ts  B 站输入解析、元数据、字幕、下载（mock fetch）
  adapters/bilibili-storyboard.test.ts  故事板裁帧与降级路径
  adapters/douyin.test.ts    抖音输入识别、Cookie 文件解析、resolve 字段映射、错误码、
                             媒体候选（mock fetch）
  adapters/douyin-sign.test.ts  签名算法离线回归，无网络也能跑
  adapters/weixin.test.ts    微信 URL 识别、HTML 解析、验证码/chksm 路径、图片下载（mock fetch）
  cache/store.test.ts        缓存目录与 manifest 往返
  pipeline/assets.test.ts    转码/ASR/抽帧编排（mock 外部命令）
scripts/
  douyin-cookies.mjs         从 browser-harness 托管的真实浏览器导出抖音 Cookie
                             （npm run douyin:cookies），不进入 dist
dist/                        npm run build 产物，入口是 node dist/index.js（不入库）
cache/                       运行时缓存，每个视频一个子目录（不入库）
Release/                     whisper.cpp 程序与 GGML 模型（不入库，仅保留 README.md）
```

`npm run build` 把 `src/` 编译到 `dist/`；`npm test` 先用 `tsconfig.test.json` 对 `src/` 和 `tests/` 一起做类型检查，再跑测试用例——测试文件不会进 `dist/`，但类型错误照样会让测试挂掉。

仓库根目录的文件：

| 文件 | 作用 |
| --- | --- |
| `package.json` | 依赖、`bin`/入口、脚本（`build`、`test`、`douyin:cookies`）、`engines.node >= 20` |
| `tsconfig.json` | 构建配置：`src/` → `dist/` |
| `tsconfig.test.json` | 在构建配置基础上加 `noEmit` 与 `rootDir: "."`，让 `npm test` 能同时检查 `src/` 与 `tests/` |
| `.gitignore` | 忽略 `node_modules/`、`dist/`、`cache/`、`Release/` 下的二进制、`*.log`、`.env`、`*cookies*.txt`、`.playwright-mcp/` |
| `README.md` / `README.zh-CN.md` | 英文／中文说明（本文件） |
| `INSTALL_CN.md` | Windows + Cursor 的中文安装向导 |
| `.douyin-cookies.txt` | 抖音 Cookie，由 `npm run douyin:cookies` 生成，服务默认读取它（不入库） |
| `Release/README.md` | 本机 whisper.cpp 程序与模型的放置说明（二进制本身不入库） |

### 获取并配置 Whisper（只有本地 ASR 才需要）

上游仓库是 **[ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp)**，程序下载见 [Releases](https://github.com/ggml-org/whisper.cpp/releases)，GGML 格式模型见 [ggerganov/whisper.cpp 模型库](https://huggingface.co/ggerganov/whisper.cpp)。**Whisper 程序和模型是两个独立的文件**：本项目的 `npm ci` 不会安装它们，云端 ASR 或不使用 ASR 时也不需要它们。

1. **选程序：**Windows x64 可从 Releases 下载适合自己电脑的 CPU 版压缩包，解压后将 `whisper-cli.exe` **连同同包 DLL** 放在同一目录，例如 `Release/whisper-cpu-windows-x64/`。使用 NVIDIA GPU 时，需要针对自己显卡架构构建／取得匹配的 CUDA 版本；不要以为任意标注“CUDA”的包都通用。其他系统需获取对应的 whisper.cpp 可执行文件。上游也提供源码和编译说明，不想使用预编译包时可参考[上游 README](https://github.com/ggml-org/whisper.cpp#readme)自行构建。
2. **下载模型：**从上述模型库获取多语言版 `ggml-large-v3-turbo.bin`（约 1.6 GB），放到 `Release/models/ggml-large-v3-turbo.bin`；也可使用其他支持中文的**多语言** GGML 模型并按实际文件名配置。只有 `.en` 后缀的英语模型不适合中文视频。可以从 whisper.cpp 源码目录使用其 [Windows 模型下载脚本](https://github.com/ggml-org/whisper.cpp/blob/master/models/download-ggml-model.cmd)：在 PowerShell 中运行 `& .\models\download-ggml-model.cmd large-v3-turbo`，下载后将模型放到所需位置。
3. **放到 `Release/` 即可（推荐）或配置路径：**若已按下面“Windows x64 打包下载”把程序与模型放进 `Release/`，**不用再加任何环境变量**：服务会自动在 `Release/whisper-*/whisper-cli.exe` 与 `Release/models/ggml-*.bin` 里选址（有 NVIDIA 显卡时优先 CUDA 版，否则用 CPU 版）。想指定别的程序或模型，再设 `VIDEO_MCP_WHISPER_BIN` / `VIDEO_MCP_WHISPER_MODEL`（均优先于自动探测）；下方有 MCP 客户端 `env` 示例。确认 ffmpeg 在 `PATH` 中，之后对没有平台字幕的视频直接调用 `fetch_assets` 就会转写，默认只返回文字；同时需要画面时加 `wantKeyframes: true`。

**Windows x64 打包下载：**[夸克网盘分享](https://pan.quark.cn/s/3f1f83689bec?pwd=CSxJ)，提取码 `CSxJ`。网盘中有 `models/`、`whisper-cpu-windows-x64/` 和 `whisper-cuda13.2-rtx20-50-windows-x64/`；按需下载并放到项目的 `Release/` 下，保持目录结构不变（程序选 CPU 或 CUDA 其一，模型需单独下载）。网盘提供的是 Whisper 程序和模型，**不包含本项目源码或 npm 依赖**。

本机已备好 Windows x64 的 CPU 版和 CUDA 13.2 GPU 版；详见 [`Release/README.md`](Release/README.md)。**这些二进制及模型被 Git 忽略，克隆源码不会附带**；若未自行下载／单独提供，请将上面的路径改为你实际安装的位置。CUDA 包编译了 SM 75／86／89／120（RTX 20／30／40／50 架构），仅 RTX 5060 Ti 做过实机验证；需兼容驱动、足够显存和 Microsoft Visual C++ 运行库。附带所需 CUDA DLL 的打包版本无需在使用者电脑上安装 CUDA Toolkit。GTX 10、macOS、Linux、Windows ARM64 应选择适用的其他构建。服务会自动探测 `Release/`：**有可用 NVIDIA 显卡时优先 CUDA 版，否则用 CPU 版**；环境变量一旦设置就以它为准。分发二进制／模型时请遵守各自许可。

## 接入 MCP 客户端

将下例的 `PATH_TO_JIANWEN` 换成项目**绝对路径**。Windows 的 JSON 路径可用正斜杠，例如 `D:/Code/Jianwen/dist/index.js`；若 `node` 不在客户端的 `PATH`，改用 node.exe 绝对路径。

Cursor 的 MCP 配置或 Claude Desktop 配置（Windows：`%APPDATA%\Claude\claude_desktop_config.json`）可写：

```json
{
  "mcpServers": {
    "jianwen": {
      "command": "node",
      "args": ["PATH_TO_JIANWEN/dist/index.js"]
    }
  }
}
```

除非要覆盖默认值，`env` 可以整段省略：本地 ASR 会自动在 `Release/` 里找程序和模型，抖音 Cookie 默认读 `<项目根>/.douyin-cookies.txt`。所有可调项见下文环境变量表。

**Pi：**把相同的 `mcpServers.jianwen` 条目加入用户级 `~/.pi/agent/mcp.json`（Windows 为 `%USERPROFILE%\.pi\agent\mcp.json`），可按需要加 `"timeout": 300` 和 `"exposure": "codemode"`。不要覆盖原有其他 MCP 配置。运行 `pi mcp list` 查看是否连接；已经打开的 Pi 会话修改配置后执行 `/reload`。Pi 能用进度通知延续长耗时请求，但具体超时仍须按自己的环境配置。

### 不接客户端也能自测

正式接入前，可以先从终端验证服务本身：

```bash
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

在 Inspector 的 **Tools** 页依次调用：

1. `resolve_video`，参数 `{ "id": "BV1GJ411x7h7" }`（换成你知道公开可用的 BV 号）—— 应返回元数据与 `pageUrl`。
2. `fetch_assets`，只传同一个 id —— 应只返回转写文字。抽帧默认关闭，要图得显式传 `"wantKeyframes": true`，且需要 `ffmpeg`。
3. `get_cached`，同一个 id —— 应返回第 2 步写下的 manifest。
4. `summarize` —— 未配置 `VIDEO_MCP_SUMMARY_*` 时返回 `SUMMARY_UNSET`，其余三个工具不受影响。

只要 `<项目根>/.douyin-cookies.txt` 就绪，同一套步骤换成抖音作品（19 位 id、`douyin.com/video/<id>` 长链、`v.douyin.com` 短链或整段分享文字）也能跑通。

**指定 Whisper 程序或模型（可选）：** 放在 `Release/` 时完全不用配置；只有想覆盖自动探测时才需要写 `env`（路径须替换为自己的实际文件）：

```json
{
  "VIDEO_MCP_ASR_PROVIDER": "whisper_local",
  "VIDEO_MCP_WHISPER_BIN": "PATH_TO_JIANWEN/Release/whisper-cpu-windows-x64/whisper-cli.exe",
  "VIDEO_MCP_WHISPER_MODEL": "PATH_TO_JIANWEN/Release/models/ggml-large-v3-turbo.bin",
  "VIDEO_MCP_WHISPER_LANGUAGE": "auto"
}
```

在 RTX 5060 Ti 上实测：`667` 秒的抖音视频，下载 + 抽帧 + `large-v3-turbo` 转写共 **33 秒**，得到 **4520 字**中文转写。

### 环境变量

早期项目名为 `video-understand-mcp`，沿用 `VIDEO_MCP_` 前缀以兼容已有配置。

| 变量 | 用途 |
| --- | --- |
| `VIDEO_MCP_CACHE_DIR` | 缓存根目录；默认 `<项目目录>/cache`。 |
| `VIDEO_MCP_ASR_PROVIDER` | 未设置时**自动判断**：能在 `Release/` 找到 whisper 程序与模型就用 `whisper_local`，否则 `none`；也可显式写 `whisper_local`、`openai_compatible` 或 `none`。非 `none` 时 `fetch_assets` 自动转写（可显式传 `wantAsr: false` 关闭）。 |
| `VIDEO_MCP_WHISPER_BIN` / `VIDEO_MCP_WHISPER_MODEL` | 本地程序与模型路径；**默认自动取** `Release/whisper-*/whisper-cli.exe`（有 NVIDIA 显卡优先 CUDA 版）与 `Release/models/ggml-*.bin`（优先 turbo），都没有时才会去找 `PATH` 上的 `whisper-cli`。 |
| `VIDEO_MCP_WHISPER_LANGUAGE` | 默认 `auto`，纯中文可设 `zh`。 |
| `VIDEO_MCP_WHISPER_VAD_MODEL` | Silero VAD 模型路径；默认自动取 `Release/models/ggml-silero-*.bin`（有就启用）。转写前先切掉纯音乐／静音段，whisper 的复读和幻觉多发在这类区段；设为 `0`/`off` 可关闭。 |
| `VIDEO_MCP_KEEP_MEDIA` | 设为 `1` 时保留抽帧后下载的整段视频（默认删除，只留 `keyframes/`、`audio_16k.wav` 等）。 |
| `VIDEO_MCP_ASR_BASE_URL` / `VIDEO_MCP_ASR_API_KEY` / `VIDEO_MCP_ASR_MODEL` | 兼容语音转写 API；模型默认 `whisper-1`。**音频会发送给服务商。** |
| `VIDEO_MCP_SUMMARY_BASE_URL` / `VIDEO_MCP_SUMMARY_API_KEY` / `VIDEO_MCP_SUMMARY_MODEL` | 兼容 chat completions 的摘要 API。**文本和可读取的画面图片可能发给服务商。** |
| `VIDEO_MCP_BILIBILI_UA` | 自定义 B 站请求的 User-Agent。 |
| `VIDEO_MCP_DOUYIN_COOKIE_FILE` | 为 `douyin.com` 导出的 Netscape `cookies.txt` 路径，**可选**：不设置时自动使用项目根目录的 `.douyin-cookies.txt`（存在才生效）。只会发送域名属于抖音／字节的 Cookie 行。 |
| `VIDEO_MCP_DOUYIN_COOKIES` | 直接给出 `Cookie` 头原文（代替文件），其中必须含 `UIFID`。 |
| `VIDEO_MCP_DOUYIN_UA` | 自定义抖音请求的 User-Agent（默认 Windows 上的 Chrome 156），建议与签发 Cookie 的浏览器保持一致。 |
| `VIDEO_MCP_DOUYIN_FAST_AUDIO` | **默认开启**：仅需转写的抖音请求会让 ffmpeg 直接从 CDN 流式抽音轨，不再下载整片 mp4（11 分钟视频约 10 MB，而不再 35 MB）；任何失败都会自动回落到整片下载。设 `0` 可改为总是下载整片。 |
| `VIDEO_MCP_WEIXIN_UA` | 自定义微信请求的 User-Agent（默认 Windows 上的 Chrome 156）。 |
| `VIDEO_MCP_WEIXIN_CHKSM` | 可选：微信长链的 `chksm` 签名。短链通常不需要；显式值优先于缓存，否则复用上次成功的 token，再尝试相邻文章、搜索和内置文章种子。 |
| `VIDEO_MCP_WEIXIN_CHKSM_FILE` | 覆盖 chksm 与种子链接的持久化位置（默认 `<cache>/weixin/chksm.json`）。 |
| `VIDEO_MCP_WEIXIN_SEARCH` | 设 `0` 可跳过长链无 token 时的百度 `sn` 检索；默认开启。 |

不配置摘要 API 时，`summarize` 返回 `SUMMARY_UNSET`，其他工具仍能使用。不要提交密钥。已下载的音频、WAV、帧图、字幕和清单会留在本机缓存，需自行清理；常规 MCP 工具返回文字与**本地路径**，不会自动把所有帧编码到聊天上下文。

## 调用示例与长视频

```text
resolve_video  { "url": "https://www.bilibili.com/video/BV1VqsQ6KEoy" }
fetch_assets   { "id": "BV1VqsQ6KEoy" }
fetch_assets   { "id": "BV1VqsQ6KEoy", "wantAsr": true }
fetch_assets   { "id": "BV1VqsQ6KEoy", "wantKeyframes": true, "keyframeIntervalSec": 20 }
get_cached     { "id": "BV1VqsQ6KEoy" }
resolve_video  { "url": "https://v.douyin.com/j9yY-DusDuk/" }
fetch_assets   { "id": "7703476743591513353", "wantAsr": true }
resolve_video  { "url": "https://mp.weixin.qq.com/s/__eualYM-v92zEARWVszhQ" }
fetch_assets   { "id": "22eec806d6a5608c3c65dfc32200d676", "wantKeyframes": true }
```

第一条只取“便宜的东西”：有平台字幕就用字幕，没有就转写（需配置 ASR provider）；不传 `wantKeyframes: true` 就不会为了截帧下载视频。**不会凭标题编造内容**。素材放在 `<缓存目录>/bilibili/<BV号>/`，包含 `manifest.json`，以及可能存在的 `subtitle.txt`、`asr.txt`、`audio_16k.wav`、`keyframes/` 等；整段 `media.mp4` 在抽帧或转写完成后会自动删除（`VIDEO_MCP_KEEP_MEDIA=1` 可保留）。需要新的互动数快照时重新调用 `fetch_assets`。

**本地 Whisper 进程超时**随首 P 时长（秒）估算：`min(86400, max(300, ceil(durationSec * 3 + 120)))`；时长未知或非法则是 **1800 秒**。调用 `fetch_assets` 时可传 `asrTimeoutSec`（整数 **30～86400**）覆盖。这仅限制**本地 Whisper 子进程**，并不能延长 MCP 客户端自己的超时，也不限制解析、下载、ffmpeg 或云端 ASR。客户端提供进度令牌时，阶段变化及约每 **20 秒**会发送进度通知；支持收到进度后重置超时的客户端（包括 Pi）可以继续等待。取消操作会终止正在运行的 ffmpeg／Whisper，但可能无法立即中断媒体下载。

曾在维护者电脑上用 `BV1VqsQ6KEoy` 验证：启用本地 ASR 后取得转写；传 `wantKeyframes: true` 时取得六张故事板图且不下载视频。另对 **2397 秒**的 `BV1fKeg6mEY4` 做过一次 GPU 转写测试：约 **94 秒**完成，收到八次进度通知。这只是一次特定环境实测，**不代表所有客户端都能跨过 300 秒请求上限**，也不保证其他长视频速度相同。

## 排查问题与已知边界

- **验证 B 站上游：**Postman 新建 GET 请求 `https://api.bilibili.com/x/web-interface/view`，Params 填 `bvid=BV1VqsQ6KEoy`；既检查 HTTP 状态，也检查 JSON `code`（成功为 `0`）。`data.pubdate` 是 Unix 秒级时间戳，`data.owner.mid` 是 UID，`data.stat.reply` 是评论／回复**数量**。这是本项目调用的 B 站网页接口，**不是 MCP HTTP 接口，也不能视作承诺长期稳定的开放平台契约**；遇风控不要高频重试。
- **没有字幕：**视频可能本来就没有字幕；安装 ffmpeg 和 Whisper 或配置云端接口，并设置 `VIDEO_MCP_ASR_PROVIDER`，之后 `fetch_assets` 会自动转写（只在不想要时显式传 `wantAsr: false`）。
- **没有关键帧：**故事板可能不可用；回退抽帧要求能下载媒体、能执行 ffmpeg，通常建议安装 yt-dlp。暂不支持登录态、Cookie、大会员或付费视频。
- **缓存未命中：**先调用 `fetch_assets`；`get_cached` 才能读取。旧缓存的互动数据不会自动刷新。
- **长任务中断：**要看客户端自身的请求超时；单独增大 `asrTimeoutSec` 并不能改变客户端超时。Pi 修改 MCP 配置后可能需要 `/reload`。
- **平台范围：**`src/adapters/registry.ts` 注册了 B 站、抖音与微信。抖音依赖浏览器访客 Cookie 与自行计算的签名；未配置 `VIDEO_MCP_DOUYIN_COOKIE_FILE` 时返回 `COOKIE_REQUIRED`。抖音返回 **HTTP 200 但响应体为空**时属于软风控／作品不可见，应刷新 Cookie，不要循环重试。图文作品（`/note/`）不支持。微信短链通常可直接读取；长链在没有有效 `chksm` 时返回 `WEIXIN_CAPTCHA`。已注销/删除/作者隐私设置不可见/违规下架的文章返回 `NOT_FOUND` 并说明原因。微信视频号暂不支持；三个平台的接口、Cookie 与签名机制完全不同，各自单独实现适配器。

扩展平台需在 `src/adapters/` 实现 `PlatformAdapter` 并于 `src/adapters/registry.ts` 注册，变更后运行 `npm test`、`npm run build`。Windows Cursor 详细安装另见 [INSTALL_CN.md](INSTALL_CN.md)。

## 许可证

项目为 MIT（见 `package.json`）；模型及第三方二进制另受各自许可约束。
