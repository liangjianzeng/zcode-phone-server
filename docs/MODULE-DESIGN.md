# ZCode 手机端系统 · 模块级设计

> 范围：DSH-Phone App（Flutter）的 **Zcode 模式** 全链路 —— 手机 WebView ↔ SSH 隧道 ↔
> zcode-phone-server（本仓库）↔ ZCode 引擎（app-server）↔ 模型提供方。
> 记录截至 2026-10-04 的架构事实、实现方法、踩坑档案与边界。引擎协议依据开源仓库
> `ref/ZCode`（packages/shared/src/zcode-protocol、apps/zcode-cli/packages/bootstrap）。

---

## 1. 总体架构

```
┌─ 手机 App (DSH-Phone, Flutter) ────────────────────────────┐
│  WebView ←— 注入桥脚本（任务状态/成果识别/输入/图片/终端）        │
│  TunnelService：本地 127.0.0.1:<localPort> 监听               │
└──────────────┬────────────────────────────────────────────┘
               │ SSH 本地转发（dartssh2，每条连接现场拨号 direct-tcpip）
┌──────────────▼────────────────────────────────────────────┐
│ zcode-phone-server (server.mjs, 零依赖, Node ≥22.5)          │
│  HTTP/SSE API + token 鉴权 + 会话注册表 + 限流重试              │
└──────────────┬────────────────────────────────────────────┘
               │ stdio（ND-JSON 帧 {id,method,params}，无 jsonrpc 字段）
┌──────────────▼────────────────────────────────────────────┐
│ zcode.cjs app-server（引擎；config.zcodePath 可指桌面版/开源版）  │
└──────────────┬────────────────────────────────────────────┘
               │ HTTPS（凭据：start-plan zcodeJwtToken 直通）
               ▼  模型提供方（z.ai / bigmodel Coding Plan）
```

### 1.1 三条决定设计的基础事实

| # | 事实 | 推论 |
|---|------|------|
| F1 | **会话存储共享**：桌面端与手机引擎共用 `~/.zcode/cli/db/db.sqlite`（session/message/part/… 表）；消息按**部件粒度**实时落盘 | 任意进程都能读到别人回合的进度（轮询跟随的可行性依据） |
| F2 | **SSE 事件是进程内的**：引擎只推送自己执行的回合；桌面端驱动的回合对手机引擎不可见 | 旁观回合只能轮询存储跟随，无法拿到实时事件（含 token 流） |
| F3 | **凭据文件共享**：`~/.zcode/v2/credentials.json`（aes-256-gcm，密钥为机器自包含串） | 手机桥可读取桌面端登录态（oauth token set、standalone key） |
| F4 | **会话存活边界**：引擎把会话持有在内存，未完成首回合的会话在引擎/服务器重启后**彻底消失**（CLI 库无 session 行）；`session/list` 对本进程内新建会话返回的 `title` 恒为空串（标题只写落库层，内存快照不回填），重启后从库里读出的标题才正常 | 桌面任务索引同步必须以**共享库**为存在性与标题的权威源；引擎列表只取 status/mode/workspace |

---

## 2. 模块：zcode-phone-server（server.mjs）

### 2.1 配置（config.json，gitignore，首启自动生成 token）

| 字段 | 说明 | 当前值要点 |
|---|---|---|
| `port` / `token` | 监听 127.0.0.1:8787；token 鉴权（query/header/cookie） | |
| `workspacePath` / `workspaces[]` | 主工作区 + 多工作区白名单 | |
| `mode` / `model` | 新会话权限模式 / 模型选择 `provider/modelId$reasoningLevel` | `account:zai-start-plan/GLM-5.3-Flash$max`（**必须带档位**，引擎强制） |
| `autoAnswer` | `allow`=自动放行权限/自动选第一项；`ask`=转发手机人工 | |
| `nodePath` / `zcodePath` | 引擎运行时；当前指**桌面版闭源二进制**（与桌面同凭据机制） | `…/Programs/ZCode/resources/glm/zcode.cjs` |
| `builtinProviderConfigPath` | 内置 Provider 规则（Registry 的模型目录来源；CLI 自带缓存会缺文件） | 桌面随包 `zcode-builtin.json` |

