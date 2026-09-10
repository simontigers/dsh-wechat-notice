# AGENTS.md — dsh-wechat-notice 开发指南

给后续 AI agent / 开发者的项目手册。包含本插件的所有架构事实、踩坑记录、测试方法与发版流程。改动前请先读完本文对应章节。

---

## 1. 项目概览

`dsh-wechat-notice` 是 DSH（DeepSeek Harness）的通知插件，把 agent 运行事件推送到两个渠道：

- **企业微信群机器人**（wecom）：webhook 地址，`POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…`
- **个人微信直连**（weixin）：基于 `weixin-agent-sdk`（扫码登录的 ilink bot），主动推送消息给登录用户

由 `dsh-wecom-notice`（v0.4.3）与 `dsh-weixin-notice`（v0.3.3）合并而来（v0.5.0）。设置页用 tab 区分两通道 + 共享配置。

- GitHub：`git@github.com:simontigers/dsh-wechat-notice.git`（分支 `main`，发版用 tag `vX.Y.Z`）
- 当前版本：见 `package.json`（v0.6.2，2026-09）

## 2. 架构：插件有两半，加载机制完全不同（最重要）

| 半 | 文件 | 跑在哪 | 改动后如何生效 |
|---|---|---|---|
| **宿主半** | `lib/index.js` | DSH 进程内（cordis 插件实例 + require 缓存） | ❌ **必须重启 DSH** |
| **UI 半** | `lib/client.js` | 浏览器 | ✅ **免重启**：宿主的 `dsh-client-hmr` watch 插件 node_modules 里的 bundle 文件，mtime/size 变化 → 重读磁盘 → SSE 推给浏览器 → HMR receiver 热重载模块 |

改 `package.json`（版本/manifest/依赖）或 `cordis.patch.yml` 同样需要重启。

**加载机制**：
- 宿主半：ESM 导出 `name` + `inject` + `apply(ctx)`；`package.json → dsh.bundle.patch: ./cordis.patch.yml`（`- insert: [- id, name]`）把插件插进宿主 composition
- UI 半：`window.__ModuleLoader__.load({ id, factory })` 注册；manifest `dsh.client { platform: "web", inject: [...] }` 声明依赖（`@deepseek-ai/dsh-client-locale`、`-ui-slots`、`-ui-primitives`）。client 代码**不是**静态 `/plugins/<name>/client.js`（404），而是通过 boot wire（`__DSH_BOOT__` / dsh-client-modules 懒加载 CJS 表）到达浏览器
- 设置面板：`ctx.slots.inject("settings.section", registerFn)` → `ctx.slots.register({ name, id, order, label, locale, inject }, Component)`，宿主立即调用 registerFn
- peerDep：`@deepseek-ai/cordis: ^4.0.1`

## 3. 代码地图

```
dsh_wechat_notice/
├── package.json          # 版本、依赖（weixin-agent-sdk ^0.5.0）、dsh.bundle.patch、dsh.client manifest
├── cordis.patch.yml      # composition 注入点
├── lib/index.js          # 宿主半（~1380 行），分区见下
├── lib/client.js         # UI 半（~945 行）：WechatSection 组件 + zh/en locale
├── test/smoke.mjs        # 冒烟：57 项断言，全离线（mock fetch + fake SDK）
├── test/render.mjs       # SSR 渲染回归（需 react，缺失时优雅 skip）
└── README.md
```

### lib/index.js 内部分区

