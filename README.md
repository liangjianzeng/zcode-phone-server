# zcode-phone-server

ZCode 手机端桥接服务：在电脑上驱动 `zcode app-server`（ZCode Protocol stdio 协议），
封装成 token 鉴权的 HTTP/SSE 服务，并自带一套移动优先的聊天 Web 页面，
供 DSH-Phone 的 **Zcode 模式** 经 SSH 隧道访问。

> **新开发机请先读 [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md)**——架构图、
> 5 分钟启动、APK 构建联调、协议避坑手册与故障速查都在那里。
> 模块级设计、事件语义、踩坑档案见 [`docs/MODULE-DESIGN.md`](docs/MODULE-DESIGN.md)。

- **零 npm 依赖**，用项目自带 Node 22 运行（引擎需要 ≥22.5 的 `node:sqlite`）。
- **只监听 127.0.0.1**，绝不直接暴露公网；手机端走 SSH 隧道 / Tailscale。
- **与桌面端共存**：共享桌面 ZCode 的凭据与会话库，手机和桌面看到同一批会话、可互相旁观任务进度。

```
手机 App (DSH-Phone Zcode 模式)
   └─ SSH 隧道 → 127.0.0.1:8787 → zcode-phone-server（HTTP/SSE + 本 Web 页面）
        └─ stdio ND-JSON（ZCode Protocol）→ zcode.cjs app-server（ZCode 桌面引擎）
             └─ HTTPS → 模型提供方（Coding Plan）
```

## 服务端能力（server.mjs）

| 模块 | 说明 |
|---|---|
| 引擎桥 | stdio 驱动 app-server；凭据解析（start-plan `zcodejwttoken` 直通）、账号授权推送、全部反向请求应答（权限/提问/请求期鉴权）；崩溃自动拉起（退避 ≤15s），`event: reset` 通知页面重连 |
| SSE 枢纽 | 每会话订阅者集合 + ≤1000 事件重放环（断线按 `afterSeq` 续传，15s 心跳）；`model.streaming` 只直播不进环 |
| **delta 合帧** | `model.streaming`/`part.delta` 相邻同键 chunk 合并成一帧（60ms 或非 delta 事件到达时冲刷），严格 FIFO 不重排——长回复从几千个 SSE 帧降到几十帧，手机蜂窝网络省流量、页面渲染不再碎片化 |
| 发送队列 | 引擎 `session/send` 单飞（运行中 409）：运行中收到的消息入队（绑定会话、可取回删除），回合结束后自动补发为下一回合；桌面驱动的回合按共享存储核实收尾后补发 |
| 限流自动重试 | `turn.failed` 匹配 429/限流时自动重发（5 次 × 20s，`__retry` inputId 防重复回显）；1113/余额类错误不重试，直接推人话提示 |
| 桌面任务索引同步 | 会话标题/状态按共享 sqlite 库对账进桌面任务索引（标题为空不落库、幽灵行 30 分钟清理），桌面任务列表与手机会话一致 |
| 页面自更新 | `index.html` 内容 md5 指纹经 `/api/state` 下发，页面轮询比对自动 reload——**改完页面无需重启服务、无需手机手动刷新** |
| 静态服务 | `public/` 每请求读盘；token 鉴权（query `?token=` / header `x-zptoken` / cookie） |

## Web 页面能力（public/index.html）

自研移动聊天页（非官方 UI），但刻意遵守 DSH-Phone 的 DOM 桥接契约（见下）：

- **双通道跟随**：SSE 实时事件 + 1.2s 存储轮询，桌面端驱动的回合（无 SSE）也能近实时旁观。
- **部件通道为唯一事实来源**：正文/思考按部件落库事件渲染；token 直播块仅在部件未落库时兜底显示，落库追平即交接（`settleLiveText`），**杜绝直播/落库双份重复**；流式 markdown 渲染 60ms 合帧，长回复不掉帧。
- 工具行（图标 + 名称 + 命令/目标摘要 + 状态，点开看输出）、思考行（可展开）、任务计划条（todos 实时）、提问/权限卡片、排队药丸、附件上传。
- **回合结束分隔线**：≥5 秒的回合结束在对话流末尾显示"✓ 本轮结束 · 用时 X"（失败回合显示红字 errline，不重复画线）。
- **外观主题**：左侧栏 ☀ → 跟随系统（实时 matchMedia）/ 浅色 / 深色，localStorage 持久，首帧预应用不闪错主题。
- 断线自愈：SSE 断流、服务重启（`event: reset`）、引擎丢会话均自动 resume；任何运行态都能收敛退出（不会永久转圈）。

## 启动

```bat
zcode-phone-server\start.bat
```

首次启动自动生成访问令牌并写入 `config.json`，控制台会打印本机访问地址：

```
http://127.0.0.1:8787/?token=<token>
```