### 2.2 凭据解析（readCodingPlanApiKey / connectedProviderId）

**优先级（2026-10-04 定稿）**：

1. `config.codingPlanApiKey`（显式配置，当前为空）
2. **`providerId === 'account:zai-start-plan'`** → 读凭据文件 `zcodejwttoken` 键（387 字节 JWT）。
   依据官方 `accountProviderRequestAuthService.ts` L73-76：`planKind==='start-plan'` 时
   `requestAuth.apiKey = tokenSet.zcodeJwtToken`。
3. 其余 provider（individual-coding-plan）→ standalone 独立计费键
   `account-provider:coding-plan:<pid>:account:<uuid>:api-key`（**独立计费，账户无余额必报 1113**）
4. 兜底：任一 `oauth:*:access_token`

**`connectedProviderId()`**：凭据文件存在 `zcodejwttoken` ⇒ 返回 `account:zai-start-plan`；
否则按 standalone 键命中判定 individual-coding-plan。

**鉴权交互 `interaction/requestProviderRuntimeHeaders`**：
- JWT（`^eyJ`）→ `{headersApplied: true, requestAuth: {apiKey}}` **直通**（官方同款，实测 200）
- id.secret → 同上直通（走到按量端点）
- 无凭据 → `{headersApplied: false, errorMessage}`（引擎报 "Provider runtime headers were not applied"，回合中止）

**授权推送 `pushAccountConfig`**：`provider/updateAccountConfig`，providers.access 仅接受
`{type:'zhipu-account', entitled:true}`（**strict 校验，多传 accountType/mode 被拒**）；
planKind 由引擎按 providerId 从内置配置解析。`basedOnZCodeBuiltinRevision` 必须等于
`zcode-builtin:<revision>:<sha256(内置配置绝对路径)>`，否则 RegistryService **静默跳过**。

### 2.3 引擎桥（ZcodeAgent）

- stdio ND-JSON；响应帧 `{id,result|error}`；通知帧 `session/event`；反向请求必须应答。
- 反向请求表：`session/requestRuntimePreferences`（关增强/关内存/自动解答）、
  `requestProviderRuntimeHeaders`（见上）、`interaction/requestPermission`（autoAnswer 分流）、
  `interaction/requestUserInput`（allow=自动采纳第一项）。
- 崩溃自动拉起（退避 `2s*count`，上限 15s）；`onReset` 向所有 SSE 订阅者发 `event: reset`。

### 2.4 会话注册表与 SSE 枢纽

```
sessionState(sid) = { subs:Set<res>, ring:[≤1000], busy, busySince, lastSend, lastSeq }
```

- `agent.onEvent`：更新 `lastSeq`；`turn.started`→busy=true+busySince；`tool.updated` 且 !busy
  →busy=true（**外部驱动回合的运行中标记**）；`turn.completed|failed`→复位；
  `turn.failed`→`scheduleRateLimitRetry`。
- `pushSse`：常规事件进 ring（重连重放 `afterSeq` 过滤）+ 直播订阅者；
  **`model.streaming` 例外：只直播不进环**（单回合百余 chunk，进环挤占 ring 且重放语义不对）。
- **delta 合帧（2026-10-04）**：`model.streaming`/`part.delta` 相邻同键 chunk 合并为一帧
  （60ms 或非 delta 事件到达时冲刷；键 = 助手消息 id+kind / 消息+部件+field）。严格 FIFO：
  只允许与队尾待发 delta 同键合并，其余事件先冲刷再入队，**顺序绝不重排**；合并帧携带
  首个 chunk 的 seq，重连重放语义不变。长回复 SSE 帧量从数千降到数十——手机蜂窝网络
  省流量，页面渲染不再碎片化。
- 事件语义速查：
  - `turn.started|completed|failed`：payload 含 `input`/`inputId`/`error`；
    **`inputId` 可打标记**（重试回显跳过的依据）
  - `part.started|upserted|delta`：协议部件事件（**legacy 通道回合期间不推文本部件**）
  - `tool.updated`（kind: scheduled/started/progress/result/error）：工具实时状态
  - `model.streaming`（**token 级直播**）：`{assistantMessageId, delta, kind: text_delta|reasoning_delta, done}`
  - `session.updated / titleUpdated / closed`
