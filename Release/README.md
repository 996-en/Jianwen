# Windows 本地语音转写文件说明

**打包文件下载：**[夸克网盘分享](https://pan.quark.cn/s/3f1f83689bec?pwd=CSxJ)，提取码：`CSxJ`。这是 Windows x64 的本地 Whisper 程序及模型包，**不包含本项目的 MCP 源码或 Node.js 依赖**。下载后把下面三个文件夹放入项目的 `Release/` 目录，保持目录名不变；按自己的硬件选择 CPU 或 CUDA 程序，模型两个版本共用。源码仓库的 Git 忽略规则不包含这些二进制和模型，需单独下载。

目录结构：

- `whisper-cpu-windows-x64/`：Windows x64 的 CPU 版 whisper.cpp（原 `backup-cpu`，不是废弃文件）。
- `whisper-cuda13.2-rtx20-50-windows-x64/`：Windows x64 的 NVIDIA CUDA 13.2 GPU 版，编入 SM 75、86、89、120，面向对应架构的 RTX 20／30／40／50 系显卡。
- `models/ggml-large-v3-turbo.bin`：两个版本共用的多语言模型，不必重复复制。

## 让 AI / 使用者选择

1. Windows x64，且 NVIDIA 显卡架构为 **SM 75、86、89 或 120**，驱动兼容 CUDA 13.2 且显存足够：可选 CUDA 版。CUDA 运行库已随程序打包，无须安装 CUDA Toolkit。当前只在 RTX 5060 Ti（SM 120）上完成实测；其余架构尚未实机验证。
2. GTX 10 系、无合适 NVIDIA 显卡或不满足 CUDA 条件的 Windows x64 电脑：选 CPU 版。CPU 版通常无需 NVIDIA 显卡，但依赖系统上的 Microsoft Visual C++ 运行库。
3. macOS、Linux、Windows ARM64：这里的 Windows x64 可执行文件不适用，需获取适配目标系统的 whisper.cpp 版本。仅凭“有 NVIDIA 显卡”不足以判断此 CUDA 包可用。

本 MCP 会自动探测本目录：找到 `whisper-*/whisper-cli.exe` 与 `models/ggml-*.bin` 就默认启用本地转写（有 NVIDIA 显卡时优先 CUDA 版，否则 CPU 版）。只有想指定其他程序/模型时才需要设置环境变量，且环境变量始终优先：

```text
VIDEO_MCP_ASR_PROVIDER=whisper_local
VIDEO_MCP_WHISPER_BIN=<Release 的完整路径>\whisper-cpu-windows-x64\whisper-cli.exe
VIDEO_MCP_WHISPER_MODEL=<Release 的完整路径>\models\ggml-large-v3-turbo.bin
```

如符合 CUDA 版条件，将 `VIDEO_MCP_WHISPER_BIN` 指向 `whisper-cuda13.2-rtx20-50-windows-x64\whisper-cli.exe`。该目录已随程序附带 CUDA 13.2 运行库 `cublas64_13.dll`、`cublasLt64_13.dll`、`cudart64_13.dll`，**无须另外安装 CUDA Toolkit 或设置其 `PATH`**；仍需兼容的 NVIDIA 驱动、Windows x64、足够显存及 Microsoft Visual C++ 运行库。本机已在不包含 CUDA Toolkit 的 `PATH` 下用 RTX 5060 Ti 实测成功，但尚未在无 Toolkit 的干净电脑以及 RTX 20／30／40 系显卡上验证。

随附的 NVIDIA 运行库须遵守本目录的 `NVIDIA-CUDA-13.2-EULA.txt`；whisper.cpp 许可见 `WHISPER-CPP-LICENSE.txt`。CUDA 库体积约 482 MiB，分享时请连同程序 DLL 一起保留。

若要分享**整个 MCP**，除本目录之外还需要项目程序、Node.js 20+、项目依赖和构建产物；用到音频转写时还需 ffmpeg，下载媒体时建议安装 yt-dlp。请确认模型文件的分发许可并注意其体积约 1.6 GB。详情见项目根目录的 `README.md`。