浏览器打开即可自测聊天链路；手机端在 App 里选 Zcode 模式、远端端口填 `8787`。
安全重启（等待会话空闲后杀进程树再拉起）：`bash restart_server.sh`。

## 配置（config.json）

| 字段 | 说明 | 默认 |
|---|---|---|
| `port` | 监听端口（仅 127.0.0.1） | `8787` |
| `token` | 访问令牌（≥16 字符，空则自动生成） | 自动 |
| `workspacePath` | 会话工作目录（项目根） | 仓库根 |
| `workspaces[]` | 多工作区白名单（会话列表可跨区） | — |
| `mode` | 新会话权限模式 `plan/build/edit/yolo` | `yolo` |
| `model` | 模型选择 `providerId/modelId$reasoningLevel`（**必须带档位**） | — |
| `autoAnswer` | agent 反向交互自动应答：`allow`=自动放行/自动选第一项；`ask`=转发手机端人工处理 | `allow` |
| `nodePath` | Node 可执行文件（≥22.5） | `tools/node22/node.exe` |
| `zcodePath` | ZCode 引擎 zcode.cjs 路径 | 桌面端安装路径 |
| `builtinProviderConfigPath` | 内置 Provider 规则（必须指桌面端 `zcode-builtin.json`） | 桌面随包路径 |
| `maxHistoryMessages` | 历史消息默认拉取条数 | `200` |

## HTTP API（全部需 token，query `?token=` 或 header `x-zptoken`）

| 方法/路径 | 说明 |
|---|---|
| `GET /api/state` | 服务状态 + 页面构建指纹（`pageBuild`，自动 reload 依据） |
| `GET /api/workspaces` | 工作区列表 |
| `GET /api/sessions`（`?workspace=|all=1`） | 会话列表（含 `busy/busySince/lastSeq`，页面恢复运行态用） |
| `POST /api/sessions` `{sessionId?, workspace?}` | 创建新会话；带 `sessionId` 则恢复（+ 订阅 + setModel） |
| `GET /api/sessions/:id/messages?limit=` | 历史消息（MessageWithParts，部件粒度） |
| `GET /api/sessions/:id/stream?afterSeq=` | SSE 实时事件流（重放环 + 心跳 + `event: reset`） |
| `POST /api/sessions/:id/send` `{content}` | 发送消息（运行中自动入队） |
| `POST /api/sessions/:id/stop` | 停止当前回合 |
| `POST /api/sessions/:id/close` | 关闭会话 |
| `GET /api/sessions/:id/todos` | 任务计划（TodoWrite 落库状态） |
| `GET /api/sessions/:id/settings` | 会话设置快照（模型/思考档位/权限模式） |
| `POST /api/sessions/:id/model` \| `thoughtLevel` \| `mode` | 会话内切换模型/思考档位/权限模式 |
| `POST /api/interactions/:requestId` | 应答权限/提问（`autoAnswer: "ask"` 时使用） |
| `POST /api/upload` | 附件落盘 `<workspace>/.zcode-uploads/`，消息以路径引用 |
| `POST /api/autoAnswer` | 运行时切换 autoAnswer |
| `GET/POST /api/plugins`、`/api/plugins/setEnabled` | 插件列表 / 启停 |
| `GET /api/skills`、`/api/workflows` | 技能 / 工作流（项目 + 全局合并） |
| `GET /api/plan`、`/api/usage-stats` | 订阅计划 / 模型用量统计 |

## 事件流（SSE `zcode` 事件）

透传 ZCode Protocol 的 session/event：`turn.started / turn.completed / turn.failed /
message.upserted / part.started / part.delta / part.upserted / tool.updated /
permission.requested / userInput.requested / session.titleUpdated / ...`
（`model.streaming` 为 token 级直播，经 60ms 合帧后下发，不进重放环。）

Web UI 的 DOM 特意保留了 DSH-Phone 桥接约定，App 端 Zcode 模式可复用原桥脚本：

- 运行状态条：`role="status" aria-live="polite"`，文本含哨兵词 **Deep diving**（仅运行时存在）
- 审批按钮：短文案 **批准 / 拒绝**
- 成果 chip：`class="fileMention"` 且 `title="<完整路径>"`
- 输入框：原生 `<textarea id="composer">`（composerBridgeJs 可直接注入）
- 发送按钮：`aria-label` 在 发送/停止 间切换（语音桥识别）

**改动页面时必须维持以上契约**，否则 App 端对应功能静默失效（完整红线表见 MODULE-DESIGN §3.7）。

## 协议依据

开源仓库 [zai-org/ZCode](https://github.com/zai-org/ZCode)：

- `packages/shared/src/zcode-protocol/index.ts` — 方法表与全部 zod schema
- `packages/shared/src/zcode-protocol-legacy-types.ts` — workspace/消息/工具状态
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts` — 服务端语义
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/interaction-broker.ts` — 反向交互应答格式