- SSE 端点：`GET /api/sessions/:id/stream?afterSeq=` —— 重放 ring + 订阅 + 15s 心跳；
  `event: zcode`（引擎事件）/`event: ui`（桥注入）/`event: reset`。

### 2.5 HTTP API

| 端点 | 要点 |
|---|---|
| `GET /api/state` | workspace/mode/**model**/autoAnswer/agentRunning（页面输入卡模型名来源） |
| `GET /api/workspaces`、`GET /api/sessions?workspace=|all=1` | 会话列表（含 `busy` 引擎侧标记、updatedAt） |
| `POST /api/sessions {sessionId?, workspace?}` | create/resume + **subscribe**（legacy 通道必须订阅才有事件）+ setModel（**必须带档位**）；响应含 `lastSeq/busy/busySince`（页面恢复运行态与增量订阅） |
| `GET /api/sessions/:id/messages?limit=` | limit 可覆盖（页面轻量探测用小值）；`Session is not active` = 未 resume |
| `GET /api/sessions/:id/stream` | SSE（见上） |
| `POST …/send|stop|close` | send 记录 `lastSend`（重试依据）；stop 取消待重试 |
| `GET …/goal|usage|settings`、`GET/POST /api/plugins…` | 计划/用量/设置快照/插件（引擎不支持时 `{unavailable}` 降级） |
| `POST /api/upload` | 附件落盘 `<workspace>/.zcode-uploads/`，消息以路径引用 |
| `POST …/model|thoughtLevel|mode` | 会话内切换；model 缺档位时回退当前配置档位 |

### 2.6 限流自动重试（scheduleRateLimitRetry）

- 触发：`turn.failed` 且错误匹配 `/\b429\b|rate[._ ]?limit/i`，且存在 5 分钟内的 `lastSend`。
- **`NO_RETRY_RE`：`\b1113\b|insufficient balance|…`（余额类）不重试**——重试永远不可能成功，
  直接推人话提示。
- 行为：至多 5 次、间隔 20s；重发 `inputId='__retry-<n>-<uuid>'`（页面据此跳过重复回显）；
  用户 stop / 新发送（lastSend 被替换）即取消。

### 2.7 已知边界（架构级）

- **桌面驱动回合**：无 SSE 事件（F2）、`updatedAt` 不变、engine `status` 恒 idle。
  页面只能靠轮询存储跟随（部件粒度、秒级），且**无 token 流**。
- **文本部件持久化节奏依引擎通道而异**：legacy 通道回合末才落库（流式观感全靠
  `model.streaming` 直播）；现引擎**部件粒度实时落盘**（即 F1），页面因此以部件通道
  为事实来源、token 直播仅作 legacy 兜底（见 §3.2）。
- **sqlite 直写**：清库操作绕过引擎直接删行（先备份、白名单、孤儿清理）；引擎不感知，
  会话列表以引擎重启后的实时查询为准。

---

## 3. 模块：Web 页面（public/index.html）

### 3.1 渲染模型

| 表 | 键 | 内容 |
|---|---|---|
| `msgEls` | messageId | `{el, bubble, parts:Map(partId→part), partEls:Map(partId→{kind,el,…})}` |
| `toolEls` | toolCallId | `{el(details), state, name, desc, body}` 扁平行：`[icon] 名称 命令摘要 状态图标` |
| `thinkTimers` | partId | 思考行起始时刻（收尾时结算"持续了 X 秒"） |

- `renderHistory`：全量清建（清 msgEls/toolEls/thinkTimers + 更新 `lastFingerprint`）。
- `renderTail`：增量渲染消息尾部（复用 ensureMsg/renderTextPart/ensureThink/toolCard），
  不清历史、不丢滚动——**轮询跟随与完成补绘专用**。