| 区 | 内容 |
|---|---|
| config | `normalizeConfig`（v2 结构：`{version:2, debounceMs, summaryMaxChars, events{turnEnd,turnEndFail,approval,question,agentError}, channels{wecom{enabled,webhook,msgtype,templates×10}, weixin{enabled,templates×10}}}`）；`DEFAULT_CONFIG`；legacy store 迁移（首次运行把 `~/.dsh/{wecom-notice,weixin-notice}` 的旧配置并入新 store，保留 wecom enabled=false 等） |
| token | `readPersistedToken`（`[TOKEN_PATH, LEGACY_TOKEN_PATH]` 回退）；token 捕获（fetch 拦截 getupdates 轮询 → 写新 store） |
| 发送 | `pushText`（SDK bot.sendMessage → 失败含 context_token 时 `sendViaPersistedToken` → 双失败设聊天窗口引导 + `notifyTokenExpiredViaWecom` 兜底，每 episode 一次）；**`sendViaPersistedToken` 必须检查响应体 `ret`/`errcode`（见 §6 假成功）** |
| 模板 | `WECOM_TEMPLATES` / `WEIXIN_TEMPLATES`（各 10 key：turnEnd/turnEndFail/approval/question/error 的 Title+Body）；`renderWecomText`（单 `\n` 换行，1900 字节预算）/ `renderWeixinText`（`\n+`→`\n\n` 规范化，2600 字符预算）；`buildNoticeVars` / `longTextOf` / `templatesFor` / `questionsTextOf` |
| 事件 | `wireEvents`：`session/event`（turn/end → 防抖 scheduleTurnPush；approval/asked）、`agent/error`（seenOnce 去重）、**`user-questions/request` waterfall 旁听（`{ global: true, prepend: true }`，见 §5）** |
| API | `buildApi`：`status, loginStart, loginStatus, loginCancel, logout, get, save, test, checkUpdate`（全 POST，路径前缀 `/wechat-notice/api`，trustedHost 校验） |
| 服务 | `ctx.provide`：`wechatNotice`、`wecomNotice`（wecom 通道别名，禁用时 throw）、`weixinNotice` |

### lib/client.js 内部分区

- locale（zh/en **必须成对新增 key**，render.mjs 会校验）
- `WechatSection`：`activeTab` state（"wecom" | "weixin"）、tab 栏（`tabBarStyle/tabActiveStyle/tabIdleStyle`）、wecom tab（webhook 输入 + msgtype + 模板 + 测试）、weixin tab（LoginCard 2s 轮询 loginStatus + 模板 + 测试）、共享卡（debounce/summaryMax）、事件开关卡、模板字段卡（`renderTemplateFields`）、保存
- **React 用法**：全部 `createElement("div", {style, key}, ..., ...children)`——**绝不能把 React 元素当 component type 传**（v0.5.1 空白页教训），子元素用 spread 展开

## 4. 配置与数据布局（运行时）

- `$DSH_HOME`（默认 `~/.dsh`）下：
  - `wechat-notice/config.json` — v2 store（含 events/channels）
  - `wechat-notice/token.json` — 新 token store（`{context_token, capturedAt, ...}`）
  - legacy 只读回退：`weixin-notice/store.json`、`wecom-notice/store.json`、`weixin-notice/token.json`
- 登录凭证（SDK 管）：`~/.openclaw/openclaw-weixin/accounts/<botId>.json` + `<botId>.sync.json`（轮询游标）
- profile 安装：`~/.dsh/profiles/web/package.json` 的 **deps 和 `dsh.profile.bundles` 都要列插件名**

## 5. 事件触发机制（最容易踩的坑）

| 事件 | 载体 | 监听方式 |
|---|---|---|
| 回合完成/异常 | `session/event`（type `turn/end`） | `hostCtx.on("session/event", (session, event) => …)`，args 兼容元组与 `{session,event}` 信封 |
| 工具审批 | `session/event`（type `approval/asked`，data `{id, toolName, reason}`） | 同上 |
| **用户提问**（ask_user_question、计划批准） | **cordis waterfall**：`ctx.waterfall("user-questions/request", request, noAnswerer)`，**完全不经过 session/event 总线** | `hostCtx.on("user-questions/request", (request, next) => { …推送…; return next(); }, { global: true, prepend: true })` |
| agent 出错 | `agent/error` emit | `hostCtx.on("agent/error", payload => …)`，seenOnce 按 agent+错误内容去重 |

**提问监听的三个铁律**（v0.6.0→v0.6.1 血泪史）：
1. handler **必须调用并返回 `next()`**，否则否决整个提问流程（GUI 收不到问题）
2. **必须 `prepend: true`**：`dsh-api-remotes` 更早注册了同名监听器把请求转发给浏览器答题器，且浏览器接手时 `forwardWaterfall` **直接 resolve、不调 next()**——后注册（链内层）的监听器永远不可达
3. `global: true` 绕过 cordis isolate 过滤（waterfall 可能 scope 到 agent 子上下文，`scopeTarget` 的 carrier filter）

cordis 事实：整个 Context 树共享**同一个 EventsService 实例**（只有 root 在 constructor 创建，子 ctx 原型继承），所以挂 root 能收到任意 ctx 的分发；waterfall 链序 = 注册顺序（先注册者在链首/外层）。

## 6. 渠道发送语义

### 个人微信（weixin）网关

