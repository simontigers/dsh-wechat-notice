// dsh-wechat-notice 冒烟测试：假 cordis ctx + mock weixin-agent-sdk，验证合并插件全链路
// 覆盖：旧版双插件 store 迁移 / 双通道并行推送 / 每通道开关 / 内部 wecom 兜底 /
//       持久化 token 续命（含 legacy token 回退）/ 事件开关 / checkUpdate
process.env.DSH_HOME = "/tmp/dsh-wechat-notice-test-home";
// fake SDK state dir（插件读取账号凭据的路径与 SDK 相同规则）
process.env.OPENCLAW_STATE_DIR = "/tmp/dsh-wechat-notice-test-home/openclaw-state";

import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";

// ---- 预置旧版插件 store（迁移数据源）：wecom 已停用（enabled=false 必须保留！）、weixin 启用
mkdirSync(process.env.DSH_HOME + "/wecom-notice", { recursive: true });
writeFileSync(
  process.env.DSH_HOME + "/wecom-notice/config.json",
  JSON.stringify({
    enabled: false,
    webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=MIGRATED",
    msgtype: "text",
    debounceMs: 777,
    summaryMaxChars: 444,
    events: { turnEnd: true, turnEndFail: true, approval: true, agentError: true },
    templates: { turnEndTitle: "旧版W标题 {workspace}" },
  }),
);
mkdirSync(process.env.DSH_HOME + "/weixin-notice", { recursive: true });
writeFileSync(
  process.env.DSH_HOME + "/weixin-notice/config.json",
  JSON.stringify({
    enabled: true,
    debounceMs: 777,
    summaryMaxChars: 444,
    events: { turnEnd: true, turnEndFail: true, approval: true, agentError: true },
    templates: { turnEndTitle: "旧版W标题 {workspace}" },
  }),
);
// 旧版持久化 token（迁移后新插件应能回退读取）
writeFileSync(
  process.env.DSH_HOME + "/weixin-notice/token.json",
  JSON.stringify({ context_token: "TOK-LEGACY", capturedAt: 1700000000000 }),
);

// ---- 全局 fetch 拦截（先于插件 apply 安装，插件的 token 捕获 wrapper 会包在它外面）
const netCalls = []; // { url, body }
globalThis.fetch = async (url, init) => {
  netCalls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
  if (String(url).includes("/ilink/bot/getupdates")) {
    // 模拟网关长轮询响应：登录用户自发消息携带 context_token
    return new Response(JSON.stringify({ msgs: [{ from_user_id: "self-1", context_token: "TOK-PERSIST" }] }), { status: 200 });
  }
  // 企业微信 webhook 与网关 sendmessage 都回成功
  return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
};

// ---- 预置 fake SDK 账号文件（userId/token/baseUrl）
mkdirSync(process.env.OPENCLAW_STATE_DIR + "/openclaw-weixin/accounts", { recursive: true });
writeFileSync(
  process.env.OPENCLAW_STATE_DIR + "/openclaw-weixin/accounts/acct-1.json",
  JSON.stringify({ token: "bot-token-1", baseUrl: "https://gw.test", userId: "self-1" }),
);

// ---- mock weixin-agent-sdk（宿主 loadSdk 优先取 globalThis.__weixinSdkMock）
const sentMessages = [];
let mockLoggedIn = true;
let mockLoginShouldFailToken = false;
globalThis.__weixinSdkMock = {
  isLoggedIn: () => mockLoggedIn,
  logout: () => { mockLoggedIn = false; },
  start: (agent, opts) => {
    if (!mockLoggedIn) throw new Error("没有已登录的账号，请先运行 login");
    return {
      sendMessage: async (message) => {
        if (mockLoginShouldFailToken) {
          throw new Error("没有找到 context_token，需要在 start() 运行期间至少收到过一条消息");
        }
        const text = typeof message === "string" ? message : String(message?.text ?? "");
        sentMessages.push(text);
        return undefined;
      },
      wait: async () => {},
    };
  },
  login: async () => "mock-account-id",
};

const { apply } = await import("../lib/index.js");

const routes = [];
const listeners = {};
const logs = [];
const effects = [];
const ctx = {
  root: null,
  logger: { info: (m) => logs.push("info: " + m), warn: (m) => logs.push("warn: " + m) },
  webServer: { register: (def) => (routes.push(def), () => {}) },
  webRuntime: { trustedHosts: [] },
  effect: (fn, label) => (effects.push({ fn, label }), fn),
  provide: (n, s) => (ctx[n] = s),
  on: (event, handler) => ((listeners[event] ??= []).push(handler), () => {}),
};

