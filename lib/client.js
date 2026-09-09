/**
 * dsh-wechat-notice — client half (web settings page)
 *
 * 在 DSH 设置页注册「微信通知」区块，双通道用 Tab 切换：
 *   - Tab 企业微信群机器人：启用 / Webhook / 消息类型 / 模板编辑 / 测试发送
 *   - Tab 个人微信直连：扫码登录（设置页内二维码）/ 推送状态 / 模板编辑 / 测试发送
 *   - 通用配置：防抖 / 摘要长度 / 事件开关（两通道共用，一次保存）
 *   - 检查更新（支持 github 安装比较 tags / pendingRestart 提示重启生效）
 *
 * 客户端通过同源 fetch 调用宿主 /wechat-notice/api/*。
 * 挂载方式与 dsh-wecom-notice 一致：slots.inject('settings.section', ...)。
 */
window.__ModuleLoader__.load({
  id: "dsh-wechat-notice",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    var createElement = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useCallback = React.useCallback;
    var useRef = React.useRef;

    var Button = primitives.Button;

    var NS = "dsh-wechat-notice";

    // ---------------------------------------------------------------- locale

    var zh = {
      nav: "微信通知",
      intro: "双通道微信通知合一：企业微信群机器人（Webhook）+ 个人微信直连（扫码登录）。回合结束、审批请求、Agent 出错按各通道模板并行推送，支持 {workspace} / {session} / {summary} 等占位符。",
      tabWecom: "企业微信群机器人",
      tabWeixin: "个人微信直连",
      shared: "通用配置",
      wecomIntro: "通过企业微信群机器人 Webhook 推送：在企业微信群里添加机器人后，把 Webhook 地址粘贴到下面即可，无需登录。",
      webhook: "机器人 Webhook",
      webhookHint: "企业微信群 → 添加机器人 → 复制 Webhook 地址（https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…）",
      msgtype: "消息类型",
      msgtypeText: "text（纯文本）",
      msgtypeMarkdown: "markdown（Markdown 卡片）",
      wecomTestHint: "用当前表单值直接向该 Webhook 发送测试消息，不需要先保存",
      weixinIntro: "扫码登录个人微信后，通知直接发到机器人对话里；推送依赖 context_token（约 24 小时有效），失效时在收到推送的聊天窗口回复一条消息即可恢复。",
      // 登录卡
      login: "微信登录",
      loggedInAs: "已登录",
      account: "账号",
      botReady: "推送通道",
      botReadyOk: "运行中",
      botReadyNo: "未运行（重启 DSH 后自动恢复）",
      loginBtn: "扫码登录",
      loggingIn: "登录中…",
      logoutBtn: "退出登录",
      logoutConfirm: "确定退出微信登录？退出后推送停止，需要重新扫码。",
      qrTitle: "请用手机微信扫码并确认登录",
      qrHint: "二维码约 8 分钟内有效；登录凭据保存在本机（~/.openclaw/），重启免扫码。",
      cancelLogin: "取消",
      loginFailed: "登录失败",
      // 推送状态
      pushStatus: "推送状态",
      lastPush: "最近推送",
      pushToken: "推送凭证",
      hoursAgo: "小时前更新",
      tokenNone: "尚未捕获（在收到推送的微信聊天里回复一条消息后自动捕获）",
      neverPushed: "尚未推送过",
      tokenHint: "微信主动推送依赖 context_token（约 24 小时有效）：在手机微信里打开收到推送通知的那个聊天窗口，随便回复一条消息即可刷新，然后重试。",
      // 基础配置
      basic: "基础配置",
      enabled: "启用推送",
      enabledHint: "关闭后停止所有推送，配置保留",
      debounce: "回合结束防抖（毫秒）",
      debounceHint: "同一会话短时间多次回合结束只推最后一条，0 为不防抖",
      summaryMax: "摘要最大长度（字符）",
      summaryMaxHint: "占位符 {summary} 与最终正文都会截断到该长度",
      events: "事件开关",
      evTurn: "回合结束（成功）",
      evTurnHint: "agent 正常完成一个回合时推送",
      evTurnFail: "回合异常结束",
      evTurnFailHint: "被打断 / 出错 / 达到上限 / 被阻止时推送",
      evApproval: "审批请求",
      evApprovalHint: "需要你批准某个工具调用时推送",
      evError: "Agent 出错",
      evErrorHint: "agent 执行链路报错时推送",
      templates: "消息模板",
      tplTurnTitle: "回合完成 · 标题",
      tplTurnBody: "回合完成 · 正文",
      tplTurnFailTitle: "回合异常 · 标题",
      tplTurnFailBody: "回合异常 · 正文",
      tplApprovalTitle: "审批请求 · 标题",
      tplApprovalBody: "审批请求 · 正文",
      tplErrorTitle: "Agent 出错 · 标题",
      tplErrorBody: "Agent 出错 · 正文",
      placeholders: "可用占位符",
      phHint: "{workspace} 工作区名 · {session} 会话短 ID · {summary} 最后助手输出摘要 · {tool} 工具名 · {reason} 审批原因 · {error} 错误信息 · {kind} 结束类型 · {time} 时间 · {date} 日期",
      save: "保存",
      saving: "保存中…",
      test: "测试发送",
      testing: "发送中…",
      weixinTestHint: "用当前表单值直接测试个人微信通道，不需要先保存；需已登录且推送凭证有效",
      loadErr: "配置加载失败，请重试",
      retry: "重试",
      savedOk: "已保存 ✓",
      testOk: "测试消息已发送 ✓ ",
      dirty: "有未保存的修改",
      needLogin: "请先扫码登录微信",
      updCheck: "检查更新",
      updChecking: "检查更新中…",
      updLatest: "已是最新版本",
      updNew: "发现新版本 {latest}（当前 {version}），更新命令：",
      updCopy: "复制命令",
      updCopied: "已复制 ✓",
      updPending: "新版本 {disk} 已安装，重启 DSH 后生效（当前运行 {version}）",
      updLocal: "本地开发安装（{spec}）：更新请重新构建本地目录后重启 DSH",
      updUnknown: "无法识别安装来源（{spec}），请手动检查更新",
      updErr: "检查更新失败（网络原因），可到 github.com/{repo} 手动查看最新版本",
    };

    var en = {
      nav: "WeChat Notice",
      intro: "Unified two-channel WeChat notifier: WeCom group robot (webhook) + personal WeChat direct (QR login). Turn end / approval / agent errors are pushed in parallel with per-channel templates and {workspace} / {session} / {summary} placeholders.",
      tabWecom: "WeCom group robot",
      tabWeixin: "Personal WeChat direct",
      shared: "Common settings",
      wecomIntro: "Pushes through a WeCom group robot webhook: add a robot to your WeCom group, then paste the webhook URL below. No login required.",
      webhook: "Robot webhook",
      webhookHint: "WeCom group → add robot → copy the webhook URL (https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…)",
      msgtype: "Message type",
      msgtypeText: "text (plain text)",
      msgtypeMarkdown: "markdown (Markdown card)",
      wecomTestHint: "Sends a test message to the webhook with current form values; no need to save first",
      weixinIntro: "After QR login, notifications are delivered to your bot conversation; proactive push relies on context_token (~24h validity) — reply once in the receiving chat to refresh it.",
      login: "WeChat login",
      loggedInAs: "Logged in",
      account: "Account",
      botReady: "Push channel",
      botReadyOk: "Running",
      botReadyNo: "Not running (auto-resumes after DSH restart)",
      loginBtn: "Scan QR to log in",
      loggingIn: "Logging in…",
      logoutBtn: "Log out",
      logoutConfirm: "Log out of WeChat? Pushing stops until you scan again.",
      qrTitle: "Scan the QR code with WeChat on your phone",
      qrHint: "QR valid for ~8 minutes; credentials stay on this machine (~/.openclaw/), no re-scan after restart.",
      cancelLogin: "Cancel",
      loginFailed: "Login failed",
      pushStatus: "Push status",
      lastPush: "Last push",
      pushToken: "Push token",
      hoursAgo: "h ago",
      tokenNone: "not captured yet (reply once in the WeChat chat that receives the pushes)",
      neverPushed: "Never pushed",
      tokenHint: "Proactive push needs a context_token (~24h validity): open the WeChat chat where you receive the push notifications and reply with any message to refresh, then retry.",
      basic: "Basics",
      enabled: "Enable push",
      enabledHint: "Master switch; config is kept when disabled",
      debounce: "Turn-end debounce (ms)",
      debounceHint: "Merge rapid turn-ends per session; 0 disables",
      summaryMax: "Summary max length (chars)",
      summaryMaxHint: "Clamps {summary} and the final body",
      events: "Events",
      evTurn: "Turn end (success)",
      evTurnHint: "Push when the agent completes a turn",
      evTurnFail: "Turn ended abnormally",
      evTurnFailHint: "Interrupted / errored / max tokens / blocked",
      evApproval: "Approval request",
      evApprovalHint: "Push when a tool call needs your approval",
      evError: "Agent error",
      evErrorHint: "Push when the agent pipeline errors",
      templates: "Templates",
      tplTurnTitle: "Turn end · title",
      tplTurnBody: "Turn end · body",
      tplTurnFailTitle: "Turn abnormal · title",
      tplTurnFailBody: "Turn abnormal · body",
      tplApprovalTitle: "Approval · title",
      tplApprovalBody: "Approval · body",
      tplErrorTitle: "Agent error · title",
      tplErrorBody: "Agent error · body",
      placeholders: "Placeholders",
      phHint: "{workspace} workspace · {session} short session id · {summary} last assistant excerpt · {tool} tool name · {reason} approval reason · {error} error message · {kind} end kind · {time} time · {date} date",
      save: "Save",
      saving: "Saving…",
      test: "Send test",
      testing: "Sending…",
      weixinTestHint: "Tests the personal-WeChat channel with current form values; requires login and a valid push token",
      loadErr: "Failed to load config, please retry",
      retry: "Retry",
      savedOk: "Saved ✓",
      testOk: "Test message sent ✓ ",
      dirty: "Unsaved changes",
      needLogin: "Please scan the QR code to log in first",
      updCheck: "Check updates",
      updChecking: "Checking…",
      updLatest: "Up to date",
      updNew: "New version {latest} available (current {version}). Update command:",
      updCopy: "Copy command",
      updCopied: "Copied ✓",
      updPending: "Version {disk} installed; restart DSH to activate (running {version})",
      updLocal: "Local dev install ({spec}): rebuild the local directory and restart DSH to update",
      updUnknown: "Install source not recognized ({spec}); please check updates manually",
      updErr: "Update check failed (network); visit github.com/{repo} for the latest release",
    };

    // ---------------------------------------------------------------- styles

    var sectionStyle = { flexDirection: "column", gap: "14px", width: "100%", display: "flex" };
    var headStyle = { display: "flex", alignItems: "flex-start", flexDirection: "column", gap: "4px", padding: "2px 2px 0" };
    var titleStyle = { fontSize: 16, fontWeight: 600, color: "var(--dsw-alias-label-primary)", lineHeight: 1.4 };
    var introStyle = { fontSize: 13, color: "var(--dsw-alias-label-secondary)", lineHeight: 1.6, maxWidth: "720px" };
    var cardStyle = { boxSizing: "border-box", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", borderRadius: "14px", flexDirection: "column", gap: "8px", padding: "14px 16px", display: "flex" };
    var cardTitleStyle = { fontSize: 14, fontWeight: 600, color: "var(--dsw-alias-label-primary)", lineHeight: 1.4 };
    var rowStyle = { display: "flex", alignItems: "flex-start", gap: "10px", padding: "6px 0" };
    var rowInlineStyle = { display: "flex", alignItems: "center", gap: "10px", padding: "6px 0" };
    var labelStyle = { display: "flex", flexDirection: "column", gap: "2px", flex: 1, minWidth: 0 };
    var nameStyle = { fontWeight: 500, color: "var(--dsw-alias-label-primary)", fontSize: 14, lineHeight: 1.4 };
    var descStyle = { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.5 };
    var checkboxStyle = { width: 16, height: 16, cursor: "pointer", accentColor: "var(--dsw-alias-brand-primary)", flex: "none", marginTop: 2 };
    var msgOkStyle = { fontSize: 12, color: "var(--dsw-alias-state-success-primary)", lineHeight: 1.5, wordBreak: "break-all" };
    var msgErrStyle = { fontSize: 12, color: "var(--dsw-alias-state-error-primary)", lineHeight: 1.5, wordBreak: "break-all" };
    var footStyle = { display: "flex", alignItems: "center", gap: "10px", padding: "2px", flexWrap: "wrap" };
    var inputStyle = { width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)", fontSize: "13px", outline: "none", fontFamily: "inherit" };
    var textareaStyle = { width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)", fontSize: "13px", outline: "none", fontFamily: "inherit", minHeight: "64px", resize: "vertical" };
    var fieldStyle = { display: "flex", flexDirection: "column", gap: "6px", width: "100%" };
    var fieldLabelStyle = { fontSize: 13, color: "var(--dsw-alias-label-primary)", fontWeight: 500 };
    var phBoxStyle = { boxSizing: "border-box", border: "1px dashed var(--dsw-alias-border-l2)", borderRadius: "10px", padding: "10px 12px", background: "var(--dsw-alias-bg-layer-2)", fontSize: 12, color: "var(--dsw-alias-label-secondary)", lineHeight: 1.7, wordBreak: "break-all" };
    var twoColStyle = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" };
    var qrBoxStyle = { alignSelf: "center", background: "#ffffff", color: "#111111", padding: "10px 12px", borderRadius: "10px", fontFamily: "'Menlo', 'Consolas', 'Courier New', monospace", fontSize: "9px", lineHeight: "10px", letterSpacing: "0px", whiteSpace: "pre", userSelect: "none" };
    var statusPillStyle = { fontSize: 12, padding: "2px 10px", borderRadius: "999px", border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-secondary)", flex: "none" };
    var updRowStyle = { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", padding: "0 2px" };
    var updOkStyle = { fontSize: 12, color: "var(--dsw-alias-state-success-primary)", lineHeight: 1.5 };
    var updBannerStyle = { boxSizing: "border-box", border: "1px solid var(--dsw-alias-state-warning-primary, #d48806)", background: "var(--dsw-alias-bg-layer-3)", borderRadius: "12px", padding: "12px 14px", display: "flex", flexDirection: "column", gap: "8px" };
    var updNoteStyle = { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.6, wordBreak: "break-all" };
    var updCodeStyle = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, padding: "8px 10px", borderRadius: "8px", background: "var(--dsw-alias-bg-layer-2)", border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-primary)", wordBreak: "break-all", lineHeight: 1.6 };

    // ---------------------------------------------------------------- update helpers

    function parseVer(tag) {
      var m = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(tag == null ? "" : tag).trim());
      return m ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)] : null;
    }
    function isNewer(a, b) {
      var pa = parseVer(a), pb = parseVer(b);
      if (!pa || !pb) return false;
      if (pa[0] !== pb[0]) return pa[0] > pb[0];
      if (pa[1] !== pb[1]) return pa[1] > pb[1];
      return pa[2] > pb[2];
    }
    function maxTag(names) {
      var best = null;
      (names || []).forEach(function (n) {
        if (n && parseVer(n) && (best === null || isNewer(n, best))) best = n;
      });
      return best;
    }
    function legacyCopy(text) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (e) { /* 忽略 */ }
      document.body.removeChild(ta);
    }
    function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(text).catch(function () { legacyCopy(text); });
        }
      } catch (e) { /* 忽略 */ }
      legacyCopy(text);
      return Promise.resolve();
    }
    function fillTpl(str, vars) {
      return String(str == null ? "" : str).replace(/\{(\w+)\}/g, function (_, key) {
        return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : "{" + key + "}";
      });
    }

    // ---------------------------------------------------------------- api

    function api(method, payload) {
      return fetch("/wechat-notice/api/" + method, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload || {}),
        credentials: "same-origin",
      }).then(function (res) { return res.json(); }).then(function (body) {
        if (!body || body.ok !== true) {
          var msg = body && body.error && body.error.message ? body.error.message : "api error";
          var err = new Error(msg);
          throw err;
        }
        return body.value;
      });
    }

    // ---------------------------------------------------------------- fields

    function ToggleRow(props) {
      return createElement("div", { style: rowInlineStyle },
        createElement("input", {
          type: "checkbox",
          checked: props.checked === true,
          onChange: function (e) { props.onChange(e.target.checked); },
          style: checkboxStyle,
        }),
        createElement("div", { style: labelStyle },
          createElement("div", { style: nameStyle }, props.label),
          props.hint ? createElement("div", { style: descStyle }, props.hint) : null,
        ),
      );
    }

    function NumberField(props) {
      return createElement("div", { style: fieldStyle },
        createElement("div", { style: fieldLabelStyle }, props.label),
        createElement("input", {
          value: props.value == null ? "" : String(props.value),
          type: "number",
          min: props.min,
          max: props.max,
          step: props.step || 1,
          onChange: function (e) {
            var n = parseInt(e.target.value, 10);
            props.onChange(Number.isFinite(n) ? n : 0);
          },
          style: inputStyle,
        }),
        props.hint ? createElement("div", { style: descStyle }, props.hint) : null,
      );
    }

    function TemplateField(props) {
      return createElement("div", { style: fieldStyle },
        createElement("div", { style: fieldLabelStyle }, props.label),
        createElement("textarea", {
          value: props.value == null ? "" : String(props.value),
          placeholder: props.placeholder || "",
          onChange: function (e) { props.onChange(e.target.value); },
          style: textareaStyle,
        }),
      );
    }

    // ---------------------------------------------------------------- login card

    function LoginCard(props) {
      var t = props.t;
      var status = props.status;
      var onStatusRefresh = props.onStatusRefresh;
      var setMsg = props.setMsg;

      var loginState = useState(null);
      var login = loginState[0]; // {phase, message, qr}
      var setLogin = loginState[1];

      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      var aliveRef = useRef(true);
      useEffect(function () {
        aliveRef.current = true;
        return function () { aliveRef.current = false; };
      }, []);

      // 登录进行中：每 2 秒轮询 loginStatus，直到 ok/error/idle
      useEffect(function () {
        if (!login || login.phase === "idle" || login.phase === "ok" || login.phase === "error") return undefined;
        var timer = setInterval(function () {
          api("loginStatus").then(function (value) {
            if (!aliveRef.current) return;
            setLogin(value);
            if (value.phase === "ok") {
              clearInterval(timer);
              setMsg({ kind: "ok", text: t("loggedInAs") + (value.accountId ? " · " + value.accountId : "") });
              onStatusRefresh();
            } else if (value.phase === "error") {
              clearInterval(timer);
            }
          }).catch(function () { /* 下一轮再试 */ });
        }, 2000);
        return function () { clearInterval(timer); };
      }, [login, onStatusRefresh, setMsg, t]);

      var doLoginStart = useCallback(function () {
        setBusy(true);
        setMsg(null);
        api("loginStart").then(function () {
          return api("loginStatus");
        }).then(function (value) {
          if (aliveRef.current) setLogin(value);
        }).catch(function (error) {
          if (aliveRef.current) setMsg({ kind: "err", text: error.message });
        }).finally(function () {
          if (aliveRef.current) setBusy(false);
        });
      }, [setMsg]);

      var doCancel = useCallback(function () {
        api("loginCancel").then(function () {
          if (aliveRef.current) setLogin(null);
        }).catch(function () { /* ignore */ });
      }, []);

      var doLogout = useCallback(function () {
        if (!window.confirm(t("logoutConfirm"))) return;
        setBusy(true);
        api("logout").then(function () {
          if (aliveRef.current) { setLogin(null); onStatusRefresh(); }
        }).catch(function (error) {
          if (aliveRef.current) setMsg({ kind: "err", text: error.message });
        }).finally(function () {
          if (aliveRef.current) setBusy(false);
        });
      }, [onStatusRefresh, setMsg, t]);

      var loggedIn = status.loggedIn === true;
      var phase = login ? login.phase : "";
      var qrVisible = login !== null && (phase === "qr" || phase === "waiting") && login.qr;

      return createElement("div", { style: cardStyle },
        createElement("div", { style: rowInlineStyle, justifyContent: "space-between" },
          createElement("div", { style: cardTitleStyle }, t("login")),
          loggedIn
            ? createElement("span", { style: statusPillStyle }, t("loggedInAs") + (status.account ? " · " + status.account : ""))
            : null,
        ),
        loggedIn
          ? createElement("div", { style: rowStyle },
              createElement("div", { style: labelStyle },
                createElement("div", { style: nameStyle }, t("botReady") + "：" + (status.botReady ? t("botReadyOk") : t("botReadyNo"))),
                createElement("div", { style: descStyle },
                  t("pushToken") + "：" + (status.tokenCapturedAt
                    ? Math.max(1, Math.round((Date.now() - status.tokenCapturedAt) / 3600000)) + " " + t("hoursAgo") + "（" + new Date(status.tokenCapturedAt).toLocaleString() + "）"
                    : t("tokenNone"))),
                status.lastPushError
                  ? createElement("div", { style: msgErrStyle }, status.lastPushError)
                  : createElement("div", { style: descStyle },
                      t("lastPush") + "：" + (status.lastPushAt ? new Date(status.lastPushAt).toLocaleString() : t("neverPushed"))),
                status.lastPushError && status.lastPushError.indexOf("context_token") >= 0
                  ? createElement("div", { style: descStyle }, t("tokenHint"))
                  : null,
              ),
              createElement(Button, { variant: "outline", onClick: doLogout, disabled: busy }, t("logoutBtn")),
            )
          : createElement("div", { style: rowInlineStyle },
              createElement(Button, { variant: "primary", onClick: doLoginStart, disabled: busy || (login !== null && (phase === "starting" || phase === "qr" || phase === "waiting")) },
                busy || (login !== null && (phase === "starting" || phase === "qr" || phase === "waiting")) ? t("loggingIn") : t("loginBtn")),
              login !== null && login.message ? createElement("span", { style: descStyle }, login.message) : null,
              login !== null && login.phase === "error" ? createElement("span", { style: msgErrStyle }, t("loginFailed") + "：" + (login.message || "")) : null,
            ),
        qrVisible
          ? createElement("div", { style: fieldStyle },
              createElement("div", { style: Object.assign({}, fieldLabelStyle, { textAlign: "center" }) }, t("qrTitle")),
              createElement("div", { style: qrBoxStyle }, login.qr),
              createElement("div", { style: Object.assign({}, descStyle, { textAlign: "center" }) }, t("qrHint")),
              createElement(Button, { variant: "outline", onClick: doCancel }, t("cancelLogin")),
            )
          : null,
      );
    }

    // ---------------------------------------------------------------- tabs

    var tabBarStyle = { display: "flex", gap: "6px", padding: "4px", borderRadius: "12px", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-2)", width: "fit-content" };
    var tabActiveStyle = { padding: "6px 16px", borderRadius: "9px", border: "none", background: "var(--dsw-alias-brand-primary)", color: "#ffffff", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" };
    var tabIdleStyle = { padding: "6px 16px", borderRadius: "9px", border: "none", background: "transparent", color: "var(--dsw-alias-label-secondary)", fontSize: 13, cursor: "pointer", fontFamily: "inherit" };
    var panelStyle = { display: "flex", flexDirection: "column", gap: "14px", width: "100%" };

    // ---------------------------------------------------------------- section

    function WechatSection(props) {
      var t = props.t;

      var formState = useState(null);
      var form = formState[0];
      var setForm = formState[1];

      var loadErrState = useState(false);
      var loadErr = loadErrState[0];
      var setLoadErr = loadErrState[1];

      var msgState = useState(null);
      var msg = msgState[0];
      var setMsg = msgState[1];

      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      var savedSnapState = useState("");
      var savedSnap = savedSnapState[0];
      var setSavedSnap = savedSnapState[1];

      var updState = useState(null);
      var upd = updState[0];
      var setUpd = updState[1];

      var updCopyState = useState(false);
      var updCopied = updCopyState[0];
      var setUpdCopied = updCopyState[1];

      var tabState = useState("wecom");
      var activeTab = tabState[0];
      var setActiveTab = tabState[1];

      // ---------------------------------------------------------------- update helpers (section scope)

      var runUpdateCheck = useCallback(function () {
        setUpd({ kind: "checking" });
        setUpdCopied(false);
        api("checkUpdate").then(function (value) {
          if (!value) { setUpd({ kind: "error", repo: "", version: "" }); return; }
          if (value.mode === "github") {
            var current = value.currentTag || value.version || "";
            if (value.pendingRestart) {
              setUpd({ kind: "pendingRestart", disk: value.diskVersion, version: value.version || current });
              return null;
            }
            if (value.latest) {
              if (value.upToDate) setUpd({ kind: "latest", version: current });
              else setUpd({ kind: "new", latest: value.latest, version: current, command: "dsh plugin --profile web add github:" + value.repoSlug + "#" + value.latest });
              return null;
            }
            return fetch("https://api.github.com/repos/" + value.repoSlug + "/tags?per_page=100")
              .then(function (res) { return res.json(); })
              .then(function (tags) {
                var latest = maxTag((Array.isArray(tags) ? tags : []).map(function (x) { return x && x.name; }));
                if (!latest) { setUpd({ kind: "error", repo: value.repoSlug, version: current }); return; }
                if (isNewer(latest, current)) setUpd({ kind: "new", latest: latest, version: current, command: "dsh plugin --profile web add github:" + value.repoSlug + "#" + latest });
                else setUpd({ kind: "latest", version: current });
              })
              .catch(function () { setUpd({ kind: "error", repo: value.repoSlug, version: current }); });
          } else if (value.mode === "local") {
            setUpd({ kind: "local", spec: value.spec, version: value.version });
          } else {
            setUpd({ kind: "unknown", spec: value.spec, version: value.version });
          }
          return null;
        }).catch(function () {
          setUpd({ kind: "error", repo: "simontigers/dsh-wechat-notice", version: "" });
        });
      }, []);

      var statusState = useState(null);
      var status = statusState[0];
      var setStatus = statusState[1];

      var refreshStatus = useCallback(function () {
        api("status").then(function (value) {
          setStatus(value);
        }).catch(function () { /* 静默，下轮再看 */ });
      }, []);

      var applyConfig = useCallback(function (config) {
        setForm(config);
        setSavedSnap(JSON.stringify(config));
      }, []);

      var refresh = useCallback(function () {
        setLoadErr(false);
        api("get").then(function (value) {
          applyConfig(value.config || {});
        }).catch(function () {
          setLoadErr(true);
        });
        refreshStatus();
      }, [applyConfig, refreshStatus]);

      useEffect(function () { refresh(); }, [refresh]);
      useEffect(function () { runUpdateCheck(); }, [runUpdateCheck]);

      var setField = useCallback(function (key, value) {
        setForm(function (prev) {
          var next = Object.assign({}, prev);
          next[key] = value;
          return next;
        });
      }, []);

      var setEvent = useCallback(function (key, value) {
        setForm(function (prev) {
          var next = Object.assign({}, prev);
          next.events = Object.assign({}, prev.events);
          next.events[key] = value;
          return next;
        });
      }, []);

      var setChannelField = useCallback(function (ch, key, value) {
        setForm(function (prev) {
          var next = Object.assign({}, prev);
          next.channels = Object.assign({}, prev.channels);
          next.channels[ch] = Object.assign({}, prev.channels[ch]);
          next.channels[ch][key] = value;
          return next;
        });
      }, []);

      var setChannelTemplate = useCallback(function (ch, key, value) {
        setForm(function (prev) {
          var next = Object.assign({}, prev);
          next.channels = Object.assign({}, prev.channels);
          next.channels[ch] = Object.assign({}, prev.channels[ch]);
          next.channels[ch].templates = Object.assign({}, prev.channels[ch].templates);
          next.channels[ch].templates[key] = value;
          return next;
        });
      }, []);

      var dirty = form !== null && savedSnap !== "" && JSON.stringify(form) !== savedSnap;

      var doSave = useCallback(function () {
        if (!form) return;
        setBusy(true);
        setMsg(null);
        api("save", { config: form }).then(function (value) {
          applyConfig(value.config || form);
          setMsg({ kind: "ok", text: t("savedOk") });
        }).catch(function (error) {
          setMsg({ kind: "err", text: error.message });
        }).finally(function () {
          setBusy(false);
        });
      }, [form, applyConfig, t]);

      var doTest = useCallback(function (channel) {
        if (!form) return;
        setBusy(true);
        setMsg(null);
        api("test", { config: form, channel: channel }).then(function (value) {
          setMsg({ kind: "ok", text: t("testOk") + (value && value.detail ? value.detail : "") });
          refreshStatus();
        }).catch(function (error) {
          setMsg({ kind: "err", text: error.message });
          refreshStatus();
        }).finally(function () {
          setBusy(false);
        });
      }, [form, refreshStatus, t]);

      if (loadErr) {
        return createElement("div", { style: sectionStyle },
          createElement("div", { style: titleStyle }, t("nav")),
          createElement("div", { style: msgErrStyle }, t("loadErr")),
          createElement(Button, { variant: "outline", onClick: refresh }, t("retry")),
        );
      }

      if (!form) {
        return createElement("div", { style: sectionStyle },
          createElement("div", { style: titleStyle }, t("nav")),
        );
      }

      var ev = form.events || {};
      var channelsCfg = form.channels || {};
      var wecomCfg = channelsCfg.wecom || {};
      var weixinCfg = channelsCfg.weixin || {};
      var wecomTpl = wecomCfg.templates || {};
      var weixinTpl = weixinCfg.templates || {};
      var statusWecom = (status && status.wecom) || {};

      var updButton = createElement(Button, {
        variant: "outline",
        onClick: runUpdateCheck,
        disabled: upd && upd.kind === "checking",
      }, upd && upd.kind === "checking" ? t("updChecking") : t("updCheck"));

      var updView = null;
      if (upd && upd.kind === "checking") {
        updView = createElement("div", { style: updRowStyle }, createElement("span", { style: updNoteStyle }, t("updChecking")));
      } else if (upd && upd.kind === "latest") {
        updView = createElement("div", { style: updRowStyle },
          createElement("span", { style: updOkStyle }, "✓ " + t("updLatest") + (upd.version ? "（" + upd.version + "）" : "")),
          updButton,
        );
      } else if (upd && upd.kind === "pendingRestart") {
        updView = createElement("div", { style: updBannerStyle },
          createElement("div", { style: updRowStyle },
            createElement("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } },
              fillTpl(t("updPending"), { disk: upd.disk || "", version: upd.version || "" })),
            updButton,
          ),
        );
      } else if (upd && upd.kind === "new") {
        updView = createElement("div", { style: updBannerStyle },
          createElement("div", { style: updRowStyle },
            createElement("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } },
              fillTpl(t("updNew"), { latest: upd.latest, version: upd.version })),
            updButton,
          ),
          createElement("code", { style: updCodeStyle }, upd.command),
          createElement("div", { style: updRowStyle },
            createElement(Button, {
              variant: "outline",
              onClick: function () {
                copyText(upd.command).then(function () {
                  setUpdCopied(true);
                  setTimeout(function () { setUpdCopied(false); }, 2000);
                });
              },
            }, updCopied ? t("updCopied") : t("updCopy")),
          ),
        );
      } else if (upd && upd.kind === "local") {
        updView = createElement("div", { style: updRowStyle },
          createElement("span", { style: updNoteStyle }, fillTpl(t("updLocal"), { spec: upd.spec || "link:" })),
          updButton,
        );
      } else if (upd && upd.kind === "unknown") {
        updView = createElement("div", { style: updRowStyle },
          createElement("span", { style: updNoteStyle }, fillTpl(t("updUnknown"), { spec: upd.spec || "" })),
          updButton,
        );
      } else if (upd && upd.kind === "error") {
        updView = createElement("div", { style: updRowStyle },
          createElement("span", { style: updNoteStyle }, fillTpl(t("updErr"), { repo: upd.repo || "" })),
          updButton,
        );
      } else {
        updView = createElement("div", { style: updRowStyle }, updButton);
      }

      var renderTemplateFields = function (tpl, setter) {
        return [
          createElement("div", { style: phBoxStyle, key: "ph" },
            createElement("div", { style: fieldLabelStyle }, t("placeholders")),
            createElement("div", { style: descStyle }, t("phHint")),
          ),
          createElement(TemplateField, { key: "t1", label: t("tplTurnTitle"), value: tpl.turnEndTitle, onChange: function (v) { setter("turnEndTitle", v); } }),
          createElement(TemplateField, { key: "t2", label: t("tplTurnBody"), value: tpl.turnEndBody, onChange: function (v) { setter("turnEndBody", v); } }),
          createElement(TemplateField, { key: "t3", label: t("tplTurnFailTitle"), value: tpl.turnEndFailTitle, onChange: function (v) { setter("turnEndFailTitle", v); } }),
          createElement(TemplateField, { key: "t4", label: t("tplTurnFailBody"), value: tpl.turnEndFailBody, onChange: function (v) { setter("turnEndFailBody", v); } }),
          createElement(TemplateField, { key: "t5", label: t("tplApprovalTitle"), value: tpl.approvalTitle, onChange: function (v) { setter("approvalTitle", v); } }),
          createElement(TemplateField, { key: "t6", label: t("tplApprovalBody"), value: tpl.approvalBody, onChange: function (v) { setter("approvalBody", v); } }),
          createElement(TemplateField, { key: "t7", label: t("tplErrorTitle"), value: tpl.errorTitle, onChange: function (v) { setter("errorTitle", v); } }),
          createElement(TemplateField, { key: "t8", label: t("tplErrorBody"), value: tpl.errorBody, onChange: function (v) { setter("errorBody", v); } }),
        ];
      };

      var tabBar = createElement("div", { style: tabBarStyle },
        createElement("button", { style: activeTab === "wecom" ? tabActiveStyle : tabIdleStyle, onClick: function () { setActiveTab("wecom"); } }, t("tabWecom")),
        createElement("button", { style: activeTab === "weixin" ? tabActiveStyle : tabIdleStyle, onClick: function () { setActiveTab("weixin"); } }, t("tabWeixin")),
      );

      var channelPanel;
      if (activeTab === "wecom") {
        channelPanel = [
          createElement("div", { style: cardStyle, key: "wecom-card" },
            createElement("div", { style: cardTitleStyle }, t("tabWecom")),
            createElement("div", { style: introStyle }, t("wecomIntro")),
            createElement(ToggleRow, {
              checked: wecomCfg.enabled !== false,
              label: t("enabled"),
              hint: t("enabledHint"),
              onChange: function (v) { setChannelField("wecom", "enabled", v); },
            }),
            createElement("div", { style: fieldStyle },
              createElement("div", { style: fieldLabelStyle }, t("webhook")),
              createElement("input", {
                value: wecomCfg.webhook || "",
                placeholder: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…",
                onChange: function (e) { setChannelField("wecom", "webhook", e.target.value); },
                style: inputStyle,
              }),
              createElement("div", { style: descStyle }, t("webhookHint")),
            ),
            createElement("div", { style: fieldStyle },
              createElement("div", { style: fieldLabelStyle }, t("msgtype")),
              createElement("select", {
                value: wecomCfg.msgtype === "markdown" ? "markdown" : "text",
                onChange: function (e) { setChannelField("wecom", "msgtype", e.target.value); },
                style: inputStyle,
              },
                createElement("option", { value: "text" }, t("msgtypeText")),
                createElement("option", { value: "markdown" }, t("msgtypeMarkdown")),
              ),
            ),
          ),
          createElement("div", { style: cardStyle, key: "wecom-tpl" },
            createElement("div", { style: cardTitleStyle }, t("templates")),
            ...renderTemplateFields(wecomTpl, function (k, v) { setChannelTemplate("wecom", k, v); }),
          ),
          createElement("div", { style: footStyle, key: "wecom-foot" },
            createElement(Button, { variant: "outline", onClick: function () { doTest("wecom"); }, disabled: busy }, busy ? t("testing") : t("test")),
            createElement("span", { style: descStyle }, t("wecomTestHint")),
            statusWecom.lastPushError
              ? createElement("span", { style: msgErrStyle }, statusWecom.lastPushError)
              : (statusWecom.lastPushAt
                ? createElement("span", { style: msgOkStyle }, t("lastPush") + "：" + new Date(statusWecom.lastPushAt).toLocaleString())
                : null),
          ),
        ];
      } else {
        channelPanel = [
          createElement(LoginCard, {
            key: "weixin-login",
            t: t,
            status: status || { loggedIn: false, botReady: false, login: {} },
            onStatusRefresh: refreshStatus,
            setMsg: setMsg,
          }),
          createElement("div", { style: cardStyle, key: "weixin-card" },
            createElement("div", { style: cardTitleStyle }, t("tabWeixin")),
            createElement("div", { style: introStyle }, t("weixinIntro")),
            createElement(ToggleRow, {
              checked: weixinCfg.enabled !== false,
              label: t("enabled"),
              hint: t("enabledHint"),
              onChange: function (v) { setChannelField("weixin", "enabled", v); },
            }),
            ...renderTemplateFields(weixinTpl, function (k, v) { setChannelTemplate("weixin", k, v); }),
          ),
          createElement("div", { style: footStyle, key: "weixin-foot" },
            createElement(Button, { variant: "outline", onClick: function () { doTest("weixin"); }, disabled: busy }, busy ? t("testing") : t("test")),
            createElement("span", { style: descStyle }, t("weixinTestHint")),
          ),
        ];
      }

      return createElement("div", { style: sectionStyle },
        createElement("div", { style: headStyle },
          createElement("div", { style: titleStyle }, t("nav")),
          createElement("div", { style: introStyle }, t("intro")),
        ),

        // ---- 检查更新
        updView,

        // ---- 通道 Tab
        tabBar,
        createElement("div", { style: panelStyle }, channelPanel),

        // ---- 通用配置（双通道共用）
        createElement("div", { style: cardStyle },
          createElement("div", { style: cardTitleStyle }, t("shared")),
          createElement("div", { style: twoColStyle },
            createElement(NumberField, {
              label: t("debounce"),
              value: form.debounceMs,
              min: 0,
              max: 300000,
              step: 1000,
              hint: t("debounceHint"),
              onChange: function (v) { setField("debounceMs", v); },
            }),
            createElement(NumberField, {
              label: t("summaryMax"),
              value: form.summaryMaxChars,
              min: 20,
              max: 1800,
              step: 50,
              hint: t("summaryMaxHint"),
              onChange: function (v) { setField("summaryMaxChars", v); },
            }),
          ),
        ),

        // ---- 事件开关
        createElement("div", { style: cardStyle },
          createElement("div", { style: cardTitleStyle }, t("events")),
          createElement(ToggleRow, {
            checked: ev.turnEnd !== false,
            label: t("evTurn"),
            hint: t("evTurnHint"),
            onChange: function (v) { setEvent("turnEnd", v); },
          }),
          createElement(ToggleRow, {
            checked: ev.turnEndFail !== false,
            label: t("evTurnFail"),
            hint: t("evTurnFailHint"),
            onChange: function (v) { setEvent("turnEndFail", v); },
          }),
          createElement(ToggleRow, {
            checked: ev.approval !== false,
            label: t("evApproval"),
            hint: t("evApprovalHint"),
            onChange: function (v) { setEvent("approval", v); },
          }),
          createElement(ToggleRow, {
            checked: ev.agentError !== false,
            label: t("evError"),
            hint: t("evErrorHint"),
            onChange: function (v) { setEvent("agentError", v); },
          }),
        ),

        // ---- 保存
        createElement("div", { style: footStyle },
          createElement(Button, { variant: "primary", onClick: doSave, disabled: busy || !dirty }, busy ? t("saving") : t("save")),
          dirty ? createElement("span", { style: descStyle }, t("dirty")) : null,
          msg ? createElement("span", { style: msg.kind === "ok" ? msgOkStyle : msgErrStyle }, msg.text) : null,
        ),
      );
    }
    // ---------------------------------------------------------------- surface

    var inject = ["slots", "locale"];

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "dsh-wechat-notice: locale");
      var t = ctx.locale.bind(NS);
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "dsh-wechat-notice",
          order: 62,
          label: function () { return t("nav"); },
          locale: NS,
          inject: function () { return { t: t }; },
        }, WechatSection);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