- **假成功陷阱**：`ilinkai.weixin.qq.com` 的 `sendmessage` 业务失败也返回 **HTTP 200 + `content-type: application/octet-stream`**，如 `{"ret":-2,"errmsg":"prepare failed"}`（token 失效）。**任何对网关的请求都必须解析响应体检查 `ret`/`errcode !== 0` 并抛错**，不能只看 `res.ok`
- **context_token 生命周期**：只能从**入站消息**（getupdates 轮询）获得；名义 ~24h，实际与活跃会话强绑定（DSH 重启后旧 token 即失效）。**恢复仪式：用户在手机微信 clawbot 聊天窗口回复任意一条消息** → 轮询捕获（日志 `轮询 #N: msgs=1 from=…` → `推送凭证已持久化`）→ 新 token 写入新 store
- **渲染**：单个 `\n` = 软换行（空格），`\n\n` 才是真换行 → weixin 模板所有视觉行之间必须空行分隔
- 长文本预算：2600 字符（先渲染空长文本算固定开销再截断）

### 企业微信（wecom）webhook

- 检查 `parsed.errcode !== 0`；12s 超时
- 渲染：单个 `\n` 即换行；text content 上限 2048 字节 → `WECOM_TEXT_BYTE_BUDGET = 1900`
- 渠道禁用时不发送；`notifyTokenExpiredViaWecom` 作为 weixin token 失效的兜底提醒（每 episode 一次）

## 7. UI/主题约定

- **深色模式**：`--dsw-alias-brand-primary` 是**反转变量**（浅色=近黑 `neutral-bluish-1000`，深色=近白 `neutral-bluish-50`）。叠在其上的文字必须用 `--dsw-alias-label-primary-foreground`（浅=白/深=黑），**禁止硬编码 `#ffffff`**（v0.6.2 教训）
- 变量族：`--dsw-alias-bg-layer-1/2/3`、`--dsw-alias-border-l2`、`--dsw-alias-label-primary/secondary/tertiary`、`--dsw-alias-state-error-primary` 等（定义在宿主 design css，`body[data-ds-dark-theme]` 切换）
- 二维码容器是白底黑字（扫码需要），保持不变

## 8. 开发工作流

```bash
cd /home/hu.sima/tmp/test_dsh/dsh_wechat_notice

# 1. 语法检查（每次改动后）
node --check lib/index.js && node --check lib/client.js

# 2. 冒烟（必须先删测试 home，legacy 迁移只在 store 缺失时跑一次）
rm -rf /tmp/dsh-wechat-notice-test-home
DSH_HOME=/tmp/dsh-wechat-notice-test-home node test/smoke.mjs   # 期望 57 ok，0 FAIL

# 3. SSR 渲染回归（改 client.js 后必跑）
cd test && ln -sfn /home/hu.sima/tmp/test_dsh/.render-test/node_modules ./node_modules && node render.mjs; rm -f node_modules
# .render-test 缺失时重建：mkdir -p ../../.render-test && cd $_ && npm init -y && npm i react@18 react-dom@18 --cache ./.npmcache

# 4. 本地快速联调（可选，不发版）：profile 用 link: 指向本目录
#    "dsh-wechat-notice": "link:/home/hu.sima/tmp/test_dsh/dsh_wechat_notice"

# 5. 发版（host 半改动或版本号变更时）
sed -i 's/"version": "旧"/"version": "新"/' package.json   # 同步改 README 的安装 tag
git add -A && git commit -m "…" && git tag vX.Y.Z
export GIT_SSH_COMMAND="ssh -F /dev/null -i ~/.ssh/id_ed25519 -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no" \
       http_proxy=http://192.168.1.39:41004 https_proxy=http://192.168.1.39:41004
git push origin main vX.Y.Z

# 6. 升级运行环境（需 danger-full-access，因为 ~/.dsh 在工作区外）
cd ~/.dsh/profiles/web && sed -i 's|dsh-wechat-notice#v旧|dsh-wechat-notice#v新|' package.json \
  && pnpm install --no-frozen-lockfile
# 验证：node -e "console.log(require('/home/<user>/.dsh/profiles/web/node_modules/dsh-wechat-notice/package.json').version)"
```

- **纯 UI 改动**（client.js）：第 1–3 步后即生效（HMR），用户刷新浏览器可见
- **宿主半改动**（index.js / package.json / cordis.patch.yml）：必须发版 + 用户重启 DSH

## 9. 测试要点

### test/smoke.mjs（57 项断言，全离线）