apply(ctx);

// 触发全部 effect（store 生命周期 / API 路由 / 事件监听清理）
for (const e of effects) e.fn();
await new Promise((r) => setTimeout(r, 120));

const assert = (cond, label) => {
  if (!cond) { console.error("FAIL:", label); process.exitCode = 1; }
  else console.log("ok:", label);
};

// ---- 工具：调用 HTTP 路由
import { EventEmitter } from "node:events";
function callApi(method, payload) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = "POST";
    req.url = "/wechat-notice/api/" + method;
    req.headers = { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" };
    const res = { code: 0, body: "", writeHead(c) { res.code = c; }, end(b) { res.body = String(b ?? ""); resolve(JSON.parse(res.body)); } };
    const route = routes[0];
    if (!route) { resolve({ ok: false, error: "no route" }); return; }
    void route.handler(req, res);
    if (payload !== undefined) req.emit("data", Buffer.from(JSON.stringify(payload)));
    req.emit("end");
  });
}

const wecomCalls = () => netCalls.filter((c) => c.url.includes("qyapi.weixin.qq.com"));
const sendCalls = () => netCalls.filter((c) => c.url.includes("ilink/bot/sendmessage"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. 迁移：新 store 由两个旧 store 合并而成，wecom 的 enabled=false 必须保留
const mig = JSON.parse(await readFile(process.env.DSH_HOME + "/wechat-notice/config.json", "utf8"));
assert(mig.channels && mig.channels.wecom.enabled === false, "迁移：wecom enabled=false 保留（不再偷偷发通知）");
assert(mig.channels.wecom.webhook.includes("key=MIGRATED"), "迁移：wecom webhook 保留");
assert(mig.channels.weixin.enabled === true, "迁移：weixin enabled=true 保留");
assert(mig.debounceMs === 777 && mig.summaryMaxChars === 444, "迁移：防抖与摘要长度取旧值");
assert(mig.channels.wecom.templates.turnEndTitle === "旧版W标题 {workspace}", "迁移：wecom 旧模板保留");

// ---- 2. status：已登录 + bot 就绪
const st1 = (await callApi("status", {})).value;
assert(st1.loggedIn === true && st1.botReady === true, "status：已登录且 bot 运行中");
assert(st1.wecom && typeof st1.wecom.lastPushAt === "number", "status 带 wecom 推送状态");

// ---- 3. get 返回 v2 配置
const g = (await callApi("get", {})).value;
assert(g.config && g.config.version === 2 && g.config.channels.weixin.templates.turnEndBody.includes("{workspace}"), "get 返回 v2 双通道配置");

// ---- 4. save v2 草稿（两通道都启用，防抖 200ms）
const draft = {
  debounceMs: 200,
  summaryMaxChars: 500,
  events: { turnEnd: true, turnEndFail: true, approval: true, agentError: true },
  channels: {
    wecom: { enabled: true, webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=FALLBACK", msgtype: "text", templates: {} },
    weixin: { enabled: true, templates: {} },
  },
};
const s = (await callApi("save", { config: draft })).value;
assert(s.config && s.config.debounceMs === 200 && s.config.channels.wecom.webhook.includes("key=FALLBACK"), "save v2 配置成功");

// ---- 5. 会话事件：turn/end → 双通道并行推送（wecom webhook + weixin sdk）
const session = { id: "session-abcdef12-3456", header: { cwd: "/home/hu.sima/tmp/test_dsh" }, snapshotEvents: () => [{ type: "assistant/message", data: { message: { content: [{ type: "text", text: "这是最后的助手输出摘要" }] } } }] };
const ev = { type: "turn/end", seq: 42, data: { reason: { kind: "completed" } } };
const wcBefore5 = wecomCalls().length;
const smBefore5 = sentMessages.length;
for (const h of listeners["session/event"]) h(session, ev);
await sleep(450);
assert(sentMessages.length === smBefore5 + 1, "turn/end 微信推送 1 次（防抖窗口后）");
assert(wecomCalls().length === wcBefore5 + 1, "turn/end 企业微信推送 1 次");
const body1 = sentMessages[smBefore5] ?? "";
assert(body1.includes("✅ 任务完成通知") && body1.includes("🌍 工作区   ·  test_dsh") && body1.includes("🧵 任务ID   ·  abcdef12"), "微信标题渲染 workspace+session");
assert(body1.includes("这是最后的助手输出摘要"), "微信正文渲染 summary");
const wb1 = wecomCalls()[wecomCalls().length - 1].body.text.content;
assert(wb1.includes("✅ 任务完成通知") && wb1.includes("这是最后的助手输出摘要"), "企业微信卡片渲染 summary");
assert(wecomCalls()[wecomCalls().length - 1].url.includes("key=FALLBACK"), "企业微信推送到新配置的 webhook");

// ---- 6. 去重：同 seq 重放不再推送
const wcBefore6 = wecomCalls().length;
for (const h of listeners["session/event"]) h(session, ev);
await sleep(450);
assert(sentMessages.length === smBefore5 + 1 && wecomCalls().length === wcBefore6, "同 seq 去重，双通道都无第二次推送");

// ---- 7. 异常回合 → 失败模板 + {kind}
const evFail = { type: "turn/end", seq: 43, data: { reason: { kind: "interrupted" } } };
for (const h of listeners["session/event"]) h(session, evFail);
await sleep(450);
assert(sentMessages[sentMessages.length - 1].includes("⚠️ 任务异常通知") && sentMessages[sentMessages.length - 1].includes("📌 状态     ·  ⚠️ interrupted"), "异常回合微信模板渲染");
assert(wecomCalls()[wecomCalls().length - 1].body.text.content.includes("⚠️ interrupted"), "异常回合企业微信模板渲染");

// ---- 8. 审批事件
for (const h of listeners["session/event"]) h(session, { type: "approval/asked", seq: 44, data: { toolName: "bash", reason: "运行测试命令" } });
await sleep(80);
assert(sentMessages[sentMessages.length - 1].includes("🔐 审批请求通知") && sentMessages[sentMessages.length - 1].includes("运行测试命令"), "审批微信模板渲染");
assert(wecomCalls()[wecomCalls().length - 1].body.text.content.includes("🛠 工具     ·  bash"), "审批企业微信模板渲染");

// ---- 9. agent/error
for (const h of listeners["agent/error"]) h({ agent: { id: "agent-1", session }, error: new Error("boom-测试") });
await sleep(80);
assert(sentMessages[sentMessages.length - 1].includes("boom-测试"), "agent/error 微信模板渲染");
assert(wecomCalls()[wecomCalls().length - 1].body.text.content.includes("boom-测试"), "agent/error 企业微信模板渲染");

// ---- 10. envelope 信封签名兼容
for (const h of listeners["session/event"]) h({ session, event: { type: "turn/end", seq: 99, data: { reason: { kind: "completed" } } } });
await sleep(450);
assert(sentMessages.length >= 5 && wecomCalls().length >= 5, "envelope 信封签名兼容（双通道）");

// ---- 11. wecom 通道停用 → 只推微信
const offWecom = { ...draft, channels: { ...draft.channels, wecom: { ...draft.channels.wecom, enabled: false } } };
await callApi("save", { config: offWecom });
const wcBefore11 = wecomCalls().length;
const smBefore11 = sentMessages.length;
for (const h of listeners["session/event"]) h(session, { type: "turn/end", seq: 101, data: { reason: { kind: "completed" } } });
await sleep(450);
assert(sentMessages.length === smBefore11 + 1 && wecomCalls().length === wcBefore11, "wecom 停用后仅微信推送");

// ---- 12. weixin 通道停用 → 只推企业微信
const offWeixin = { ...draft, channels: { ...draft.channels, weixin: { ...draft.channels.weixin, enabled: false } } };
await callApi("save", { config: offWeixin });
const wcBefore12 = wecomCalls().length;
const smBefore12 = sentMessages.length;
for (const h of listeners["session/event"]) h(session, { type: "turn/end", seq: 102, data: { reason: { kind: "completed" } } });
await sleep(450);
assert(sentMessages.length === smBefore12 && wecomCalls().length === wcBefore12 + 1, "weixin 停用后仅企业微信推送");
await callApi("save", { config: draft }); // 恢复双通道

// ---- 13. 服务接口：wechatNotice/wecomNotice → 企业微信；weixinNotice → 微信
assert(typeof ctx.wechatNotice?.send === "function" && typeof ctx.wecomNotice?.send === "function" && typeof ctx.weixinNotice?.send === "function", "三个服务名都已提供");
const wcBefore13 = wecomCalls().length;
await ctx.wechatNotice.send({ title: "TW", content: "CW" });
assert(wecomCalls().length === wcBefore13 + 1 && wecomCalls()[wecomCalls().length - 1].body.text.content === "TW\nCW", "wechatNotice 服务直推企业微信");
await ctx.wecomNotice.send({ title: "TW2", content: "CW2" });
assert(wecomCalls().length === wcBefore13 + 2, "wecomNotice 旧名兼容别名可用");
await ctx.weixinNotice.send({ title: "TX", content: "CX" });
assert(sentMessages[sentMessages.length - 1] === "TX\nCX", "weixinNotice 服务直推微信");

// ---- 14. test API：channel 参数分通道测试
const t1 = (await callApi("test", { config: draft, channel: "wecom" })).value;
assert(t1.detail && t1.detail.includes("企业微信群机器人"), "test API wecom 通道");
const t2 = (await callApi("test", { config: draft, channel: "weixin" })).value;
assert(t2.detail && t2.detail.includes("个人微信直连"), "test API weixin 通道");

// ---- 15. token 失效：微信推送失败 → 内部企业微信通道提醒（每周期一次）
//     清掉新旧 token，让自研发送也不可用（webhook 已在 draft 中启用）
await rm(process.env.DSH_HOME + "/wechat-notice/token.json", { force: true });
await rm(process.env.DSH_HOME + "/weixin-notice/token.json", { force: true });
mockLoginShouldFailToken = true;
const t3 = await callApi("test", { channel: "weixin" });
assert(t3.ok === false && t3.error.message.includes("聊天窗口"), "token 缺失给出手机回消息引导");
await sleep(120);
const wcAfter15 = wecomCalls().length;
assert(wcAfter15 >= 1 && wecomCalls()[wcAfter15 - 1].body.text.content.includes("聊天窗口"), "token 失效自动走内部企业微信通道提醒");
// 同一失效周期内第二次失败 → 不重复提醒
await callApi("test", { channel: "weixin" });
await sleep(120);
assert(wecomCalls().length === wcAfter15, "同一失效周期只提醒一次（去重）");

// ---- 16. 持久化凭证自研发送：legacy token 回退（新 token.json 不存在 → 读旧版文件）
const t4 = await callApi("test", { channel: "weixin" });
assert(t4.ok === false, "无 token 时 test 失败（占位：确认 legacy 读取条件）");
// 写回旧版 token（模拟只迁移了旧 token、新 token 尚未捕获）
await writeFile(process.env.DSH_HOME + "/weixin-notice/token.json", JSON.stringify({ context_token: "TOK-LEGACY", capturedAt: 1700000000000 }));
const t5 = await callApi("test", { channel: "weixin" });
assert(t5.ok === true && t5.value.detail.includes("持久化凭证"), "legacy token 回退：重启后用旧版 token 自动续发");
const sc = sendCalls();
assert(sc.length >= 1 && sc[sc.length - 1].body.msg.context_token === "TOK-LEGACY" && sc[sc.length - 1].body.msg.to_user_id === "self-1" && sc[sc.length - 1].body.msg.message_type === 2, "sendmessage 请求形状正确（to=self, type=BOT, legacy token）");

// ---- 17. 捕获：getupdates 响应里登录用户自发消息的 token → 落盘新 store
const wrappedFetch = globalThis.fetch;
await wrappedFetch("https://gw.test/ilink/bot/getupdates", { method: "POST", body: "{}" });
await sleep(120);
const tokenFile = JSON.parse(await readFile(process.env.DSH_HOME + "/wechat-notice/token.json", "utf8"));
assert(tokenFile.context_token === "TOK-PERSIST" && tokenFile.capturedAt > 0, "getupdates 响应中的 token 已持久化到新 store");
const capturedAt1 = tokenFile.capturedAt;
await wrappedFetch("https://gw.test/ilink/bot/getupdates?again=1", { method: "POST", body: "{}" });
await sleep(80);
const tokenFile2 = JSON.parse(await readFile(process.env.DSH_HOME + "/wechat-notice/token.json", "utf8"));
assert(tokenFile2.capturedAt === capturedAt1, "同一 token 去重不重写");

// ---- 18. 推送恢复 → 再失效（删 token 且 SDK 无内存 token）→ 重新提醒
mockLoginShouldFailToken = false;
await callApi("test", { channel: "weixin" });
await sleep(80);
const wcRecovered = wecomCalls().length;
await rm(process.env.DSH_HOME + "/wechat-notice/token.json", { force: true });
await rm(process.env.DSH_HOME + "/weixin-notice/token.json", { force: true });
mockLoginShouldFailToken = true;
await callApi("test", { channel: "weixin" });
await sleep(120);
assert(wecomCalls().length === wcRecovered + 1, "推送恢复后复位，再次失效重新提醒");
mockLoginShouldFailToken = false;

// ---- 19. 退出登录 → status 与 test 报错
mockLoggedIn = false;
const lo = await callApi("logout", {});
assert(lo.ok === true, "logout API 成功");
const st3 = (await callApi("status", {})).value;
assert(st3.loggedIn === false && st3.botReady === false, "未登录 status");
const t6 = await callApi("test", { channel: "weixin" });
assert(t6.ok === false && t6.error.message.includes("扫码登录"), "未登录 test 明确报错");
mockLoggedIn = true;

// ---- 20. 事件开关关闭 → 双通道都不推
const off = (await callApi("save", { config: { ...draft, events: { turnEnd: false, turnEndFail: true, approval: false, agentError: false } } })).value;
assert(off.config.events.turnEnd === false, "save 事件开关");
const wcBefore20 = wecomCalls().length;
const smBefore20 = sentMessages.length;
for (const h of listeners["session/event"]) h(session, { type: "turn/end", seq: 50, data: { reason: { kind: "completed" } } });
for (const h of listeners["session/event"]) h(session, { type: "approval/asked", seq: 51, data: { toolName: "bash", reason: "x" } });
await sleep(450);
assert(sentMessages.length === smBefore20 && wecomCalls().length === wcBefore20, "关闭的事件双通道都不推送");

// ---- 21. 持久化文件：v2 形状
const persisted = JSON.parse(await readFile(process.env.DSH_HOME + "/wechat-notice/config.json", "utf8"));
assert(persisted.debounceMs === 200 && persisted.events.turnEnd === false && persisted.channels.wecom.webhook.includes("key=FALLBACK"), "v2 配置已持久化到 DSH_HOME/wechat-notice");

// ---- 22. 检查更新：无 profile 声明 → unknown 优雅降级
const cu0 = (await callApi("checkUpdate", {})).value;
assert(cu0.mode === "unknown" && typeof cu0.version === "string", "checkUpdate 无 profile 声明时优雅返回 unknown");

// ---- 23. 检查更新：link: 本地安装 → local 模式
mkdirSync(process.env.DSH_HOME + "/profiles/web", { recursive: true });
writeFileSync(
  process.env.DSH_HOME + "/profiles/web/package.json",
  JSON.stringify({ dependencies: { "dsh-wechat-notice": "link:/home/hu.sima/tmp/test_dsh/dsh_wechat_notice" } }),
);
const cu5 = (await callApi("checkUpdate", {})).value;
assert(cu5.mode === "local" && cu5.spec.startsWith("link:") && cu5.diskVersion === cu5.version, "checkUpdate 识别 link 本地安装");

// ---- 24. 检查更新：github 安装 → 走 api.github.com 比较 tags
writeFileSync(
  process.env.DSH_HOME + "/profiles/web/package.json",
  JSON.stringify({ dependencies: { "dsh-wechat-notice": "github:simontigers/dsh-wechat-notice#v0.5.0" } }),
);
const ghBefore = netCalls.filter((c) => c.url.includes("api.github.com")).length;
const cu6 = (await callApi("checkUpdate", {})).value;
const ghAfter = netCalls.filter((c) => c.url.includes("api.github.com")).length;
assert(ghAfter === ghBefore + 1, "checkUpdate github 模式请求了 GitHub API");
assert(cu6.currentTag === "v0.5.0" && (typeof cu6.latest === "string" || cu6.latest === null), "checkUpdate github 模式返回 latest（真实网络或 null 兜底）");

console.log(process.exitCode ? "\n=== 有失败项 ===" : "\n=== 全部通过 ===");
console.log("sent:", sentMessages.length, "| wecomCalls:", wecomCalls().length, "| logs:", logs.length);
