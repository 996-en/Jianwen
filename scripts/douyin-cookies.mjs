#!/usr/bin/env node
// 从本机正在运行的浏览器导出抖音 Cookie，写成 Netscape cookies.txt 供见闻读取。
//
// 为什么需要：抖音网页详情接口要求浏览器签发的访客身份（UIFID、ttwid 等）与实际 UA，
// 这些 Cookie 必须由同一个浏览器会话成套签发，不能拼接或伪造。Cookie 会过期，
// 过期后重跑本脚本即可刷新。
//
// 依赖 browser-harness（通过 CDP 读已打开浏览器的 Cookie），属于本机开发便利工具，
// 不参与 MCP 运行时的任何逻辑，也不会被打进 dist。
//
// 用法：
//   node scripts/douyin-cookies.mjs                 # 写入 <项目根>/.douyin-cookies.txt
//   node scripts/douyin-cookies.mjs --out D:/x/cookies.txt
//   node scripts/douyin-cookies.mjs --guest-only    # 剔除登录态，只保留访客身份
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MARKER = "DOUYIN_COOKIE_JSON:";

function usage() {
  console.log(`用法: node scripts/douyin-cookies.mjs [--out <路径>] [--guest-only]

  --out <路径>   输出文件，默认 <项目根>/.douyin-cookies.txt
  --guest-only   剔除 sessionid 等登录态 Cookie，只保留访客身份（稳定性略低）
  --help         显示本帮助

环境变量：
  BROWSER_HARNESS_BIN  browser-harness 可执行文件路径（默认自动探测）

前置条件：Chrome 中至少有一个标签页能正常打开抖音网页版。`);
}

function parseArgs(argv) {
  const options = { out: resolve(repoRoot, ".douyin-cookies.txt"), guestOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg === "--guest-only") {
      options.guestOnly = true;
    } else if (arg === "--out") {
      const value = argv[i + 1];
      if (!value) throw new Error("--out 需要一个路径");
      options.out = resolve(value);
      i += 1;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return options;
}

function findBrowserHarness() {
  const candidates = [
    process.env.BROWSER_HARNESS_BIN,
    resolve(homedir(), ".local/bin/browser-harness.exe"),
    resolve(homedir(), ".local/bin/browser-harness"),
    "browser-harness",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "browser-harness") return candidate;
    if (existsSync(candidate)) return candidate;
  }
  return "browser-harness";
}

// 传给 browser-harness 的 Python 片段：跑在它预置好 helper 的执行环境里。
// 注意：这段代码只能含 ASCII 字符 —— browser-harness 在 Windows 上按本地代码页读 stdin，
// 中文会变成孤立代理字符并抛 UnicodeEncodeError。
const PYTHON_PROGRAM = `
import json, os, time

ensure_real_tab()
cookies = cdp("Network.getAllCookies").get("cookies", [])

domains = ("douyin", "bytedance", "amemv", "snssdk", "ixigua")
guest_only = os.environ.get("JIANWEN_COOKIE_GUEST_ONLY") == "1"
login_names = {
    "sessionid", "sessionid_ss", "sid_guard", "sid_tt", "uid_tt", "uid_tt_ss",
    "passport_csrf_token", "passport_csrf_token_default", "login_time",
    "n_mh", "sso_uid_tt", "sso_uid_tt_ss", "sid_ucp_v1", "ssid_ucp_v1",
}

picked = [c for c in cookies if any(d in (c.get("domain") or "") for d in domains)]
if guest_only:
    picked = [c for c in picked if c.get("name") not in login_names]

now = int(time.time())
lines = ["# Netscape HTTP Cookie File", "# exported by jianwen scripts/douyin-cookies.mjs", ""]
expired = 0
for c in picked:
    dom = c.get("domain") or ""
    expiry = int(c.get("expires") or 0)
    if expiry <= 0:
        expiry = now + 86400
    if expiry < now:
        expired += 1
    lines.append("\\t".join([
        ("#HttpOnly_" if c.get("httpOnly") else "") + dom,
        "TRUE" if dom.startswith(".") else "FALSE",
        c.get("path") or "/",
        "TRUE" if c.get("secure") else "FALSE",
        str(expiry),
        c.get("name"),
        c.get("value") or "",
    ]))

out = os.environ["JIANWEN_COOKIE_OUT"]
with open(out, "w", encoding="utf-8", newline="\\n") as f:
    f.write("\\n".join(lines) + "\\n")

names = {c.get("name") for c in picked}
print("${MARKER}" + json.dumps({
    "path": out,
    "total": len(cookies),
    "picked": len(picked),
    "expired": expired,
    "hasUifid": bool({"UIFID", "UIFID_TEMP"} & names),
    "hasTtwid": "ttwid" in names,
    "hasLogin": bool(login_names & names),
    "guestOnly": guest_only,
}))
`;

function runHarness(bin, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(bin, [], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      rejectPromise(new Error(`无法启动 ${bin}: ${error.message}`));
    });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(PYTHON_PROGRAM, "utf8");
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const bin = findBrowserHarness();
  console.log(`使用 browser-harness: ${bin}`);
  console.log("正在从当前浏览器读取抖音 Cookie…");

  const result = await runHarness(bin, {
    ...process.env,
    JIANWEN_COOKIE_OUT: options.out,
    JIANWEN_COOKIE_GUEST_ONLY: options.guestOnly ? "1" : "0",
  });

  const line = result.stdout
    .split(/\r?\n/)
    .reverse()
    .find((entry) => entry.startsWith(MARKER));

  if (!line) {
    const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-8).join("\n");
    throw new Error(`导出失败（退出码 ${result.code}）${detail ? `:\n${detail}` : ""}`);
  }

  const report = JSON.parse(line.slice(MARKER.length));
  if (!report.hasUifid) {
    throw new Error(
      `导出结果里没有 UIFID（共 ${report.picked} 条）。请先在浏览器打开任意抖音视频页面确认能正常播放，再重跑本脚本。`,
    );
  }

  const size = statSync(report.path).size;
  console.log("");
  console.log(`已写入: ${report.path}（${report.picked} 条 Cookie，${size} 字节）`);
  console.log(`- 访客身份: UIFID ${report.hasUifid ? "✓" : "✗"} / ttwid ${report.hasTtwid ? "✓" : "✗"}`);
  console.log(`- 登录态: ${report.hasLogin ? "包含" : "不包含"}${report.guestOnly ? "（--guest-only 已剔除）" : ""}`);
  if (report.expired > 0) console.log(`- 注意: ${report.expired} 条 Cookie 已过期`);
  console.log("");
  console.log("下一步：在 MCP 配置里设置");
  console.log(`  "env": { "VIDEO_MCP_DOUYIN_COOKIE_FILE": "${report.path.replace(/\\/g, "/")}" }`);
  console.log("已配置过则重启客户端或执行 /reload 让新 Cookie 生效。");
}

main().catch((error) => {
  console.error(`错误: ${error.message}`);
  process.exit(1);
});