- `fingerprint`：最后一条 assistant 消息的 `id|role|parts.length|末部件type|status|text长度`。
- `turnLooksFinished/Running`：最后 assistant 消息末部件是否 `step-finish`。
- 工具行图标/名称按 toolName 映射（bash→终端、edit→编辑、grep→搜索…）；描述与名字相同则去重。
  **完成态保留行内摘要**（压暗 + 省略号截断，对齐官方桌面；此前隐藏导致"一屏终端✓看不出执行了什么"，
  2026-10-04 恢复，展开卡首行的补偿逻辑已删）。

### 3.2 事件处理（handleZcodeEvent / handleUiEvent）

- **会话守卫**：`ev.sessionId !== curSession` 的事件直接丢弃（切换瞬间旧流在途事件防串台）。
- `turn.started`：渲染用户回显（`inputId` 带 `__retry` 前缀则跳过——限流重试不重复出消息）。
- `part.*` / `tool.updated`：部件与工具行增量更新；活动事件触发"运行态推断"（见 3.3）。
- **`model.streaming`（逐字流式）**：现代引擎对同一回合**同时**发 token 直播与部件落库
  事件，页面以**部件通道为唯一事实来源**（对齐桌面官方）——`m.parts` 已有同类真实部件
  （或 DOM 已渲染）时 token 直播一律不创建/不再增长；直播块仅在 legacy 引擎（部件回合末
  才落库）兜底，落库副本追平直播块才交接（`settleLiveText`，与思考行同款去重）。
  流式 markdown 渲染 60ms 合帧（`streamRich`，权威渲染 `renderTextPart` 前 flush 防回闪）。
- `turn.completed/failed`：复位 + 从存储补一次尾部重绘（修正断流期间卡 running 的工具行）
  + `flushQueue()`；failed 对 1113/429 给人话文案。
- **回合结束分隔线**：`setBusy(false)` 统一收口——≥5 秒的回合在对话流末尾画
  "✓ 本轮结束 · 用时 X"（`.turnend` 虚线分隔）；`turn.failed` 置 `lastTurnFailed` 跳过
  （红字 errline 就是终点）。SSE 收尾与轮询推断收尾（桌面驱动回合）都生效。
- **本轮产出卡**：回合内**成功写出**的文件（Write/Edit 等带 file_path 且 completed）
  经 `addTurnArtifact` 去重收集（新回合清空），回合结束时在底部集中成卡片——
  文档/成果类（md/html/pdf/office/图片等，`DOC_ARTIFACT_RE`）直接平铺 chip（点击
  经 artifactBridge 打开查看器），代码/其他折叠为"另有 N 个"计数；随后才是结束分隔线。
- `ui` 事件：权限批准卡片（批准/拒绝按钮文案匹配 App 审批检测）、`note`（重试提示行）。

### 3.3 运行态状态机（核心不变量：任何运行态都必须能退出）

```
状态: busy(bool) + busySource('sse'|'inferred'|null)
时间戳: busySince(计时) lastActivity(存储变化) lastSseEventAt(流事件) finishedSince(收尾稳定)
```

置位路径：
1. SSE `turn.started` → `busySource='sse'`
2. 活动事件推断（`!busy && part/tool 事件`）→ `'inferred'`（错过 turn.started 的旁观回合）
3. openSession 恢复：server `busy/busySince` → 'sse'；存储末部件非 step-finish → 'inferred'
4. `doSend` 成功

收敛路径（全部以**存储**为事实源）：
1. SSE `turn.completed|failed|session.closed`
2. 轮询：`inferred` 且 step-finish **稳定 6 秒**（多步回合步骤间隙会短暂 step-finish，防误停）
3. 轮询兜底：busy 且 finished 且 **静默 30 秒**（SSE 无事件 + 存储无变化）→ 强制复位 + 尾部重绘
   ——覆盖"SSE 断流后 turn.completed 丢失"的永久转圈
4. 轮询兜底：`inferred` 120 秒无任何变化（回合异常中断）

App 桥（两代并存）：
- `notifyTaskState(running)` → `callHandler('onTaskState', {state:'running'|'settled', running, sessionId})`
  （现役 APK 只读 `state`；v2 读 `running`）
