# zcode-phone-server

ZCode 手机端桥接服务：在电脑上驱动 `zcode app-server`（ZCode Protocol stdio 协议），
封装成 token 鉴权的 HTTP/SSE 服务，供 DSH-Phone 风格手机端经 SSH 隧道访问。

- **零 npm 依赖**，用项目自带 Node 22 运行（引擎需要 ≥22.5 的 `node:sqlite`）。
- **只监听 127.0.0.1**，绝不直接暴露公网；手机端走 SSH 隧道 / Tailscale。

## 启动

```bat
zcode-phone-server\start.bat
```

首次启动自动生成访问令牌并写入 `config.json`，控制台会打印本机访问地址：

```
http://127.0.0.1:8787/?token=<token>
```

浏览器打开即可自测聊天链路；手机端在 App 里选 Zcode 模式、远端端口填 `8787`。

## 配置（config.json）

| 字段 | 说明 | 默认 |
|---|---|---|
| `port` | 监听端口（仅 127.0.0.1） | `8787` |
| `token` | 访问令牌（空则自动生成） | 自动 |
| `workspacePath` | 会话工作目录（项目根） | 仓库根 |
| `mode` | 新会话权限模式 `plan/build/edit/yolo` | `yolo` |
| `autoAnswer` | agent 反向交互自动应答：`allow`=自动放行/自动选第一项；`ask`=转发手机端人工处理 | `allow` |
| `nodePath` | Node 可执行文件（≥22.5） | `tools/node22/node.exe` |
| `zcodePath` | ZCode 引擎 zcode.cjs 路径 | 桌面端安装路径 |

## HTTP API（全部需 token，query `?token=` 或 header `x-zptoken`）

| 方法/路径 | 说明 |
|---|---|
| `GET /api/state` | 服务状态 |
| `GET /api/sessions` | 会话列表（最近 50 条，按更新时间排序） |
| `POST /api/sessions` `{sessionId?}` | 创建新会话；带 `sessionId` 则恢复 |
| `GET /api/sessions/:id/messages` | 历史消息（MessageWithParts） |
| `GET /api/sessions/:id/stream?afterSeq=` | SSE 实时事件流（含断线重放） |
| `POST /api/sessions/:id/send` `{content}` | 发送消息（运行中返回 409） |
| `POST /api/sessions/:id/stop` | 停止当前回合 |
| `POST /api/sessions/:id/close` | 关闭会话 |
| `POST /api/interactions/:requestId` | 应答权限/提问（`autoAnswer: "ask"` 时使用） |

## 事件流（SSE `zcode` 事件）

透传 ZCode Protocol 的 session/event：`turn.started / turn.completed / turn.failed /
message.upserted / part.started / part.delta / part.upserted / tool.updated /
permission.requested / userInput.requested / session.titleUpdated / ...`

Web UI 的 DOM 特意保留了 DSH-Phone 桥接约定，App 端 Zcode 模式可复用原桥脚本：

- 运行状态条：`role="status" aria-live="polite"`，文本含哨兵词 **Deep diving**
- 审批按钮：短文案 **批准 / 拒绝**
- 成果 chip：`class="fileMention"` 且 `title="<完整路径>"`
- 输入框：原生 `<textarea id="composer">`（composerBridgeJs 可直接注入）

## 协议依据

开源仓库 [zai-org/ZCode](https://github.com/zai-org/ZCode)：

- `packages/shared/src/zcode-protocol/index.ts` — 方法表与全部 zod schema
- `packages/shared/src/zcode-protocol-legacy-types.ts` — workspace/消息/工具状态
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts` — 服务端语义
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/interaction-broker.ts` — 反向交互应答格式