- 环境：`DSH_HOME=/tmp/dsh-wechat-notice-test-home`（每次跑前 `rm -rf`）；fake cordis ctx（`effect/provide/on/webServer.register/webRuntime.trustedHosts/logger`，**fake `on` 尊重 `options.prepend` 语义**并记录 registrations）
- `globalThis.fetch` 拦截：模拟网关轮询（捕获 token）、wecom webhook（记录 `wecomCalls()`）、sendmessage（默认 `{ret:0}`，可注入失败）
- `globalThis.__weixinSdkMock`：假 SDK（login/isLoggedIn/logout/sendMessage）
- 覆盖：legacy 迁移、双通道分发、@all 去重、事件开关、**提问 waterfall（next 透传 + 双通道推送 + prepend 注册 + 开关关闭不推送）**、token 失败链路（假成功检测、legacy 回退、捕获续命、wecom 兜底）、services、API 9 个方法、checkUpdate 三模式
- 注意：`readFile` 等从 `node:fs/promises` 导入（callback 版会 ERR_INVALID_ARG_TYPE）

### test/render.mjs（SSR 回归）

- 通过 `new Function("window","require",src)` 执行 client factory，捕获 `__ModuleLoader__.load`；stub require（react 真、primitives 透传）；`ctx.slots.inject(name, fn){ fn(); }` 捕获组件
- **patch 源码注入初始 state** 渲染三个分支：`var formState = useState(null)` → `useState(<TEST_FORM json>)`；`var tabState = useState("wecom"|"weixin")`
- 会校验 zh/en locale key 完整性——**新增 UI 文案必须两边 locale 同时加**
- react 缺失时优雅 skip（不算失败）

## 10. 已知坑清单（每个都真实踩过）

1. 网关假成功：只查 `res.ok` → 用户看到「已发送」实际没发出（v0.5.2 修复）
2. 提问不走 session/event → 必须旁听 waterfall（v0.6.0）
3. waterfall 链序：GUI 转发器不调 next() → 必须 prepend（v0.6.1）
4. 把 React 元素当组件 type 传（`createElement.apply(null,[element].concat(...))`）→ 设置页整块空白（v0.5.1）
5. 深色模式 brand-primary 反转 → 固定白字不可读（v0.6.2）
6. zh/en locale 不同步 → render.mjs FAIL
7. smoke 的 fake `on` 不尊重 prepend → 测不出链序问题
8. 编辑本仓库文件时注意：JS 模板串里的 `\n` 是**字面反斜杠+n**，用脚本编辑比手工 edit 可靠；Python 脚本写 emoji 用真实字符（`\ud83e` 代理对写法会 UnicodeEncodeError 且**截断目标文件**——写前先读后写完整内容）
9. `node:test` 环境/沙箱：npm 需要 `--cache <工作区目录>`（`~/.npm` 只读）；`/tmp` 在 bash 沙箱里是隔离 tmpfs（write 工具写的 /tmp 文件 bash 看不到）→ 脚本放工作区
10. 插件更新后 stale symlink：pnpm 换版本后检查 `node_modules/` 里旧包残留

## 11. 部署事实（多机）

- 每台电脑的凭证/游标/配置/`~/.openclaw` 都独立（`buildBaseInfo()` 无设备指纹），扫码登录互不干扰、不会互相损坏
- 但**双活同时推送不可靠**：context_token 与活跃会话强绑定 + 并发 getupdates 的消息分发语义未知（广播 vs 竞争消费）→ 推荐**主备模式**：同一时间只开一台的 weixin 通道；换机时旧机关通道 → 新机重新扫码 → 在 clawbot 聊天窗口回复一条消息捕获凭证
- 企业微信 webhook 消息：手机微信有提醒、PC 微信可能是「服务通知」不弹窗（微信设计行为）；想桌面提醒装企业微信 PC 客户端

## 12. 版本历史

| 版本 | 内容 |
|---|---|
| v0.5.0 | wecom + weixin 合并为 dsh-wechat-notice，设置页 tab 化，legacy store 迁移 |
| v0.5.1 | 修复设置页空白（React 元素误作组件 type） |
| v0.5.2 | 持久化凭证自发自发检测网关业务失败（HTTP 200 + ret≠0），消除假成功 |
| v0.6.0 | 新增「用户提问」事件（waterfall 旁听 + `{questions}` 占位符 + 模板 + 开关） |
| v0.6.1 | 提问监听 prepend 到链首（GUI 转发器不调 next() 导致内层不可达） |
| v0.6.2 | 深色模式选中 tab 文字不可读（brand-primary 反转变量配对修复） |
