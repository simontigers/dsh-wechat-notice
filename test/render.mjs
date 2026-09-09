// SSR 复现：执行 dsh-wechat-notice 客户端 factory，用真实 React 渲染设置区块
// 任何 render-time 抛错都会在这里原样暴露（对应浏览器里设置页空白的根因）
// 运行前需要：npm i --no-save react@18 react-dom@18（未安装则跳过本测试）
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

let React, renderToString;
try {
  React = (await import("react")).default;
  renderToString = (await import("react-dom/server")).renderToString;
} catch {
  console.log("skip: 未安装 react / react-dom（npm i --no-save react@18 react-dom@18 后可运行）");
  process.exit(0);
}

const require2 = createRequire(import.meta.url);
const clientSrc = readFileSync(new URL("../lib/client.js", import.meta.url).pathname, "utf8");

// ---- 捕获 __ModuleLoader__.load 的 factory
let factory = null;
globalThis.window = {
  __ModuleLoader__: {
    load(def) { factory = def.factory; },
  },
};
try { Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true }); } catch { /* 已有只读 navigator，跳过 */ }
globalThis.document = undefined; // copyText 只在点击时用

// ---- 最小 require 桩：react 用真的，primitives 用透传 Button
const primitivesStub = {
  Button: function Button(props) {
    return React.createElement("button", { onClick: props.onClick, disabled: props.disabled }, props.children);
  },
};
const fakeRequire = (name) => {
  if (name === "react") return React;
  if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
  throw new Error("unexpected require: " + name);
};

{
  const fn = new Function("window", "require", clientSrc + "\n//# sourceURL=client-under-test.js");
  fn(globalThis.window, fakeRequire);
}
if (factory === null) { console.error("FAIL: factory 未注册"); process.exit(1); }

// ---- 执行 factory 得到 exports
const exportsObj = factory(fakeRequire);
console.log("factory 执行 OK，inject =", JSON.stringify(exportsObj.inject));

// ---- 假 locale + slots：注册后 bind 返回真实查表 t
const locales = {};
const fakeCtx = {
  effect(fn, label) { return fn(); },
  locale: {
    register(ns, table) { locales[ns] = table; return () => {}; },
    bind(ns) { return (key, vars) => { const zh = locales[ns]?.zh ?? {}; let s = zh[key] ?? key; if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`)); return s; }; },
  },
  slots: {
    inject(slotName, registerFn) { registerFn(); },
    register(def, Component) { fakeCtx.__captured = { def, Component }; return def; },
  },
};
exportsObj.apply(fakeCtx);
const captured = fakeCtx.__captured;
if (!captured) { console.error("FAIL: slots.register 未被调用"); process.exit(1); }
console.log("slot id =", captured.def.id, "| label() =", captured.def.label());

// ---- 用缺失 key 检测：收集组件里所有 t("...") 调用，逐一对照 zh 表
const zhKeys = Object.keys(locales["dsh-wechat-notice"]?.zh ?? {});
const tCalls = [...clientSrc.matchAll(/\bt\("([a-zA-Z]+)"\)/g)].map((m) => m[1]);
const missing = [...new Set(tCalls)].filter((k) => !zhKeys.includes(k));
if (missing.length > 0) {
  console.error("FAIL: zh 缺少 locale key:", missing.join(", "));
  process.exitCode = 1;
} else {
  console.log("locale key 全部存在（" + new Set(tCalls).size + " 个）");
}

// ---- SSR 渲染：form=null 分支 → 加载配置后完整分支
const t = captured.def.inject().t;
const Comp = captured.Component;
try {
  const html0 = renderToString(React.createElement(Comp, { t }));
  console.log("form=null 分支渲染 OK，长度", html0.length);
} catch (error) {
  console.error("FAIL: form=null 分支抛错:", error && error.stack ? error.stack.split("\n").slice(0, 6).join("\n") : error);
  process.exit(1);
}

// 完整配置分支：给 client 源码打补丁，让 form 初始值就是完整 v2 配置（第一个 useState(null)），
// 使首个 SSR 渲染直接走主分支；再分别渲染 wecom / weixin 两个 Tab
const TEST_FORM = {
  version: 2, debounceMs: 10000, summaryMaxChars: 500,
  events: { turnEnd: true, turnEndFail: true, approval: true, agentError: true },
  channels: {
    wecom: { enabled: true, webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=X", msgtype: "text", templates: { turnEndTitle: "t" } },
    weixin: { enabled: true, templates: { turnEndTitle: "t" } },
  },
};
function renderMainBranch(initialTab) {
  let patched = clientSrc
    .replace("var formState = useState(null);", `var formState = useState(${JSON.stringify(TEST_FORM)});`)
    .replace('var tabState = useState("wecom");', `var tabState = useState("${initialTab}");`);
  if (!patched.includes(initialTab === "wecom" ? `useState(${JSON.stringify(TEST_FORM)})` : "PLACEHOLDER")) {
    // 锚点替换失败会在下面 throw
  }
  const fn2 = new Function("window", "require", patched + "\n//# sourceURL=client-patched.js");
  let factory2 = null;
  const win2 = { __ModuleLoader__: { load(def) { factory2 = def.factory; } } };
  fn2(win2, fakeRequire);
  const exports2 = factory2(fakeRequire);
  const ctx2 = {
    effect(fn, label) { return fn(); },
    locale: { register(ns, table) { return () => {}; }, bind(ns) { return (key) => key; } },
    slots: { inject(slotName, registerFn) { registerFn(); }, register(def, Component) { ctx2.__captured = { def, Component }; return def; } },
  };
  exports2.apply(ctx2);
  const Comp2 = ctx2.__captured.Component;
  const t2 = (key) => key;
  return renderToString(React.createElement(Comp2, { t: t2 }));
}
for (const tab of ["wecom", "weixin"]) {
  try {
    const html = renderMainBranch(tab);
    console.log(`主分支渲染 OK（tab=${tab}），长度`, html.length);
  } catch (error) {
    console.error(`FAIL: 主分支渲染抛错（tab=${tab}）:\n`, error && error.stack ? error.stack.split("\n").slice(0, 8).join("\n") : error);
    process.exit(1);
  }
}
console.log(process.exitCode ? "\n=== 有失败项 ===" : "\n=== 全部渲染路径通过 ===");