- **哨兵词**：`#turnStatus` 内 `Deep diving` 隐藏 span **仅 busy 期间存在于 DOM**
  （旧 APK 桥据 `[role=status][aria-live=polite]` 含哨兵词判定；常驻会让 App 永远"任务进行中"）

### 3.4 轮询跟随（1.2s）

- 探测 `messages?limit=10` → 指纹比对 → 变化才 `renderTail`；无变化走收敛判定。
- `document.hidden` 跳过（WebView 后台暂停定时器，回前台自动补）。
- `Session is not active` → `ensureResumed()`（30s 冷却，自动 resume 当前会话）。
- SSE `reset`（服务重启）→ 同样 `ensureResumed()`。

### 3.5 会话管理与串台防线（四道）

1. **openSeq 代际守卫**：引擎 resume 可达分钟级，快速切换时慢响应后到 → 非最新代际的结果
   直接作废（不渲染、不订阅）。
2. **事件会话守卫**：见 3.2。
3. **排队绑定会话**：`sendQueue.push({text, sid})`，补发仍归原会话（`doSend(text, sid)`）。
4. **boot 恢复优先级**：`busy 会话 > zcode.lastSession > 最近`——
   任务进度可见性 > 连续性 > 兜底（**顺序不能换**，lastSession 优先曾导致任务不可见的回归）。

openSession 同时：记录 lastSession、重置计时基准、按 server busy/存储恢复运行态、
`connectStream(sid, r.lastSeq)`（**增量订阅**，历史已渲染，避免全量重放文本重复）。

### 3.6 输入与排队

- 运行中输入 → 入队（绑定会话）→ 回合结束自动发出；队列药丸（官方"→"样式）可删。
- 附件：App 拍照/分享 → `pickImage(base64)` → 发送时先 `POST /api/upload` 落盘，消息带路径。
- 发送按钮形态：空闲=紫底↑发送；运行中=■停止（aria-label 同步切换，供语音桥识别）。

### 3.7 必须保持的桥接契约（改动页面时的红线）

| 契约 | 消费方 | 要点 |
|---|---|---|
| `[role=status][aria-live=polite]` 含哨兵词 `Deep diving`，**仅运行时存在** | taskBridgeJs（App 熄屏通知） | 常驻=永远"任务进行中" |
| `.fileMention` class + `title=完整路径` | artifactBridgeJs（成果点击/下载） | **页面 chip 不得 `stopPropagation`**——桥在 document 冒泡阶段接管（App 按 typeOfPath 分流查看器/下载，Windows 盘符路径由 Dart 侧 SFTP 兼容）；浏览器环境页面自行降级为复制路径 |
| `批准/拒绝` 短按钮文案 | taskBridgeJs 审批检测（≤12 字符正则） | |
| `window.__dshComposerBridge{insertText,send}` / `__dshPhotoBridge.pickImage` / `__zcode` v2 | App 注入桥 | |
| `data-composer-card` | artifactBridgeJs 放行 composer 点击 | |

### 3.8 外观主题与折叠态信息密度

- **主题**：偏好存 `localStorage['dshTheme']`（auto/light/dark）；根元素 `data-theme` 只落
  已解析的 light/dark，auto 档监听 `prefers-color-scheme` 实时切换。`<head>` 预应用脚本
  先于页面主体脚本落主题，首帧不闪错色。配色全部 CSS 变量化：深色为 `:root` 默认，
  浅色 `:root[data-theme=light]` 覆盖；代码块/行内代码/成果 chip/链接/按钮静默态/弹层
  阴影均走变量（新增硬编码颜色视为回归）；`color-scheme` 与 `<meta name="theme-color">` 随主题更新。
- **折叠态信息密度**（手机上"一屏占位符看不出在干嘛"的教训）：
  - 工具行完成态保留行内摘要（命令/目标文件/查询串，压暗 + 省略号）；
  - 思考行折叠态显示"持续了 X 秒"（仅真实直播过的思考有计时）+ 首行内容预览
    （`.tprev`，展开隐藏）；历史整段落库的思考无真实起始时刻，不冒充时长。
  - 回合结束有带用时的分隔线（见 3.2）——折叠信息三件套合起来保证对话流
    不看详情也能读出"想了什么 → 干了什么 → 结果如何 → 花了多久"。

