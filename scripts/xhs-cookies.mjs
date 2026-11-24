#!/usr/bin/env node
// 从本机浏览器导出小红书 Cookie，供见闻在网页解析失败时做本地 feed 签名请求。
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MARKER = "XHS_COOKIE_JSON:";

function usage() {
  console.log(`用法: node scripts/xhs-cookies.mjs [--out <路径>] [--help]
  默认写入 <项目根>/.xhs-cookies.txt；公开 xhslink 短链不配置也能用。`);
}

function parseArgs(argv) {
  const options = { out: resolve(repoRoot, ".xhs-cookies.txt") };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { usage(); process.exit(0); }
    else if (arg === "--out") {
      const value = argv[i + 1];
      if (!value) throw new Error("--out 需要一个路径");
      options.out = resolve(value);
      i += 1;
    } else throw new Error(`未知参数: ${arg}`);
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

const PYTHON_PROGRAM = `
import json, os, time
ensure_real_tab()
cookies = cdp("Network.getAllCookies").get("cookies", [])
picked = [c for c in cookies if "xiaohongshu" in (c.get("domain") or "")]
now = int(time.time())
lines = ["# Netscape HTTP Cookie File", "# jianwen xhs-cookies", ""]
for c in picked:
    dom = c.get("domain") or ""
    expiry = int(c.get("expires") or 0) or now + 86400
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
print("${MARKER}" + json.dumps({"path": out, "picked": len(picked), "hasA1": "a1" in names}))
`;

function harnessFailureHint(stderr, stdout) {
  const logPath = resolve(homedir(), ".config/browser-harness/tmp/bu-default.log");
  const blob = `${stderr}\n${stdout}`;
  let log = "";
  if (existsSync(logPath)) {
    try {
      log = readFileSync(logPath, "utf8");
    } catch {
      /* ignore */
    }
  }
  if (
    blob.includes("daemon") ||
    blob.includes("chrome-not-running") ||
    log.includes("chrome-not-running")
  ) {
    return [
      "",
      "常见原因：本机没有正在运行、或未开启远程调试的 Chrome/Edge。",
      "请按顺序操作：",
      "  1. 启动 Chrome 或 Edge，并保持窗口开着",
      "  2. 地址栏打开 chrome://inspect/#remote-debugging，勾选「允许本浏览器实例的远程调试」",
      "  3. 访问并登录 https://www.xiaohongshu.com",
      "  4. 再执行: npm run xhs:cookies",
      "诊断: browser-harness --doctor",
    ].join("\n");
  }
  return "";
}

function runHarness(bin, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(bin, [], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (e) => rejectPromise(new Error(`无法启动 ${bin}: ${e.message}`)));
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(PYTHON_PROGRAM, "utf8");
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const bin = findBrowserHarness();
  console.log(`使用 browser-harness: ${bin}`);
  const result = await runHarness(bin, { ...process.env, JIANWEN_COOKIE_OUT: options.out });
  const line = result.stdout.split(/\r?\n/).reverse().find((e) => e.startsWith(MARKER));
  if (!line) {
    const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-8).join("\n");
    const hint = harnessFailureHint(result.stderr, result.stdout);
    throw new Error(`导出失败（退出码 ${result.code}）${detail ? `:\n${detail}` : ""}${hint}`);
  }
  const report = JSON.parse(line.slice(MARKER.length));
  if (!report.hasA1) throw new Error(`没有 a1，请先在浏览器登录小红书再重试。`);
  console.log(`已写入 ${report.path}（${report.picked} 条）`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });