# Zcode-Phone 开发上手需知

> 一个 APK 两种模式：**DSH 模式**（连 DeepSeek Harness Web UI）+ **Zcode 模式**（连 zcode-phone-server 驱动 ZCode 引擎）。
> 本文档面向新加入的开发机：从零 clone 到手机上跑通全链路，以及这一路踩过的所有坑。

---

## 1. 整体架构

```
┌─────────────── 手机（Flutter APK，fork 自 DSH-Phone）───────────────┐
│  设置页：模式(DSH/Zcode) + SSH 地址 + 远端端口 + 本地端口            │
│  dartssh2 建 SSH 隧道：手机 127.0.0.1:3081 → 电脑 127.0.0.1:8787    │
│  WebView 加载 http://127.0.0.1:3081/?token=xxx                     │
│  JS 桥：任务状态通知 / 成果点击 / 语音输入 / 文件上传（两模式共用）  │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ SSH 隧道（仅回环，不经公网）
┌──────────────────────────────▼─────────────────────────────────────┐
│  zcode-phone-server（Node ≥22.5，零 npm 依赖）                      │
│  · HTTP + SSE：会话列表/创建/恢复/发送/停止 + 实时事件流             │
│  · token 鉴权，只监听 127.0.0.1                                     │
│  · stdio JSON-RPC 驱动 zcode app-server（ZCode Protocol）           │
│  · 账号授权推送 + 请求期鉴权应答（读桌面端共享凭据）                 │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ stdin/stdout 换行分隔 JSON 帧
┌──────────────────────────────▼─────────────────────────────────────┐
│  zcode app-server（ZCode 引擎 zcode.cjs，开源仓库 zai-org/ZCode）   │
│  会话管理 / 工具执行 / 模型请求（BigModel Coding Plan）             │
└────────────────────────────────────────────────────────────────────┘
```

**仓库分工**

| 仓库 | 内容 | 分支 |
|---|---|---|
| `liangjianzeng/zcode-phone-server` | 桥接服务（本仓库） | `main` |
| `liangjianzeng/DSH-Phone` | 手机 APK（fork 自原项目） | `main`（DSH/Zcode 双模式已合入主线直开，`zcode-mode` 分支已关闭） |

**工作区约定**（参考本机布局，其他机器可自由选择）：

```
Zcode-Phone/
├── tools/node22/          # 自包含 Node 22 运行时（服务端用，引擎要求 node:sqlite）
├── zcode-phone-server/    # 桥接服务（git 仓库）
├── DSH-Phone/             # 手机端（git 仓库，zcode-mode 分支）
└── ref/ZCode/             # zai-org/ZCode 开源源码（只读参考，查协议用）
```

---

## 2. 环境要求

| 依赖 | 版本 | 用途 | 说明 |
|---|---|---|---|
| Node.js | **≥ 22.5** | 跑桥接服务 + ZCode 引擎 | 引擎用到 `node:sqlite`；低于 22.5 直接报 `No such built-in module: node:sqlite`。国内镜像：`https://npmmirror.com/mirrors/node/v22.17.0/node-v22.17.0-win-x64.zip`，解压即用 |
| Flutter | ≥ 3.27（Dart ^3.6） | 构建 APK | 仅手机端开发需要 |
| Git | 任意 | — | push 建议走 SSH over 443（见 §7） |
| ZCode 桌面版 | 已安装并登录 | 提供 zcode.cjs 引擎与共享凭据 | 默认路径 `C:\Users\<你>\AppData\Local\Programs\ZCode\resources\glm\zcode.cjs` |
| Coding Plan | BigModel/Z.AI 任一套餐已订阅 | 模型调用 | 凭据在 `~/.zcode/v2/credentials.json`，桥自动读取 |

---

## 3. 服务端：5 分钟跑起来

```bat
git clone ssh://git@ssh.github.com:443/liangjianzeng/zcode-phone-server.git
cd zcode-phone-server
:: 修改 config.json 里的 nodePath / zcodePath / builtinProviderConfigPath 为本机实际路径
start.bat
```

首次启动自动生成访问令牌并写回 `config.json`，控制台打印：

```
http://127.0.0.1:8787/?token=<token>
```

**浏览器打开这个地址**即为自测通过：能建会话、发消息、看到流式回复即全链路 OK。

### config.json 关键字段