---

## 4. 模块：DSH-Phone App（Flutter 侧，Zcode 模式相关）

### 4.1 TunnelService

- 连接时：SSH 会话 + 本地 `ServerSocket(localPort)`；**每条本地连接现场拨号
  `client.forwardLocal('127.0.0.1', _activeConfig.remotePort)`** —— 远端端口不在 SSH 会话里固化。
- `updateActiveConfig(config, profileIndex)`：就地换转发目标端口 → **模式切换免重连**
  （同实例 DSH 3080 ⇄ Zcode 8787 只是转发目标不同；App 只需重载 WebView 到新地址）。
- 吞吐：不做应用层节流（曾因"有界背压"计数只增不减限速至 267KB/s，已废弃）。

### 4.2 顶栏

- 模式切换：`IconButton(Icons.swap_horiz, color: Colors.green)`（与顶栏图标同款风格，绿色区分）；
  `_toggleMode` 保存配置 → `updateActiveConfig` → 重载页面，**不断开 SSH**。
- 实例切换：`_InstanceChip`（`Icons.dns_outlined` 服务器图标 + 连接状态色点，
  与模式切换图标区分）；点击弹菜单切换（含未配置跳设置）。
- 实例展示名 `SSHConfig.label`：别名 > 地址，**无前缀**（曾有的 `[Z]` 前缀已去除）。

### 4.3 注入桥（webview_bridges.dart，每次导航后重注）

| 桥 | 功能 | 页面侧配合 |
|---|---|---|
| taskBridgeJs | 扫 `[role=status]` 哨兵词 → running/settled；扫描批准按钮 → approval | 哨兵词仅运行时存在；`.ask` 卡片按钮文案匹配 |
| artifactBridgeJs | 点击成果（代码块/fileMention/路径文本）→ 查看/下载 | `.fileMention`+title、`data-composer-card` 放行 |
| composerBridgeJs | 找输入框注入/点发送 | 发送按钮 aria-label="发送/停止" |
| photoBridgeJs | base64 → File → drop 进附件槽 | 页面 `pickImage` 接住（非 DSH drop 路径） |
| terminalBridgeJs | xterm 按键条 | Zcode 页面无终端，仅 DSH 模式 |

`onTaskState` handler：`state` 字段 → TaskNotifier（running 常驻通知 / settled 完成通知 /
approval 高优通知）。页面 v2 通知与 DOM 桥**双通道并存**，通知 id 相同自然去重。

---

## 5. 问题档案（现象 → 根因 → 修复 → 验证）

