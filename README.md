# dsh-wechat-notice

DeepSeek Harness（DSH）微信通知合一插件：**企业微信群机器人 + 个人微信直连** 双通道，
回合结束 / 审批请求 / Agent 出错时按自定义模板并行推送。由 `dsh-wecom-notice` 与
`dsh-weixin-notice` 合并而来，设置页用 **Tab 切换两个通道** 的配置。

```
┌─ DSH 设置页「微信通知」──────────────────────────┐
│  [企业微信群机器人] [个人微信直连]   ← Tab 切换      │
│                                                  │
│  通道配置（启用 / Webhook·扫码登录 / 模板 / 测试）    │
│  通用配置（防抖 / 摘要长度 / 事件开关 —— 两通道共用）  │
│  [保存]                                          │
└──────────────────────────────────────────────────┘
```

## 通道

| 通道 | 载体 | 换行规则 | 登录 |
| --- | --- | --- | --- |
| 企业微信群机器人 | 群机器人 Webhook（text / markdown） | 单个 `\n` 即换行 | 无需登录 |
| 个人微信直连 | [weixin-agent-sdk](https://www.npmjs.com/package/weixin-agent-sdk)（腾讯微信 Bot 网关） | 单个 `\n` 是软换行，`\n\n` 才换行 | 设置页内扫码 |

两个通道按各自模板独立渲染、并行发送，单通道失败互不影响；每个通道可单独停用。

## 事件

- **回合结束（成功）** / **回合异常结束**：同一会话短时间多次回合结束做防抖（默认 10s，只推最后一条）
- **审批请求**：需要你批准工具调用时
- **用户提问**：agent 向你提问等待回答时推送（`ask_user_question` 与计划批准都走此通道；
  以 cordis waterfall 监听器旁听 `user-questions/request`，透传请求不影响 GUI 答题流程）
- **Agent 出错**：agent 执行链路报错时（按 agent + 错误内容去重）

事件开关为双通道全局；某类事件关闭后两个通道都不推。

## 个人微信直连的推送凭证机制

腾讯网关的主动推送依赖 `context_token`（约 24 小时有效，只随入站消息下发）：

- **捕获**：插件包装 `globalThis.fetch`，从网关 `ilink/bot/getupdates` 长轮询响应里提取
  「登录用户本人」消息携带的 token，落盘 `token.json`
- **续命**：重启后 SDK 内存缓存清空时，用磁盘 token + 账号凭据自研 POST
  `ilink/bot/sendmessage`，24 小时有效期内无缝
- **过期**：两种发送都失败时，自动从**企业微信通道**发提醒（每个失效周期一次）；
  在手机微信里打开收到推送的聊天窗口回复一条消息即可恢复

## 从旧版插件迁移

首次启动时若新 store（`$DSH_HOME/wechat-notice/config.json`）不存在，自动读取：

- `$DSH_HOME/wecom-notice/config.json`（含 `enabled=false` 的停用状态，原样保留）
- `$DSH_HOME/weixin-notice/config.json`
- `$DSH_HOME/weixin-notice/token.json`（作为推送凭证的回退来源）

合并写入新 store；旧文件保留不删，确认新版工作正常后可手动移除旧插件。

## 检查更新

设置页内置「检查更新」：按 profile 依赖声明判断安装来源 ——
`github:` 安装比较 GitHub tags（主机网络不通时浏览器端兜底拉取）、`link:` 本地安装给出重建提示。
磁盘已装新版但进程还是旧代码时，显示「重启 DSH 后生效」横幅。

## 安装

```bash
dsh plugin --profile web add github:simontigers/dsh-wechat-notice#v0.6.0
```

本地开发：

```bash
dsh plugin --profile web add link:/path/to/dsh_wechat_notice
```

改动后需重启 DSH 生效。

## 对其他插件暴露的 cordis 服务

```js
const svc = ctx.get("wechatNotice");   // 或旧名 wecomNotice
await svc.send({ title: "标题", content: "正文" });   // → 企业微信通道

const wx = ctx.get("weixinNotice");
await wx.send({ title: "标题", content: "正文" });    // → 个人微信直连
```

## 开发

```bash
node --check lib/index.js && node --check lib/client.js
node test/smoke.mjs   # 冒烟测试：迁移 / 双通道并行 / 去重防抖 / token 续命 / checkUpdate
```

冒烟测试使用独立的 `DSH_HOME` 与 mock SDK，不触碰真实账号。

## 数据位置

| 文件 | 说明 |
| --- | --- |
| `$DSH_HOME/wechat-notice/config.json` | 双通道合并配置（v2） |
| `$DSH_HOME/wechat-notice/token.json` | 推送凭证（自动捕获 / 续命） |
| `~/.openclaw/openclaw-weixin/accounts/*.json` | SDK 账号凭据（SDK 管理） |

## License

MIT