| 字段 | 说明 | 注意 |
|---|---|---|
| `port` | 监听端口（**只绑 127.0.0.1**） | 手机经 SSH 隧道访问 |
| `token` | 访问令牌（≥16 字符，空则自动生成） | 泄露 = 别人能用你的套餐 |
| `workspacePath` | 会话工作目录 | 手机上聊天的项目根 |
| `mode` | 新会话权限模式 `yolo/build/edit/plan` | 手机远程场景建议 `yolo` |
| `autoAnswer` | agent 反向交互：`allow`=自动放行；`ask`=转发手机人工处理 | `ask` 时权限/提问卡片会出现在聊天里 |
| `model` | 模型选择串 `providerId/modelId$档位` | 见 §6 坑 5 |
| `builtinProviderConfigPath` | 内置 Provider 规则文件 | **必须指向桌面端 resources 下的 zcode-builtin.json**，见 §6 坑 4 |

---

## 4. 手机端：APK 构建与联调

```bash
git clone ssh://git@ssh.github.com:443/liangjianzeng/DSH-Phone.git
cd DSH-Phone && git checkout zcode-mode
flutter pub get
flutter analyze        # 改动应无告警
flutter build apk      # 或 flutter run 直接连真机
```

**联调配置（设置页）**：

1. 选一个实例标签页，**服务模式**切到 `Zcode`（远端端口自动回填 8787）；
2. SSH 地址/用户名/密钥 = 你的电脑；
3. 保存后连接，WebView 里出现 ZCode 聊天界面即成功。

**临时验证（不装 APK）**：手机装 Termius/JuiceSSH 做 SSH 本地转发 `3081 → 电脑:8787`，手机浏览器开 `http://127.0.0.1:3081/?token=<token>` 一样能玩。

---

## 5. 双模式为什么几乎不改 App 代码

桥接脚本靠 DOM 约定识别页面状态，`zcode-phone-server` 的 Web UI 刻意遵守了同一套约定：

| DSH-Phone 桥 | 依赖的 DOM 约定 | zcode 服务端 Web UI 的对应实现 |
|---|---|---|
| taskBridgeJs（任务运行/审批通知） | `role="status" aria-live="polite"` + 文本含 `Deep diving` | 状态条文本 `Deep diving · 任务进行中…` |
| taskBridgeJs（审批检测） | ≤12 字符的可见按钮含 `批准/拒绝/Approve…` | 权限卡片按钮 `批准` / `拒绝` |
| artifactBridgeJs（成果点击） | `class*="fileMention"` 且 `title="<完整路径>"` | 工具产出文件渲染为 chip |
| composerBridgeJs（文本注入） | 可见 `textarea`/contenteditable | 原生 `<textarea id="composer">` |
| terminalBridgeJs | `.xterm` | 无终端面板，桥静默不触发 |

**改动新页面时请维持这些约定**，否则 App 端对应功能会静默失效。

---

## 6. 协议避坑手册（每条都真实踩过）

线路格式：stdin/stdout 上的**换行分隔 JSON 帧**（协议源码：开源仓库 `packages/shared/src/zcode-protocol/index.ts`）。