| # | 现象 | 根因 | 修复 | 验证 |
|---|---|---|---|---|
| 1 | App 永远"任务进行中"，完成无通知 | 页面哨兵词常驻 DOM + v2 通知 `{running}` 格式 App 不认（只认 `{state}`） | 哨兵随 busy 出现/消失；通知双格式 | 熄屏通知状态与任务同步 |
| 2 | 刷新后看不到运行中任务 | boot 跳过 busy 会话 | 优先 busy；响应带 `busy/busySince/lastSeq` | 刷新即恢复运行态+计时 |
| 3 | 流式文本重复 | SSE 全量重放 delta 叠加 | 增量订阅（lastSeq）+ 重连 resync | 长回合无重复 |
| 4 | 换 z.ai 账户后建会话直接失败 | config.model 还指 bigmodel provider | 改 `account:zai-start-plan/GLM-5.3-Flash$max` | create 200 |
| 5 | 推理报 `1113 Insufficient balance` | standalone 独立计费 key 无余额；订阅额度挂在 oauth 凭据 | 凭据优先级改 start-plan `zcodejwttoken` | 推理 200 |
| 6 | "start-plan 无法复刻"（JWT 401 / defer 挂起） | 401 测试错用普通 access_token；defer 让引擎等不到 headers | 用 `zcodejwttoken` 直通（官方 L73-76） | 全链路 turn.completed |
| 7 | 一条消息连发两条 | 429 重试重发产生第二条回显 | `__retry` inputId + 页面跳过回显 | 单发单条 |
| 8 | 会话历史串台 | ① openSession 竞态（慢响应后到覆盖）②排队补发进错误会话 ③旧流在途事件泄漏 ④boot 落点漂移 | 代际守卫 / 排队绑定会话 / 事件会话守卫 / busy>lastSession>最近 | A→B 竞态测试稳定停 B；截图场景复现链路全堵 |
| 9 | 任务完成后永久转圈 | SSE 断流后 completed 丢失，`busySource='sse'` 使轮询跳过收尾；工具行卡 running | 存储事实源自愈：finished+静默30s 强制复位+补绘；completed 后补绘 | E2E busy true→false 收敛 |
| 10 | lastSession 优先导致任务不可见（#8 修复的回归） | 优先级顺序错误 | 恢复 busy 最优先 | 重载落在 busy 会话 |
| 11 | 正文出现紫色碎片 chip | 路径正则贪婪吞中文 | 字符集排除 CJK/全角 | 中文后缀不再匹配 |
| 12 | 服务重启后页面刷 `Session is not active` | 引擎丢会话、页面不重连 | ensureResumed（30s 冷却）+ reset 自动重连 | 重启后自愈 |
| 13 | 无流式输出（等回合结束一次性出） | `model.streaming` token 直播未被消费；文本部件回合末才落盘 | 页面消费 token 直播；服务端流式不进环 | 正文 11→128→234→278 字逐段增长 |
| 14 | 桌面任务列表里手机会话显示"新任务"、点开报 `Session is not active and not persisted` | 三个叠加：①引擎 `session/list` 对**本进程内**创建的会话 title 恒空（标题只写落库层 first_input，内存快照不回填），60s 对账把空标题同步进索引；②引擎会话存内存、**首回合完成才落库**——未落库就重启=会话彻底丢失（CLI 库/引擎列表双无），索引行成幽灵行，桌面点开必报错；③手机端直删会话后索引行残留（原"只增改不删"策略） | ①②③（server.mjs 桌面索引同步）：标题为空时从共享库 `session.title` 补齐；**未落库会话一律不 INSERT 索引行**（首回合完成→下一对账周期带真标题入索引）；新增 `cleanupGhostIndexRows`：手机侧工作区行既不在引擎列表也不在共享库、行龄>30min 即删除（宽限期保护桌面侧未落库活动草稿） | 重启后 task-sync 日志"清理幽灵行 10 条"；E2E：新会话回合完成→≤60s 索引带真标题（title==库 title 逐字节一致）；残留 2 条宽限期内幽灵行到期被清 |
| 15 | 对话过程大量重复输出（同一段正文两块同步增长） | 引擎对同一回合**同时**发 token 直播（model.streaming）与部件落库（part.upserted/delta），页面两路都渲染；思考行早有去重、正文漏了 | 部件通道唯一事实来源 + `settleLiveText` 追平交接 + `model.streaming` hasReal 守卫（含 m.parts 数据层） | 长回合正文单份、流式不重复 |
| 16 | 完成态工具行只剩"终端✓"，看不出执行了什么 | 此前为防命令刷屏用 CSS 隐藏 `.tool.completed .tdesc`（摘要数据一直在 inputSummary） | 恢复行内摘要（压暗+省略号），删配套"摘要补详情体"补偿逻辑 | 对齐官方桌面行样式 |
| 17 | 回合结束在手机上看不出特征（转圈消失太弱） | 结束唯一信号是 spinner 移除 | `setBusy(false)` 统一收口画回合结束分隔线（带用时；失败回合除外，见 3.2） | ≥5s 回合结束即出现结束线 |
| 18 | 思考行折叠后只剩"思考"两字，不知道想了多久/想了什么 | summary 只有图标+文字；时长计时对历史渲染的思考不准确 | summary 加时长 + 首行预览（`.tprev`）；存储整段落库的思考删计时器不冒充时长 | 折叠态可见"持续了 X 秒 + 首行" |
| 19 | 用户输入的消息也重复显示（不止输出） | part 处理器把一切部件事件当 assistant 画（`ensureMsg(mid,'assistant')` 写死）；现代引擎对用户输入文本部件也实时推 part 事件 → 回显之外再多一份副本 | 记录最近自己发出的输入（doSend/turn.started），part 事件命中即标记 `ownPart` 不渲染、就地纠正为 user 角色；`dropMatchingUserEcho` 扩展按文本对齐清理 ownPart 副本；ensureMsg 支持存储确认后的角色就地升级 | 输入单份、身份样式正确 |
| 20 | 页面自己"一抖一抖"（消息区高度反复变化+滚动跳动） | 四层叠加，全在消息区渲染热路径：①复制/分享操作行在每个部件事件/每次轮询都无条件迁移；②轮询 renderTail 对最近 10 条消息的正文**无条件整段清空重建**（markdown 全量重解析），哪怕内容未变；③操作行迁移的"持有者判断"挡不住轮询——renderTail 处理旧消息时把行从最新消息抢走再一路搬回；④streamRich 合帧定时器异步重绘改高度后无人对齐滚动 | ①操作行两道纪律：持有者真正变化才动 DOM + **非最新消息一律不迁移**（`msgs[last] !== m.el` 直接跳过）；②renderTextPart 内容未变（`pe.raw` 比对）直接跳过重建；③part.upserted/renderTail 的正文增长改走 streamRich 合帧（权威重建由回合收尾 renderTextPart 兜底，chips 不丢）；④合帧渲染后补 scrollBottom | 强刷后流式期间消息区无抖动（App 原生层月相/天气动效另计） |
| 21 | App（Zcode 模式）里点产出 chip 毫无反应，无法查看/下载；产出卡跨回合反复积累 | ①页面 fileChip 监听器无条件 `stopPropagation()`，而 artifactBridgeJs 挂在 document **冒泡阶段**——事件永远到不了桥；②各置 busy 路径都先改 busySince 再调 setBusy(true)，`!busySince` 清空条件永不触发，且旧产出卡不删除 | ①fileChip 检测到 `__dshArtifactBridge` 时直接放行（不拦截不阻断）；②产出收集改以 setBusy 的 false→true 真边界清空（wasBusy），新卡渲染前移除旧 `.turnarts` 卡；③richText 代码块补 `language-xxx` class 供 App 查看器识别语言；Windows 盘符路径由 Dart 侧 SFTP 兼容（tunnel_service 已有） | App 内点 chip 打开查看器/下载页；对话中只保留当轮产出卡 |

