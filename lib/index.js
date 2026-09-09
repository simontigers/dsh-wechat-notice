/**
 * dsh-wechat-notice — host half
 *
 * 微信通知合一插件（企业微信群机器人 + 个人微信直连）：
 *   - 监听会话事件（回合结束 / 审批请求）与 agent/error 总线事件
 *   - 双通道按各自模板渲染后并行推送：
 *       wecom  — 企业微信群机器人 webhook（text/markdown）
 *       weixin — 个人微信直连（weixin-agent-sdk，腾讯 Bot 网关）
 *   - 配置持久化在 $DSH_HOME/wechat-notice/config.json（首次运行自动从
 *     旧版 dsh-wecom-notice / dsh-weixin-notice 的 store 迁移）
 *   - 对外提供 wechatNotice / wecomNotice / weixinNotice cordis 服务
 *
 * 无第三方运行时依赖（weixin-agent-sdk 除外）：HTTP 使用内置 fetch。
 */
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// ---------------------------------------------------------------- identity

const name = "dsh-wechat-notice";
const NS = "dsh-wechat-notice";
const inject = ["webServer", "webRuntime"];

// ---------------------------------------------------------------- paths

const DATA_ROOT = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, "wechat-notice")
  : join(homedir(), ".dsh", "wechat-notice");
const STORE_PATH = join(DATA_ROOT, "config.json");
// 持久化推送凭证：重启后内存 token 清空，用磁盘上的 token 自研发送续命（约 24h 内有效）
const TOKEN_PATH = join(DATA_ROOT, "token.json");
// 旧版插件 store（首启迁移数据源；迁移后不再读写）
const LEGACY_WEIXIN_STORE = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, "weixin-notice", "config.json")
  : join(homedir(), ".dsh", "weixin-notice", "config.json");
const LEGACY_WECOM_STORE = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, "wecom-notice", "config.json")
  : join(homedir(), ".dsh", "wecom-notice", "config.json");
const LEGACY_TOKEN_PATH = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, "weixin-notice", "token.json")
  : join(homedir(), ".dsh", "weixin-notice", "token.json");

// ---------------------------------------------------------------- update check

const GITHUB_REPO_FALLBACK = "simontigers/dsh-wechat-notice";
const PROFILE_PKG_PATH = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, "profiles", "web", "package.json")
  : join(homedir(), ".dsh", "profiles", "web", "package.json");

/** 运行中版本：模块加载时定格（pnpm 升级后磁盘版本会变，运行版本不变，直到重启）。 */
const RUNNING_VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "");
  } catch {
    return "";
  }
})();