1. **帧不带 `jsonrpc` 字段**。schema 是 strict 的，多一个键整帧被拒（`unrecognized_keys`），表现为所有请求无声超时。帧即 `{id, method, params}` → `{id, result|error}`。
2. **`session/create` 返回完整快照**，sessionId 在 `result.session.sessionId`，不是 `result.sessionId`。
3. **收事件必须先 `session/subscribe`**（`deliveryKind: "desktop-continuous"`），之后服务端才推 `{method:"session/event"}` 通知。
4. **账号授权必须主动推送**。app-server 不读凭据，桌面端是闭源 host 推的：
   - 调 `provider/updateAccountConfig`，providers 形如 `{"account:bigmodel-individual-coding-plan": {"access": {"type":"zhipu-account","entitled":true}}}`，states 必须带 `{"availability":"available","entitled":true,"current":true}`；
   - **`basedOnZCodeBuiltinRevision` 必须精确等于** `zcode-builtin:{revision}:{sha256(内置配置文件绝对路径)}`（算法见 `packages/provider-node/src/zcode-builtin-provider-config-source.ts`），差一个字符 Registry **静默跳过**组合，报 "Provider Registry 中不存在 Provider/Model"；
   - spawn 引擎时必须设 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`（指向桌面端 `resources/config/provider/zcode-builtin.json`）+ `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`（`~/.zcode/v2/provider_config.json`）——引擎默认按**自身版本号**找缓存路径，找不到就拿到空目录。
5. **模型串要带档位**：`account:bigmodel-individual-coding-plan/GLM-5.3-Flash$max`。缺档位报 "Reasoning level is required"。档位合法值看内置配置里该模型的 `optionSpecs.reasoningLevel.values`（GLM-5.3-Flash 有 `max`）。
6. **请求期鉴权**：Coding Plan 模型每次请求前 agent 反向调用 `interaction/requestProviderRuntimeHeaders`，桥必须应答 `{headersApplied:true, requestAuth:{apiKey}}`（api-key 在 `~/.zcode/v2/credentials.json`，值用 AES-256-GCM 加密，密钥 = sha256(`zcode-credential-fallback:{platform}:{homedir}:{username}`)，同机解密无需额外 env；明文值原样透传）。
7. **`session/send` 是单飞的**：回合运行中再发会被拒（协议 -32010），桥已在 `turn.started/completed` 事件上做了 busy 跟踪并提前返回 409。
8. **反向请求必须应答**：agent 会发来 `session/requestRuntimePreferences` / `interaction/requestPermission` / `interaction/requestUserInput` / `interaction/requestProviderRuntimeHeaders` 等带 id 的请求帧，不应答 = 永久悬挂。桥内已全部处理。
9. **app-server 无 initialize 握手**：不用发任何握手帧，起来直接调 session/* 方法即可；`startup/storageState` 通知只是日志噪音。

---

## 7. 常见故障速查

| 现象 | 原因 | 处置 |
|---|---|---|
| `No such built-in module: node:sqlite` | Node < 22.5 | 换 Node 22（见 §2） |
| 所有 API 请求超时 | 引擎帧格式错误 / app-server 未起 | 看桥日志 `agent-stderr`；确认没有多余的 `jsonrpc` 字段 |
| `Select a model before continuing` | 会话没带 model | config.json 的 `model` 别清空 |
| `Provider Registry 中不存在 Provider` | 授权推送 revision 不匹配 / 内置配置文件没指对 | 见 §6 坑 4 |
| `Reasoning level is required` | 模型串缺 `$档位` | 补 `$max` 等 |
| 手机打不开页面 | 隧道端口/token 不对 | 先在电脑浏览器确认服务 OK，再查隧道和 token |
| 中文在 curl 测试里变乱码 | Git Bash 编码问题 | 用浏览器测试，或 `chcp 65001` |
| git push 连接被重置 | 网络到 github.com:443 不通 | 用 SSH over 443：`git remote set-url origin ssh://git@ssh.github.com:443/<user>/<repo>.git` |

---

## 8. 安全须知

- 桥**只监听 127.0.0.1**，永远不要改成 0.0.0.0 直接暴露公网；手机一律走 SSH 隧道 / Tailscale。
- `config.json` 与 `logs/` 含 token，已在 `.gitignore`，**不要提交**。
- `mode: "yolo"` + `autoAnswer: "allow"` 意味着手机上的会话可以无确认执行任何工具——请确保电脑本身在你可控的网络里。

---

## 9. 开发约定

- 服务端改动提交到 `zcode-phone-server` `main`；App 改动同样在 `DSH-Phone` `main` 直开（`zcode-mode` 分支已合并关闭，见 §1 仓库分工）。
- **改 `public/index.html` 不用重启服务**：server 对 `/` 每请求读盘，且页面按 `/api/state` 的
  构建指纹（md5 前 8 位）自动 reload（手机端 ≤25s 生效）；改 `server.mjs` 才需要
  `bash restart_server.sh`（自带等会话空闲守卫）。注意 WebView 后台时轮询暂停，
  回前台才补——联调时改动没生效先手动刷新一次页面。
- 协议相关问题优先查开源源码：`ref/ZCode/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/`（服务端语义）、`packages/shared/src/zcode-protocol/`（schema 真源）。
- 调试神器：桥日志 `logs/server.jsonl`（记录每个请求/事件/交互）；引擎日志 `~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl`。
- 页面回归红线：改动 `index.html` 后核对 MODULE-DESIGN §3.7 桥接契约表（哨兵词/审批文案/fileMention/composer），App 端功能靠这些 DOM 约定活着。