---

## 6. 验证方法库（本仓库迭代用）

- **SSE 捕获**：`curl -N …/stream?afterSeq=-1` 后台挂 45-60s，统计事件类型/时间分布。
- **页面状态采样**：浏览器 evaluate 读 `busySource/busy/lastFingerprint/msgCount/DOM 文本长度`。
- **竞态测试**：`openSession(A); openSession(B)` 不 await，断言最终停在 B 且首条消息一致。
- **存储手术**：动 `~/.zcode/cli/db/db.sqlite` 前**必须备份三件套**（db/-wal/-shm），
  白名单删除 + 孤儿行清理 + 残留复查；注意引擎 JSON 可能转义中文（LIKE 匹配假阴性，
  用 API 层解析定位再按 id 删）。
- **回归红线**：改动页面后核对 3.7 桥接契约表；改动 boot 后核对 3.5 优先级顺序。

## 7. 待办与风险

- **桌面驱动回合非流式**（F2 架构边界）：仅秒级跟随；若需对齐官方需直连桌面进程（外部合作）。
- `session/list` 的 `updatedAt` 对外部回合静止：列表级"运行中"识别依赖引擎侧 busy 推断
  （tool.updated 到达才置位）；引擎重启后、首轮工具事件前不可见。
- 双代 App 桥并存：APK 全量升级到 v2 后可移除 DOM 哨兵兼容（保留亦无害）。
- sqlite 直写维护脚本未沉淀为工具，手工操作需遵守第 6 节红线。
- `model.streaming` 直播不进环：断流重连后正文从断点续流，断点前文本待回合结束由存储补齐。