function parseSemver(tag) {
  const m = /v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(tag ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewerVersion(candidate, current) {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (a === null || b === null) return false;
  return a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
}

/** 本插件运行版本/磁盘版本 + profile 依赖声明（安装来源github:/link:/registry）。 */
async function resolveInstallInfo() {
  const info = { mode: "unknown", spec: "", repoSlug: GITHUB_REPO_FALLBACK, currentTag: "", version: RUNNING_VERSION, diskVersion: RUNNING_VERSION };
  try {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    info.diskVersion = String(pkg.version ?? "");
  } catch { /* 忽略 */ }
  try {
    const profilePkg = JSON.parse(await readFile(PROFILE_PKG_PATH, "utf8"));
    const spec = String(profilePkg?.dependencies?.[name] ?? "");
    info.spec = spec;
    const gh = /^github:(?<slug>[^#]+)#(?<tag>.+)$/.exec(spec);
    if (gh) {
      info.mode = "github";
      info.repoSlug = gh.groups.slug;
      info.currentTag = gh.groups.tag;
    } else if (/^(link:|file:)/.test(spec)) {
      info.mode = "local";
    } else if (spec !== "") {
      info.mode = "registry";
    }
  } catch { /* profile package.json 读不到 → mode 保持 unknown */ }
  return info;
}

/** 拉取 GitHub 仓库 tags，返回最高 semver 的 tag 名；网络失败返回 null。 */
async function fetchLatestTag(repoSlug) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`https://api.github.com/repos/${repoSlug}/tags?per_page=100`, {
      headers: { "User-Agent": "dsh-plugin-update-check", Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const tags = await res.json();
    let best = null;
    for (const t of Array.isArray(tags) ? tags : []) {
      if (t?.name && parseSemver(t.name) !== null && (best === null || isNewerVersion(t.name, best))) best = t.name;
    }
    return best;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- config

// 企业微信群卡片：网关按普通文本渲染，单个 \n 即换行
const WECOM_TEMPLATES = {
  turnEndTitle: "║  ✅ 任务完成通知       ║",
  turnEndBody: "🌍 工作区   ·  {workspace}\n🧵 任务ID   ·  {session}\n⏰ 完成时间 ·  {time}\n📌 状态     ·  ✅ 成功\n\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n💬 执行摘要\n{summary}\n\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n🤖 来源     ·  DeepSeek Harness",
  turnEndFailTitle: "║  ⚠️ 任务异常通知       ║",
  turnEndFailBody: "🌍 工作区   ·  {workspace}\n🧵 任务ID   ·  {session}\n⏰ 完成时间 ·  {time}\n📌 状态     ·  ⚠️ {kind}\n\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n💬 执行摘要\n{summary}\n\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n🤖 来源     ·  DeepSeek Harness",
  approvalTitle: "║  🔐 审批请求通知       ║",
  approvalBody: "🌍 工作区   ·  {workspace}\n🧵 任务ID   ·  {session}\n⏰ 请求时间 ·  {time}\n🛠 工具     ·  {tool}\n📝 原因     ·  {reason}\n\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n💬 当前回复\n{summary}\n\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n🤖 来源     ·  DeepSeek Harness",
  questionTitle: "║  ❓ 用户提问通知       ║",
  questionBody: "🌍 工作区   ·  {workspace}\n🧵 任务ID   ·  {session}\n⏰ 提问时间 ·  {time}\n\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n💬 提问内容\n{questions}\n\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n🤖 来源     ·  DeepSeek Harness",
  errorTitle: "║  ❌ Agent 出错通知     ║",
  errorBody: "🌍 工作区   ·  {workspace}\n🧵 任务ID   ·  {session}\n⏰ 时间     ·  {time}\n📌 状态     ·  ❌ 出错\n\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n💥 错误信息\n{error}\n\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n🤖 来源     ·  DeepSeek Harness",
};

// 个人微信 Bot 网关把单个 \n 渲染成软换行（空格），只有 \n\n 才换行 ——
// 所有视觉行之间一律用空行分隔
const WEIXIN_TEMPLATES = {
  turnEndTitle: "║  ✅ 任务完成通知       ║",
  turnEndBody: "🌍 工作区   ·  {workspace}\n\n🧵 任务ID   ·  {session}\n\n⏰ 完成时间 ·  {time}\n\n📌 状态     ·  ✅ 成功\n\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n💬 执行摘要\n\n{summary}\n\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n🤖 来源     ·  DeepSeek Harness",
  turnEndFailTitle: "║  ⚠️ 任务异常通知       ║",
  turnEndFailBody: "🌍 工作区   ·  {workspace}\n\n🧵 任务ID   ·  {session}\n\n⏰ 完成时间 ·  {time}\n\n📌 状态     ·  ⚠️ {kind}\n\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n💬 执行摘要\n\n{summary}\n\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n🤖 来源     ·  DeepSeek Harness",
  approvalTitle: "║  🔐 审批请求通知       ║",
  approvalBody: "🌍 工作区   ·  {workspace}\n\n🧵 任务ID   ·  {session}\n\n⏰ 请求时间 ·  {time}\n\n🛠 工具     ·  {tool}\n\n📝 原因     ·  {reason}\n\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n💬 当前回复\n\n{summary}\n\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n🤖 来源     ·  DeepSeek Harness",
  questionTitle: "║  ❓ 用户提问通知       ║",
  questionBody: "🌍 工作区   ·  {workspace}\n\n🧵 任务ID   ·  {session}\n\n⏰ 提问时间 ·  {time}\n\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n💬 提问内容\n\n{questions}\n\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n🤖 来源     ·  DeepSeek Harness",
  errorTitle: "║  ❌ Agent 出错通知     ║",
  errorBody: "🌍 工作区   ·  {workspace}\n\n🧵 任务ID   ·  {session}\n\n⏰ 时间     ·  {time}\n\n📌 状态     ·  ❌ 出错\n\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n💥 错误信息\n\n{error}\n\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n🤖 来源     ·  DeepSeek Harness",
};

const DEFAULT_CONFIG = {
  version: 2,
  debounceMs: 10000,
  summaryMaxChars: 500,
  events: { turnEnd: true, turnEndFail: true, approval: true, question: true, agentError: true },
  channels: {
    wecom: { enabled: true, webhook: "", msgtype: "text", templates: { ...WECOM_TEMPLATES } },
    weixin: { enabled: true, templates: { ...WEIXIN_TEMPLATES } },
  },
};

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const isObj = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function copyTemplates(target, src) {
  const srcObj = isObj(src) ? src : {};
  for (const key of Object.keys(target)) {
    if (typeof srcObj[key] === "string" && srcObj[key].length > 0) target[key] = srcObj[key];
  }
}

/** 规整成完整、合法的 v2 配置（深拷贝默认值再覆盖）。 */
function normalizeConfig(input) {
  const src = isObj(input) ? input : {};
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.debounceMs = clampInt(src.debounceMs, 0, 300000, DEFAULT_CONFIG.debounceMs);
  cfg.summaryMaxChars = clampInt(src.summaryMaxChars, 20, 1800, DEFAULT_CONFIG.summaryMaxChars);
  const ev = isObj(src.events) ? src.events : {};
  cfg.events.turnEnd = ev.turnEnd !== false;
  cfg.events.turnEndFail = ev.turnEndFail !== false;
  cfg.events.approval = ev.approval !== false;
  cfg.events.question = ev.question !== false;
  cfg.events.agentError = ev.agentError !== false;
  const ch = isObj(src.channels) ? src.channels : {};
  const wc = isObj(ch.wecom) ? ch.wecom : {};
  cfg.channels.wecom.enabled = wc.enabled !== false;
  cfg.channels.wecom.webhook = typeof wc.webhook === "string" ? wc.webhook.trim() : "";
  cfg.channels.wecom.msgtype = wc.msgtype === "markdown" ? "markdown" : "text";
  copyTemplates(cfg.channels.wecom.templates, wc.templates);
  const wx = isObj(ch.weixin) ? ch.weixin : {};
  cfg.channels.weixin.enabled = wx.enabled !== false;
  copyTemplates(cfg.channels.weixin.templates, wx.templates);
  return cfg;
}

// ---------------------------------------------------------------- store

let store = normalizeConfig(null);
let storeDirtyTimer = null;

async function loadStore() {
  try {
    const raw = await readFile(STORE_PATH, "utf8");
    store = normalizeConfig(JSON.parse(raw));
    return;
  } catch {
    /* 新 store 不存在 → 尝试从旧版插件迁移 */
  }
  let wecomCfg = null;
  let weixinCfg = null;
  try {
    wecomCfg = JSON.parse(await readFile(LEGACY_WECOM_STORE, "utf8"));
  } catch {
    /* 旧 wecom store 不存在 */
  }
  try {
    weixinCfg = JSON.parse(await readFile(LEGACY_WEIXIN_STORE, "utf8"));
  } catch {
    /* 旧 weixin store 不存在 */
  }
  if (wecomCfg === null && weixinCfg === null) {
    store = normalizeConfig(null);
    return;
  }
  store = normalizeConfig({
    debounceMs: wecomCfg?.debounceMs ?? weixinCfg?.debounceMs,
    summaryMaxChars: wecomCfg?.summaryMaxChars ?? weixinCfg?.summaryMaxChars,
    events: wecomCfg?.events ?? weixinCfg?.events,
    channels: {
      wecom: wecomCfg
        ? { enabled: wecomCfg.enabled, webhook: wecomCfg.webhook, msgtype: wecomCfg.msgtype, templates: wecomCfg.templates }
        : undefined,
      weixin: weixinCfg
        ? { enabled: weixinCfg.enabled, templates: weixinCfg.templates }
        : undefined,
    },
  });
  await flushStore();
  console.log(`[${NS}] 已从旧版 dsh-wecom-notice / dsh-weixin-notice 配置迁移到 ${STORE_PATH}`);
}

function scheduleSave() {
  if (storeDirtyTimer !== null) return;
  storeDirtyTimer = setTimeout(() => {
    storeDirtyTimer = null;
    void flushStore();
  }, 150);
}

async function flushStore() {
  try {
    await mkdir(DATA_ROOT, { recursive: true });
    const tmp = `${STORE_PATH}.tmp`;
    await writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
    await rename(tmp, STORE_PATH);
  } catch (error) {
    console.error(`[${NS}] store flush failed:`, error);
  }
}

// ---------------------------------------------------------------- util

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function errorText(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function clampChars(text, max) {
  const s = String(text ?? "").trim();
  if (!Number.isFinite(max) || s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

function shortId(session) {
  const id = String(session?.id ?? "");
  if (id === "") return "-";
  return id.replace(/^session-/, "").slice(0, 8) || "-";
}

function workspaceName(session) {
  const cwd = session?.header?.cwd;
  if (typeof cwd !== "string" || cwd === "") return "未知工作区";
  return basename(cwd) || cwd;
}

function lastAssistantText(session) {
  // 真实 Session 对象暴露的是 snapshotEvents()（没有 events 属性）；
  // 兼容测试用的普通 {events} 形状。
  let events;
  if (typeof session?.snapshotEvents === "function") {
    try {
      events = session.snapshotEvents();
    } catch {
      events = undefined;
    }
  } else if (Array.isArray(session?.events)) {
    events = session.events;
  }
  if (!Array.isArray(events)) return "";
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "assistant/message") continue;
    const blocks = event.data?.message?.content;
    if (!Array.isArray(blocks)) continue;
    const text = blocks
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n\n")
      .trim();
    if (text.length > 0) return text;
  }
  return "";
}

function nowTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function nowDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function renderTemplate(template, vars) {
  return String(template ?? "").replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match);
}

// ---------------------------------------------------------------- dedup

const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEDUP_MAX = 3000;
const seen = new Map();

function seenOnce(key) {
  const now = Date.now();
  for (const [k, ts] of seen) {
    if (now - ts > DEDUP_WINDOW_MS) seen.delete(k);
  }
  if (seen.has(key)) return true;
  seen.set(key, now);
  if (seen.size > DEDUP_MAX) {
    const first = seen.keys().next().value;
    seen.delete(first);
  }
  return false;
}

function hashOf(text) {
  return createHash("sha1").update(String(text)).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------- sdk access

/**
 * SDK 模块解析：优先进程内 mock（测试注入），否则动态 import。
 * 插件本体位于 profile node_modules 内，bare import 可直接解析。
 */
let sdkPromise = null;
function loadSdk() {
  if (globalThis.__weixinSdkMock) return Promise.resolve(globalThis.__weixinSdkMock);
  if (sdkPromise === null) {
    sdkPromise = import("weixin-agent-sdk");
  }
  return sdkPromise;
}

/** 登录子进程脚本：拦截 console.log 抓取二维码 ASCII，stdout 输出 JSON-lines。 */
const LOGIN_CHILD_SCRIPT = `
const send = (obj) => { try { process.stdout.write(JSON.stringify(obj) + "\\n"); } catch {} };
// SDK 的 login() 把整块二维码用一次 console.log(qr) 打出 —— 多行且含 ▀▄█ 块字符，
// 借此与普通日志行区分；其余日志行原样转发。
console.log = (...args) => {
  const text = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
  if (text.includes("\\n") && /[\\u2580\\u2584\\u2588]/.test(text)) {
    send({ type: "qr", qr: text });
  } else {
    send({ type: "log", msg: text });
  }
};
process.stderr.write = () => true;
try {
  const sdk = await import("weixin-agent-sdk");
  const accountId = await sdk.login();
  send({ type: "ok", accountId });
} catch (error) {
  send({ type: "error", message: String(error?.message ?? error) });
  process.exit(1);
}
`;

// ---------------------------------------------------------------- login manager

const loginState = {
  phase: "idle", // idle | starting | qr | waiting | ok | error
  qr: "",
  message: "",
  accountId: "",
  startedAt: 0,
  child: null,
};

function setLoginState(patch) {
  Object.assign(loginState, patch);
}

function spawnLoginChild() {
  const require2 = createRequire(import.meta.url);
  // SDK 的 exports 未暴露 ./package.json，改解析主入口 dist/index.mjs 反推包根；
  // 再回退一层 node_modules 得到「bare import 可解析」的 cwd
  //（本地 link 布局 → 插件根；pnpm 虚拟store布局 → .pnpm/<pkg>@<ver>/）
  const entryPath = require2.resolve("weixin-agent-sdk");
  const packageRoot = entryPath.replace(/[/\\]dist[/\\][^/\\]+\.mjs$/, "");
  const profileRoot = packageRoot.replace(/[/\\]node_modules[/\\][^/\\]+$/, "");
  const child = spawn(process.execPath, ["--input-type=module", "-e", LOGIN_CHILD_SCRIPT], {
    cwd: profileRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  setLoginState({ child, phase: "starting", startedAt: Date.now(), message: "正在启动微信扫码登录…" });

  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line === "") continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "qr") {
        setLoginState({ phase: "qr", qr: event.qr, message: "请用手机微信扫码并确认" });
      } else if (event.type === "log") {
        const msg = String(event.msg ?? "");
        if (msg.includes("等待扫码")) setLoginState({ phase: "waiting" });
        if (msg.includes("连接成功")) setLoginState({ phase: "ok", message: "登录成功" });
      } else if (event.type === "ok") {
        setLoginState({ phase: "ok", accountId: String(event.accountId ?? ""), message: "登录成功", qr: "" });
        try {
          child.kill();
        } catch {
          /* already exiting */
        }
        void ensureBot();
      } else if (event.type === "error") {
        setLoginState({ phase: "error", message: String(event.message ?? "登录失败"), qr: "" });
      }
    }
  });
  child.stderr.on("data", () => {
    /* 子进程 stderr 已在脚本内静默，这里兜底丢弃 */
  });
  child.on("exit", () => {
    if (loginState.child === child) {
      setLoginState({ child: null });
      if (loginState.phase !== "ok" && loginState.phase !== "error") {
        setLoginState({ phase: "error", message: "登录进程意外退出", qr: "" });
      }
    }
  });
  return child;
}

// ---------------------------------------------------------------- bot lifecycle

const botState = {
  bot: null,
  controller: null,
  starting: null,
  accountMasked: "",
  // token 失效提醒去重：每个失效周期只从企业微信通道提醒一次，推送恢复后复位
  tokenFallbackSent: false,
};

/** 双通道推送状态（设置页展示）。 */
const pushState = {
  wecom: { lastPushAt: 0, lastPushError: "" },
  weixin: { lastPushAt: 0, lastPushError: "" },
};

// ---------------------------------------------------------------- token persistence

/**
 * 推送凭证（context_token）的持久化与续命：
 *  - 捕获：包装 globalThis.fetch，从网关 ilink/bot/getupdates 长轮询响应里
 *    提取「登录用户本人」发出的消息所带的 context_token，落盘 token.json
 *    （token 只随入站消息下发，协议无主动索取端点 —— 这是网关风控设计）
 *  - 续命：重启后 SDK 内存缓存清空，bot.sendMessage 客户端直接拒绝；此时用
 *    磁盘 token + 账号凭据自研 POST ilink/bot/sendmessage，24h 有效期内无缝
 *  - 真过期（>24h）：两种发送都失败 → 走企业微信通道兜底提醒
 */

/** 解析 SDK 的账号凭据（镜像 SDK 的 state dir 解析：OPENCLAW_STATE_DIR || ~/.openclaw）。 */
function resolveWeixinAccountData() {
  const stateDir = (process.env.OPENCLAW_STATE_DIR ?? "").trim() !== ""
    ? process.env.OPENCLAW_STATE_DIR.trim()
    : join(homedir(), ".openclaw");
  const accountsDir = join(stateDir, "openclaw-weixin", "accounts");
  return readdir(accountsDir)
    .then((files) => {
      const jsonFile = files.find((f) => f.endsWith(".json"));
      if (jsonFile === undefined) return null;
      return readFile(join(accountsDir, jsonFile), "utf8").then((raw) => {
        try {
          const data = JSON.parse(raw);
          if (typeof data?.userId !== "string" || data.userId === "") return null;
          return {
            userId: data.userId,
            token: typeof data?.token === "string" ? data.token : "",
            baseUrl: typeof data?.baseUrl === "string" && data.baseUrl !== "" ? data.baseUrl : "https://ilinkai.weixin.qq.com",
          };
        } catch {
          return null;
        }
      });
    })
    .catch(() => null);
}

async function persistToken(contextToken) {
  try {
    let previous = "";
    try {
      previous = String(JSON.parse(await readFile(TOKEN_PATH, "utf8"))?.context_token ?? "");
    } catch {
      /* first capture */
    }
    if (previous === contextToken) return;
    await mkdir(DATA_ROOT, { recursive: true });
    const tmp = `${TOKEN_PATH}.tmp`;
    await writeFile(tmp, JSON.stringify({ context_token: contextToken, capturedAt: Date.now() }), "utf8");
    await rename(tmp, TOKEN_PATH);
    console.log(`[${NS}] 推送凭证已持久化（自动续命就绪）`);
  } catch (error) {
    console.warn(`[${NS}] 推送凭证持久化失败: ${errorText(error)}`);
  }
}

async function readPersistedToken() {
  for (const path of [TOKEN_PATH, LEGACY_TOKEN_PATH]) {
    try {
      const data = JSON.parse(await readFile(path, "utf8"));
      if (typeof data?.context_token === "string" && data.context_token !== "") return data;
    } catch {
      /* try next */
    }
  }
  return null;
}

let fetchOriginal = undefined;

/** 包装 globalThis.fetch 抓取 getupdates 响应中的自发消息 token；返回恢复函数。 */
function wrapFetchForTokenCapture() {
  if (fetchOriginal !== undefined || typeof globalThis.fetch !== "function") return () => {};
  const original = globalThis.fetch;
  fetchOriginal = original;
  let pollCount = 0;
  let lastPollLogAt = 0;
  console.log(`[${NS}][capture] fetch 拦截已安装（等待网关轮询）`);
  globalThis.fetch = async function patchedFetch(url, init) {
    const res = await original.call(this, url, init);
    try {
      if (String(url).includes("/ilink/bot/getupdates") && res.ok) {
        pollCount += 1;
        void res.clone().json().then(async (data) => {
          const msgs = Array.isArray(data?.msgs) ? data.msgs : [];
          const now = Date.now();
          if (now - lastPollLogAt > 30000 || msgs.length > 0) {
            lastPollLogAt = now;
            console.log(`[${NS}][capture] 轮询 #${pollCount}: msgs=${msgs.length}${msgs.length > 0 ? " from=" + msgs.map((m) => String(m?.from_user_id ?? "?")).join(",") : ""}`);
          }
          if (msgs.length === 0) return;
          const account = await resolveWeixinAccountData();
          if (account === null) {
            console.warn(`[${NS}][capture] 未找到账号凭据文件，无法匹配自发消息`);
            return;
          }
          for (const msg of msgs) {
            if (msg?.from_user_id === account.userId && typeof msg?.context_token === "string" && msg.context_token !== "") {
              await persistToken(msg.context_token);
              break;
            }
          }
        }).catch(() => {});
      }
    } catch {
      /* 任何异常都不能影响 SDK 的请求 */
    }
    return res;
  };
  return () => {
    if (globalThis.fetch === patchedFetch) {
      globalThis.fetch = original;
    }
    fetchOriginal = undefined;
  };
}

/** 用磁盘上的持久化 token 自研 POST sendmessage（绕过 SDK 内存缓存）。 */
async function sendViaPersistedToken(text) {
  const [account, persisted] = await Promise.all([resolveWeixinAccountData(), readPersistedToken()]);
  if (account === null || account.token === "" || persisted === null) return false;
  const clientId = `openclaw-weixin-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const body = JSON.stringify({
    base_info: { channel_version: "0.5.0" },
    msg: {
      from_user_id: "",
      to_user_id: account.userId,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text } }],
      context_token: persisted.context_token,
    },
  });
  const base = account.baseUrl.endsWith("/") ? account.baseUrl : `${account.baseUrl}/`;
  const res = await fetch(new URL("ilink/bot/sendmessage", base), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": Buffer.from(randomBytes(4).readUInt32BE(0).toString(), "utf-8").toString("base64"),
      Authorization: `Bearer ${account.token}`,
    },
    body,
  });
  if (!res.ok) throw new Error(`sendmessage ${res.status}: ${(await res.text()).slice(0, 200)}`);
  // 网关业务失败也返回 HTTP 200（content-type: application/octet-stream），如
  // {"ret":-2,"errmsg":"prepare failed"}（token 失效）—— 必须检查响应体，否则假成功
  const respText = await res.text().catch(() => "");
  let respBody = null;
  try {
    respBody = respText === "" ? null : JSON.parse(respText);
  } catch {
    respBody = null;
  }
  const ret = typeof respBody?.ret === "number" ? respBody.ret : (typeof respBody?.errcode === "number" ? respBody.errcode : 0);
  if (ret !== 0) {
    throw new Error(`sendmessage 网关拒绝 ret=${ret}: ${String(respBody?.errmsg ?? respText.slice(0, 120) ?? "unknown")}（推送凭证已被网关失效，请在收到推送的微信聊天窗口回复一条消息刷新）`);
  }
  return true;
}

/** POST 到企业微信群机器人 webhook（text/markdown）。 */
async function postWecomText(ch, title, content) {
  if (typeof ch?.webhook !== "string" || !/^https:\/\//.test(ch.webhook)) {
    throw new Error("Webhook 未配置或不是 https URL");
  }
  const full = `${title}\n${content}`;
  const body = ch.msgtype === "markdown"
    ? { msgtype: "markdown", markdown: { content: full } }
    : { msgtype: "text", text: { content: full } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let res;
  try {
    res = await fetch(ch.webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  let parsed = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed.errcode === "number" && parsed.errcode !== 0) {
    throw new Error(`企业微信错误 errcode=${parsed.errcode}: ${parsed.errmsg ?? "unknown"}`);
  }
  return "已发送";
}

/** 微信推送凭证失效时，从企业微信通道提醒用户恢复（每个失效周期最多一次）。 */
function notifyTokenExpiredViaWecom(cfg) {
  if (botState.tokenFallbackSent) return;
  const ch = cfg?.channels?.wecom;
  if (!ch || ch.enabled === false) return; // 用户明确停用了企业微信 → 不打扰
  botState.tokenFallbackSent = true;
  postWecomText(ch, "📲 微信通知通道提醒", "微信推送凭证（context_token）已过期，微信通知暂时发不出去。请在手机微信里打开收到推送通知的那个聊天窗口，随便回复一条消息，下一条通知会自动恢复微信直连。").then(
    () => console.log(`[${NS}] token 失效提醒已经企业微信通道发送`),
    (error) => console.warn(`[${NS}] token 失效提醒企业微信发送失败: ${errorText(error)}`),
  );
}

async function ensureBot() {
  if (botState.bot !== null) return botState.bot;
  if (botState.starting !== null) return botState.starting;
  botState.starting = (async () => {
    try {
      const sdk = await loadSdk();
      if (!sdk.isLoggedIn()) {
        return null;
      }
      const controller = new AbortController();
      const noopAgent = {
        async chat() {
          return {};
        },
      };
      const bot = sdk.start(noopAgent, {
        abortSignal: controller.signal,
        log: (msg) => console.log(`[${NS}][sdk] ${msg}`),
      });
      botState.bot = bot;
      botState.controller = controller;
      console.log(`[${NS}] weixin bot 已启动`);
      return bot;
    } catch (error) {
      console.warn(`[${NS}] weixin bot 启动失败: ${errorText(error)}`);
      botState.lastPushError = `bot 启动失败: ${errorText(error)}`;
      return null;
    } finally {
      botState.starting = null;
    }
  })();
  return botState.starting;
}

function stopBot() {
  try {
    botState.controller?.abort();
  } catch {
    /* already stopped */
  }
  botState.bot = null;
  botState.controller = null;
}

// ---------------------------------------------------------------- weixin push

async function pushText(title, body, cfg) {
  const bot = await ensureBot();
  if (bot === null) {
    const message = "微信未登录，请到设置页完成扫码登录";
    botState.lastPushError = message;
    throw new Error(message);
  }
  try {
    await bot.sendMessage(`${title}\n${body}`);
    botState.lastPushAt = Date.now();
    botState.lastPushError = "";
    botState.tokenFallbackSent = false;
    return "已发送";
  } catch (error) {
    const message = errorText(error);
    const tokenMissing = message.includes("context_token");
    if (tokenMissing) {
      // 第一优先：磁盘上的持久化 token 自研发送（覆盖重启清空内存缓存的场景）
      try {
        const sent = await sendViaPersistedToken(`${title}\n${body}`);
        if (sent) {
          botState.lastPushAt = Date.now();
          botState.lastPushError = "";
          botState.tokenFallbackSent = false;
          return "已发送（持久化凭证）";
        }
      } catch (persistError) {
        console.warn(`[${NS}] 持久化凭证发送失败: ${errorText(persistError)}`);
      }
    }
    botState.lastPushError = tokenMissing
      ? "微信推送凭证已失效（超过 24 小时）：请在手机微信里打开收到推送通知的那个聊天窗口，随便回复一条消息即可恢复"
      : message;
    if (tokenMissing && cfg) {
      // 微信通道彻底推不出去 → 从企业微信通道提醒用户恢复凭证（每周期一次）
      notifyTokenExpiredViaWecom(cfg);
    }
    throw new Error(botState.lastPushError);
  }
}

// ---------------------------------------------------------------- push intents

/**
 * 事件 → 通知变量（双通道共用）。kind: turnEnd | turnEndFail | approval | question | agentError
 */
function buildNoticeVars(kind, session, event, payload) {
  const targetSession = kind === "agentError" ? payload?.agent?.session : (kind === "question" ? payload?.request?.agent?.session : session);
  const vars = {
    workspace: workspaceName(targetSession),
    session: shortId(targetSession),
    sessionId: String(targetSession?.id ?? "-"),
    kind: "completed",
    summary: "",
    error: "",
    tool: "tool",
    reason: "",
    questions: "",
    time: nowTime(),
    date: nowDate(),
  };
  if (kind === "turnEnd" || kind === "turnEndFail") {
    const reason = isPlainObject(event?.data?.reason) ? event.data.reason : {};
    if (typeof reason.kind === "string" && reason.kind !== "") vars.kind = reason.kind;
    if (typeof reason.error?.message === "string") vars.error = reason.error.message;
  } else if (kind === "approval") {
    const data = isPlainObject(event?.data) ? event.data : {};
    const r = data.reason;
    if (typeof data.toolName === "string" && data.toolName !== "") vars.tool = data.toolName;
    vars.reason = typeof r === "string"
      ? r
      : (typeof r?.message === "string" ? r.message : (typeof r?.kind === "string" ? r.kind : ""));
  } else if (kind === "question") {
    vars.questions = questionsTextOf(payload?.request);
  } else if (kind === "agentError") {
    const error = payload?.error;
    vars.error = error instanceof Error
      ? error.message
      : (typeof error === "string" ? error : (error?.message ?? "agent 执行出错"));
  }
  return vars;
}

/** 把 user-questions 请求渲染成多行提问文本（含选项）。 */
function questionsTextOf(request) {
  const questions = Array.isArray(request?.questions) ? request.questions : [];
  const rendered = questions.map((q, index) => {
    const text = typeof q?.question === "string" ? q.question.trim() : "";
    if (text === "") return null;
    const options = Array.isArray(q?.options) ? q.options.map((o) => String(o?.label ?? "")).filter((s) => s !== "") : [];
    const prefix = questions.length > 1 ? `问题 ${index + 1}` : "提问";
    return `${prefix}：${text}${options.length > 0 ? `\n可选：${options.join(" / ")}` : ""}`;
  }).filter((s) => s !== null);
  if (rendered.length === 0) return "（agent 发起了一个用户提问，但内容为空）";
  return rendered.join("\n\n");
}

/** 长文本占位（{summary}/{error}/{questions}）的取值来源。 */
function longTextOf(kind, session, payload) {
  if (kind === "agentError") {
    const error = payload?.error;
    return error instanceof Error
      ? error.message
      : (typeof error === "string" ? error : (error?.message ?? "agent 执行出错"));
  }
  if (kind === "question") {
    return questionsTextOf(payload?.request);
  }
  return lastAssistantText(session);
}

function templatesFor(kind, tpl) {
  if (kind === "turnEnd") return [tpl.turnEndTitle, tpl.turnEndBody, "summary"];
  if (kind === "turnEndFail") return [tpl.turnEndFailTitle, tpl.turnEndFailBody, "summary"];
  if (kind === "approval") return [tpl.approvalTitle, tpl.approvalBody, "summary"];
  if (kind === "question") return [tpl.questionTitle, tpl.questionBody, "questions"];
  return [tpl.errorTitle, tpl.errorBody, "error"];
}

/**
 * 企业微信 text content 上限 2048 字节；卡片制表符都是 3 字节字符，先渲染
 * 「长文本留空」的模板算出固定开销，再把长文本按剩余字节预算截断。
 */
const WECOM_TEXT_BYTE_BUDGET = 1900;

function renderWecomText(cfg, template, title, vars, longKey, longText) {
  const overheadTemplate = renderTemplate(template, { ...vars, [longKey]: "" });
  const overheadBytes = Buffer.byteLength(overheadTemplate) + Buffer.byteLength(String(title)) + 1;
  const roomChars = Math.floor((WECOM_TEXT_BYTE_BUDGET - overheadBytes) / 3);
  vars[longKey] = clampChars(longText, Math.max(50, Math.min(cfg.summaryMaxChars, roomChars)));
  return renderTemplate(template, vars);
}

/**
 * 个人微信按字节数算预算更宽松（约 2600），但网关把单个 \n 压成空格
 * （软换行）—— 长文本内部同样规范化为 \n\n。
 */
function renderWeixinText(cfg, template, title, vars, longKey, longText) {
  const overheadTemplate = renderTemplate(template, { ...vars, [longKey]: "" });
  const overheadBytes = Buffer.byteLength(overheadTemplate) + Buffer.byteLength(String(title)) + 1;
  const roomChars = Math.floor((2600 - overheadBytes) / 3);
  vars[longKey] = clampChars(longText, Math.max(50, Math.min(cfg.summaryMaxChars, roomChars))).replace(/\n+/g, "\n\n");
  return renderTemplate(template, vars);
}

async function sendWecomEvent(cfg, kind, session, event, payload, log) {
  const ch = cfg.channels.wecom;
  if (ch.enabled === false) return;
  const vars = buildNoticeVars(kind, session, event, payload);
  const [titleT, bodyT, longKey] = templatesFor(kind, ch.templates);
  const title = renderTemplate(titleT, vars);
  const body = renderWecomText(cfg, bodyT, title, vars, longKey, longTextOf(kind, session, payload));
  try {
    await postWecomText(ch, title, body);
    pushState.wecom.lastPushAt = Date.now();
    pushState.wecom.lastPushError = "";
  } catch (error) {
    pushState.wecom.lastPushError = errorText(error);
    log(`企业微信推送失败（${kind}）: ${errorText(error)}`);
  }
}

async function sendWeixinEvent(cfg, kind, session, event, payload, log) {
  const ch = cfg.channels.weixin;
  if (ch.enabled === false) return;
  const vars = buildNoticeVars(kind, session, event, payload);
  const [titleT, bodyT, longKey] = templatesFor(kind, ch.templates);
  const title = renderTemplate(titleT, vars);
  const body = renderWeixinText(cfg, bodyT, title, vars, longKey, longTextOf(kind, session, payload));
  try {
    await pushText(title, body, cfg);
  } catch (error) {
    log(`微信推送失败（${kind}）: ${errorText(error)}`);
  }
}

/** 双通道并行推送；单通道失败互不影响。 */
function dispatchNotice(cfg, kind, session, event, payload, log) {
  return Promise.allSettled([
    sendWecomEvent(cfg, kind, session, event, payload, log),
    sendWeixinEvent(cfg, kind, session, event, payload, log),
  ]);
}

// ---------------------------------------------------------------- event wiring

/** 兼容 (session, event) 元组与 {session, event} 信封两种宿主签名。 */
function normalizeSessionEventArgs(args) {
  if (!Array.isArray(args)) return undefined;
  const [first, second] = args;
  const isRecord = (v) => v !== null && typeof v === "object";
  if (args.length === 2 && isRecord(first) && isRecord(second) && typeof second.type === "string") {
    return { session: first, event: second };
  }
  if (args.length === 1 && isRecord(first) && isRecord(first.session) && isRecord(first.event) && typeof first.event.type === "string") {
    return { session: first.session, event: first.event };
  }
  return undefined;
}

function selectHostEventContext(ctx) {
  const root = ctx?.root;
  if (root !== null && typeof root === "object" && root !== ctx && root?.root === root && typeof root.on === "function") {
    return root;
  }
  return ctx;
}

function wireEvents(ctx, cfgRef, disposers) {
  const hostCtx = selectHostEventContext(ctx);
  const log = (message) => {
    try {
      ctx.logger?.warn?.(`[${NS}] ${message}`);
    } catch {
      console.warn(`[${NS}] ${message}`);
    }
  };

  const pendingTurnPush = new Map();

  const scheduleTurnPush = (session, event) => {
    const reason = isPlainObject(event?.data?.reason) ? event.data.reason : {};
    const kind = typeof reason.kind === "string" && reason.kind !== "" ? reason.kind : "unknown";
    const completed = kind === "completed";
    if (completed ? !cfgRef.config.events.turnEnd : !cfgRef.config.events.turnEndFail) return;
    const sid = String(session?.id ?? "anon");
    const prev = pendingTurnPush.get(sid);
    if (prev !== undefined) clearTimeout(prev);
    const timer = setTimeout(() => {
      pendingTurnPush.delete(sid);
      void dispatchNotice(cfgRef.config, completed ? "turnEnd" : "turnEndFail", session, event, null, log);
    }, Math.max(0, cfgRef.config.debounceMs));
    pendingTurnPush.set(sid, timer);
  };

  disposers.push(hostCtx.on("session/event", (...args) => {
    try {
      const parsed = normalizeSessionEventArgs(args);
      if (parsed === undefined) return;
      const { session, event } = parsed;
      if (event?.seq !== undefined && event?.seq !== null) {
        if (seenOnce(`${event.type}:${session?.id ?? "anon"}:${event.seq}`)) return;
      }
      if (event.type === "turn/end") {
        scheduleTurnPush(session, event);
      } else if (event.type === "approval/asked") {
        if (cfgRef.config.events.approval) void dispatchNotice(cfgRef.config, "approval", session, event, null, log);
      }
    } catch (error) {
      log(`处理 session/event 失败: ${errorText(error)}`);
    }
  }));

  disposers.push(hostCtx.on("agent/error", (payload = {}) => {
    try {
      if (!cfgRef.config.events.agentError) return;
      const agentSession = payload?.agent?.session;
      const agentId = String(payload?.agent?.id ?? agentSession?.id ?? "anon");
      const error = payload?.error;
      const detail = error instanceof Error ? error.message : (typeof error === "string" ? error : (error?.message ?? ""));
      if (seenOnce(`agent/error:${agentId}:${hashOf(detail)}`)) return;
      void dispatchNotice(cfgRef.config, "agentError", null, null, payload, log);
    } catch (error) {
      log(`处理 agent/error 失败: ${errorText(error)}`);
    }
  }));

  // 「用户提问」不走 session/event 总线，而是 cordis waterfall：
  // ctx.waterfall("user-questions/request", request, noAnswerer)。以监听器身份旁听，
  // 必须调用并返回 next() 把请求继续传下去，否则提问流程被否决。
  // prepend: true —— 必须插到链首：dsh-api-remotes 的 GUI 转发监听器更早注册且在
  // 浏览器接手答题时直接 resolve、不调用 next()，后注册（内层）的旁听永远不可达。
  // global: true —— 绕过 cordis isolate 过滤（请求可能 scope 到 agent 子上下文）。
  disposers.push(hostCtx.on("user-questions/request", (request, next) => {
    try {
      if (cfgRef.config.events.question) {
        void dispatchNotice(cfgRef.config, "question", null, null, { request }, log);
      }
    } catch (error) {
      log(`处理 user-questions/request 失败: ${errorText(error)}`);
    }
    return typeof next === "function" ? next() : undefined;
  }, { global: true, prepend: true }));

  disposers.push(() => {
    for (const timer of pendingTurnPush.values()) clearTimeout(timer);
    pendingTurnPush.clear();
  });
}

// ---------------------------------------------------------------- HTTP fence

function headerOf(request, headerName) {
  try {
    const value = request?.headers?.[headerName];
    if (Array.isArray(value)) return value[0];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseAuthority(value) {
  try {
    const url = new URL(`http://${value}`);
    if (url.hostname === "") return undefined;
    return { hostname: url.hostname, port: url.port, host: url.host };
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname) {
  const parts = String(hostname).split(".");
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") return true;
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isTrustedApiRequest(request, trustedHosts) {
  const host = headerOf(request, "host");
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  const hosts = Array.isArray(trustedHosts) ? trustedHosts : [];
  const trusted = hosts.some((entry) => {
    const entryUrl = parseAuthority(String(entry));
    if (entryUrl === undefined) return false;
    return entryUrl.hostname === hostUrl.hostname && (entryUrl.port === "" || entryUrl.port === hostUrl.port);
  });
  if (!isLoopbackHostname(hostUrl.hostname) && !trusted) return false;
  if (headerOf(request, "sec-fetch-site") === "cross-site") return false;
  const origin = headerOf(request, "origin");
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function writeJson(res, status, value) {
  try {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  } catch {
    /* response already gone */
  }
}

function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value });
}

function writeError(res, error) {
  const message = error instanceof Error ? error.message : String(error);
  writeJson(res, 200, { ok: false, error: { code: "wechat-notice", message } });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 512 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------- API

function maskAccountId(accountId) {
  const s = String(accountId ?? "");
  if (s.length <= 8) return s === "" ? "" : `${s.slice(0, 2)}***`;
  return `${s.slice(0, 6)}***${s.slice(-4)}`;
}

function buildApi(cfgRef, log) {
  const sampleVars = () => ({
    workspace: "示例工作区",
    session: "a1b2c3d4",
    sessionId: "session-a1b2c3d4-0000-0000",
    kind: "completed",
    summary: "这是一条测试摘要：个人微信直连通道占位符渲染正常。",
    error: "示例错误：连接超时（测试占位符）",
    tool: "bash",
    reason: "示例原因：运行测试命令",
    time: nowTime(),
    date: nowDate(),
  });

  return {
    async status() {
      const sdk = await loadSdk().catch(() => null);
      let loggedIn = false;
      if (sdk !== null) {
        try {
          loggedIn = sdk.isLoggedIn() === true;
        } catch {
          loggedIn = false;
        }
      }
      const botReady = botState.bot !== null;
      const persisted = await readPersistedToken();
      return {
        loggedIn,
        botReady,
        account: loggedIn ? (loginState.accountId ? maskAccountId(loginState.accountId) : "已登录") : "",
        login: {
          phase: loginState.phase,
          message: loginState.message,
          qr: loginState.phase === "qr" || loginState.phase === "waiting" ? loginState.qr : "",
        },
        lastPushAt: pushState.weixin.lastPushAt,
        lastPushError: pushState.weixin.lastPushError,
        tokenCapturedAt: persisted === null ? 0 : (typeof persisted.capturedAt === "number" ? persisted.capturedAt : 0),
        wecom: { lastPushAt: pushState.wecom.lastPushAt, lastPushError: pushState.wecom.lastPushError },
      };
    },

    async loginStart() {
      const sdk = await loadSdk();
      if (sdk.isLoggedIn()) {
        return { message: "已有已登录账号，无需重复扫码。如需换号请先退出登录。" };
      }
      if (loginState.child !== null) {
        return { message: "登录流程进行中，请扫当前二维码" };
      }
      setLoginState({ phase: "starting", qr: "", message: "正在启动微信扫码登录…", accountId: "" });
      spawnLoginChild();
      return { message: "已启动扫码登录，二维码即将显示" };
    },

    async loginStatus() {
      return {
        phase: loginState.phase,
        message: loginState.message,
        qr: loginState.phase === "qr" || loginState.phase === "waiting" ? loginState.qr : "",
        accountId: loginState.accountId ? maskAccountId(loginState.accountId) : "",
      };
    },

    async loginCancel() {
      if (loginState.child !== null) {
        try {
          loginState.child.kill();
        } catch {
          /* already gone */
        }
      }
      setLoginState({ phase: "idle", qr: "", message: "", child: null });
      return { message: "已取消" };
    },

    async logout() {
      stopBot();
      const sdk = await loadSdk();
      sdk.logout();
      setLoginState({ phase: "idle", qr: "", message: "", accountId: "" });
      log("已退出微信登录");
      return { message: "已退出登录" };
    },

    async get() {
      return { config: normalizeConfig(cfgRef.config) };
    },

    async save(payload) {
      const next = normalizeConfig(payload?.config);
      cfgRef.config = next;
      store = next;
      scheduleSave();
      log(`配置已保存（wecom=${next.channels.wecom.enabled ? "开" : "关"}, weixin=${next.channels.weixin.enabled ? "开" : "关"}, debounce=${next.debounceMs}ms）`);
      return { config: normalizeConfig(cfgRef.config) };
    },

    /** 测试发送：channel=wecom | weixin，优先用表单草稿（未保存也能测）。 */
    async test(payload) {
      const cfg = payload?.config !== undefined ? normalizeConfig(payload.config) : normalizeConfig(cfgRef.config);
      const channel = payload?.channel === "wecom" ? "wecom" : "weixin";
      const vars = sampleVars();
      if (channel === "wecom") {
        const ch = cfg.channels.wecom;
        const [titleT, bodyT, longKey] = templatesFor("turnEnd", ch.templates);
        const title = renderTemplate(titleT, vars);
        const body = renderWecomText(cfg, bodyT, title, vars, longKey, "这是一条测试摘要");
        const detail = await postWecomText(ch, title, body);
        return { detail: `${detail}（企业微信群机器人）` };
      }
      const ch = cfg.channels.weixin;
      const [titleT, bodyT, longKey] = templatesFor("turnEnd", ch.templates);
      const title = renderTemplate(titleT, vars);
      const body = renderWeixinText(cfg, bodyT, title, vars, longKey, "这是一条测试摘要");
      const detail = await pushText(title, body, cfg);
      return { detail: `${detail}（个人微信直连）` };
    },

    /** 检查更新：读 profile 依赖声明判断安装来源；github 安装时比较 GitHub tags。 */
    async checkUpdate() {
      const info = await resolveInstallInfo();
      if (info.mode === "github") {
        const latest = await fetchLatestTag(info.repoSlug);
        if (latest !== null) {
          const pendingRestart = info.diskVersion !== "" && info.version !== "" && info.diskVersion !== info.version;
          return {
            mode: "github", repoSlug: info.repoSlug, currentTag: info.currentTag,
            version: info.version, diskVersion: info.diskVersion, pendingRestart,
            latest, upToDate: !isNewerVersion(latest, info.currentTag),
          };
        }
        // 主机侧网络不通 → 返回 repoSlug/currentTag，让浏览器端兜底拉取
        return { mode: "github", repoSlug: info.repoSlug, currentTag: info.currentTag, version: info.version, diskVersion: info.diskVersion, latest: null };
      }
      return { mode: info.mode, spec: info.spec, version: info.version, diskVersion: info.diskVersion };
    },
  };
}

// ---------------------------------------------------------------- plugin

export const apply = (ctx) => {
  const cfgRef = { config: store };
  const disposers = [];
  const log = (message) => {
    try {
      ctx.logger?.info?.(`[${NS}] ${message}`);
    } catch {
      console.log(`[${NS}] ${message}`);
    }
  };

  ctx.effect(() => {
    const restoreFetch = wrapFetchForTokenCapture(); // 必须先于 ensureBot 安装，才能抓到首轮 getupdates
    void loadStore().then(() => {
      cfgRef.config = store;
      void ensureBot();
    });
    return () => {
      stopBot();
      restoreFetch();
      void flushStore();
    };
  }, "dsh-wechat-notice: store + bot lifecycle");

  const api = buildApi(cfgRef, log);

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/wechat-notice/api",
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, ctx.webRuntime?.trustedHosts ?? [])) {
        writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
        return;
      }
      if (req.method !== "POST") {
        writeJson(res, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } });
        return;
      }
      const pathname = new URL(req.url ?? "/", "http://wechat-notice.invalid").pathname;
      const tail = pathname.startsWith("/wechat-notice/api/") ? pathname.slice("/wechat-notice/api/".length) : undefined;
      if (tail === undefined || tail.includes("/") || tail === "") {
        writeError(res, new Error("unknown wechat-notice API method"));
        return;
      }
      try {
        const payload = await readJsonBody(req);
        const handler = api[tail];
        if (typeof handler !== "function") throw new Error(`unknown wechat-notice API method "${tail}"`);
        writeOk(res, await handler(payload));
      } catch (error) {
        writeError(res, error);
      }
    },
  }), "dsh-wechat-notice: /wechat-notice/api routes");

  wireEvents(ctx, cfgRef, disposers);
  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch {
        /* already gone */
      }
    }
    disposers.length = 0;
  }, "dsh-wechat-notice: event listeners");

  // 供其他插件调用：ctx.get('wechatNotice')?.send({ title, content }) → 企业微信通道
  // （wecomNotice 为旧名兼容别名；weixinNotice 走个人微信直连）
  const wecomService = {
    async send({ title, content }) {
      const ch = cfgRef.config.channels.wecom;
      if (ch.enabled === false) throw new Error("企业微信通知通道已停用（enabled=false）");
      return postWecomText(ch, String(title ?? ""), String(content ?? ""));
    },
  };
  ctx.provide("wechatNotice", wecomService);
  ctx.provide("wecomNotice", wecomService);
  ctx.provide("weixinNotice", {
    async send({ title, content }) {
      return pushText(String(title ?? ""), String(content ?? ""), cfgRef.config);
    },
  });

  log("started");
};

export { inject, name };
