import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_DOUYIN_COOKIE_FILE,
  detectReleaseWhisper,
  douyinCookieFile,
  douyinFastAudio,
  getAsrProvider,
  projectRoot,
} from "../src/config.js";

describe("config: 抖音 Cookie 路径", () => {
  it("默认文件位于项目根目录的 .douyin-cookies.txt", () => {
    assert.equal(DEFAULT_DOUYIN_COOKIE_FILE, path.join(projectRoot, ".douyin-cookies.txt"));
    assert.equal(path.basename(projectRoot), "Jianwen");
  });

  it("环境变量优先于默认文件", () => {
    const prev = process.env.VIDEO_MCP_DOUYIN_COOKIE_FILE;
    process.env.VIDEO_MCP_DOUYIN_COOKIE_FILE = "D:/custom/cookies.txt";
    try {
      assert.equal(douyinCookieFile(), "D:/custom/cookies.txt");
    } finally {
      if (prev === undefined) delete process.env.VIDEO_MCP_DOUYIN_COOKIE_FILE;
      else process.env.VIDEO_MCP_DOUYIN_COOKIE_FILE = prev;
    }
  });
});

describe("config: 抖音 fast-audio 开关", () => {
  it("默认开启，显式 0/false/no/off 关闭", () => {
    const prev = process.env.VIDEO_MCP_DOUYIN_FAST_AUDIO;
    try {
      delete process.env.VIDEO_MCP_DOUYIN_FAST_AUDIO;
      assert.equal(douyinFastAudio(), true);
      for (const off of ["0", "false", "FALSE", " no ", "off"]) {
        process.env.VIDEO_MCP_DOUYIN_FAST_AUDIO = off;
        assert.equal(douyinFastAudio(), false, off);
      }
      for (const on of ["1", "true", "", "yes"]) {
        process.env.VIDEO_MCP_DOUYIN_FAST_AUDIO = on;
        assert.equal(douyinFastAudio(), true, on);
      }
    } finally {
      if (prev === undefined) delete process.env.VIDEO_MCP_DOUYIN_FAST_AUDIO;
      else process.env.VIDEO_MCP_DOUYIN_FAST_AUDIO = prev;
    }
  });
});

describe("config: 本地 whisper 自动探测", () => {
  it("从 Release/ 目录识别 whisper-cli 与 ggml 模型，模型优先 turbo", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "whisper-detect-"));
    try {
      await fs.mkdir(path.join(root, "Release", "models"), { recursive: true });
      await fs.mkdir(path.join(root, "Release", "whisper-cuda-test"), { recursive: true });
      await fs.mkdir(path.join(root, "Release", "whisper-cpu-test"), { recursive: true });
      await fs.writeFile(path.join(root, "Release", "whisper-cuda-test", "whisper-cli.exe"), "");
      await fs.writeFile(path.join(root, "Release", "whisper-cpu-test", "whisper-cli.exe"), "");
      await fs.writeFile(path.join(root, "Release", "models", "ggml-small.bin"), "");
      await fs.writeFile(path.join(root, "Release", "models", "ggml-large-v3-turbo.bin"), "");

      const detected = detectReleaseWhisper(root);
      assert.ok(detected.bin?.endsWith("whisper-cli.exe"));
      // 有 NVIDIA 显卡时选 CUDA 版，否则回落 CPU 版；两者都是合法结果
      assert.ok(/whisper-(cuda|cpu)-test/.test(detected.bin!));
      assert.equal(path.basename(detected.model!), "ggml-large-v3-turbo.bin");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("Release/ 缺失时返回空，交给环境变量或 PATH", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "whisper-detect-empty-"));
    try {
      assert.deepEqual(detectReleaseWhisper(root), { bin: undefined, model: undefined });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("显式 VIDEO_MCP_ASR_PROVIDER=none 时不会被自动探测覆盖", () => {
    const prev = process.env.VIDEO_MCP_ASR_PROVIDER;
    process.env.VIDEO_MCP_ASR_PROVIDER = "none";
    try {
      assert.equal(getAsrProvider(), "none");
    } finally {
      if (prev === undefined) delete process.env.VIDEO_MCP_ASR_PROVIDER;
      else process.env.VIDEO_MCP_ASR_PROVIDER = prev;
    }
  });
});
