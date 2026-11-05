# ZCode 桌面前端 vs 手机端 Web UI · 差异比对分析

> 生成：2026-11-05。参照源码快照见 §1。本文是差距清单与实施依据，配合 `MODULE-DESIGN.md` 阅读。

## 7. 试实施总结（2026-11-05，巡检自动化收口）

**G1–G14 全部完成**（G15 为后续追加的流式体验完善批次），每项均有代码证据与实测记录（见 §5 状态列）。落地能力：

- **G1** Edit/Write 工具 diff 视图（行级 LCS 红绿 + 统计头，三路渲染同口径）
- **G2** 提问卡升级（多问题/多选/自定义输入/拒绝，协议 answers 映射）
- **G3** 权限卡升级（始终拒绝 + 理由 + 引擎 options 透传）
- **G4** 会话内查找（高亮/计数/跳转/清场，渲染管线安全）
- **G5** 子代理嵌套渲染（实时事件路）+ 状态条运行计数
- **G6** server 三桥（subagents / usageStats / cancelBackgroundTask）
- **G7** 验证闭环（语法闸 + 安全重启 + 真机 400×850 浏览器实测 0 JS 错误）
- **G8** 存量 bug 修复：历史工具行 callID 折叠（1 行 → 38 行）
- **G9** 侧栏置顶区 + 未读圆点（共享任务索引只读对齐）
- **G10** Token 构成分段条 + 缓存命中率（turn_usage 聚合）
- **G11** 队列相邻重排（↑↓ + queue/move，与既有 ✎⚡✕ 组成完整队列管理）
- **G12** 检查点回滚能力探测（stdio=legacy 面无 v4；可达能力已覆盖，差距定性为通道差异）
- **G13** mermaid 图 + KaTeX 公式渲染（vendor 惰性加载、深色主题、复制/折叠契约保持；顺带修复 token 门拦截子资源问题）
- **G14** 离线推送核验（设施早已存在）+ 失败回合专属通知「DSH 任务失败」（页面侧即时生效；**APK 已重打包生效**——安装 Flutter 3.29.0 并行副本后 `flutter build apk --release` 成功出包 22.5MB）
- **G15** 消息区流式体验完善（2026-11-06，对照桌面 v4 timeline 逐项补齐）：回到底部悬浮按钮（+新内容圆点）、可视回合状态行（活动文案+秒表，对照桌面 ChatLoading）、工具运行输出 live-tail（60ms 合帧+末 12 行）、流式尾部光标、切会话滚动位记忆、长会话 content-visibility、流式 remendLite 未闭合 markdown 补全

**明确暂缓**：无。~~mermaid/数学公式~~ → G13 已实现；~~离线推送~~ → G14 核验：设施早已存在，本轮补齐 task_failed 区分。

**遗留边界**：真实队列 E2E 需 busy 会话（本轮以 404 回退链路 + 同构模式验证）；mark-read 写回涉桌面 CAS 语义（保持只读）；V4 通道（文件回滚预览/输入预测等）待 bridge 架构升级。

桥接红线全程保持：哨兵词 Deep diving 仅运行时存在、批准/拒绝短文案、.fileMention class+title、composer 桥、data-composer-card。

## 1. 参照物与来源

| 资产 | 位置 | 说明 |
|---|---|---|
| 官方完整源码快照 | `E:\zcode-repo` | gitcode.com 镜像 `zai-org/ZCode`（2026-10-30，17203 文件）。GitHub 主干被裁剪（只有 `apps/zcode-cli`），**gitcode 快照含全部 `packages/`**：desktop/web/ui/client/server/shared 等 |
| 桌面构建产物 | `E:\zcode-src-desktop` | 本机安装版 3.17.2 的 `app.asar` 解包（`out/renderer` 等），与快照同代可互证 |

桌面 UI 技术栈：React 19 + zustand + Lexical（输入器）+ streamdown（流式 markdown，CJK/代码/数学/mermaid 插件）+ shiki/highlight.js + `@pierre/diffs` + `@tanstack/react-virtual` + xterm。聊天应用代码几乎全部在 `packages/ui/src`（`App.tsx` 为入口，`v4/` 为当前主聊天视图，`ToolCallBlocks/renderers/` 约 50 个工具渲染器）。

## 2. 架构对比

| 维度 | 官方手机端（web-remote-control） | 本项目（zcode-phone-server） |
|---|---|---|
| 链路 | 手机浏览器 → 外部 relay（鉴权/配对/透传）→ 桌面 main → 共享 Window Host → 同一 CLI runtime | 手机 App(WebView) → SSH 隧道 → 本机 HTTP/SSE → stdio app-server（同一引擎与共享库） |
| UI | **同一套 V4 会话组件**（`packages/ui`）+ 移动两页壳（首页/聊天） | 自研轻量单页 `public/index.html`（零依赖） |
| 连接身份 | `web-remote-replayable`（快照/补帧恢复） | SSE 重放环（≤1000 事件）+ 1.2s 存储轮询双通道 |
| 输入 | 端到端单一 `CommandInbox` FIFO，命令可查询对账（`commands/query`） | 服务端单飞发送队列（绑定会话、可取回删除、回合结束补发） |

结论：两条路线同构（手机都是 replayable 观察者 + 轻量命令通道）。官方能力对齐靠**组件复用**，我们的对齐路径 = 在 index.html 内逐功能补齐桌面聊天面。官方移动端设计文档（`E:\zcode-repo\docs\web-remote-control\`）是直接参考：5 类事件推送（question/approval/plan/task_completed/task_failed）、快照字节预算、单一命令队列、输入 admission。

## 3. 协议面盘点

- 引擎 legacy 方法表（`packages/shared/src/zcode-protocol/index.ts`）全集 50 个；`server.mjs` 已桥 **24 个**（session/send|list|close|stop|setModel|setThoughtLevel|setMode|event|usage|subscribe|resume|requestRuntimePreferences|read|messages|goal|fork|create|compact、provider/updateAccountConfig、plugins/list|setEnabled、skills/referenceCatalog、workflows/list）。
- **未桥缺口**：`session/subagents`（子代理列表）、`session/cancelBackgroundTask`（后台任务控制）、`usage/stats`、`provider/testModelConnectivity`、`workspace/generateText`、`plugins/*` 其余（install/update/validate…）、`workflows/save|run|runs`。
- V4 wire（`packages/shared/src/zcode-protocol-v4/`）新增语义：`conversation/rowsRange`（分页行）、`fileChanges`（服务端文件变更投影）、`fileRewindPreview`（检查点回滚预览）、`inputPrediction`、`backgroundBashOutput`、`usage/stats`、attachment 分片上传（begin/chunk/commit/abort）。
- 嵌套工具调用：`parentToolUseId` 只存在于**事件流元数据**（`server-operations.ts` `readProtocolStreamingParentToolUseId`：`payload.parentToolUseId|parentToolCallId|_meta.zcode.parentToolUseId|_meta.claudeCode.*`），**共享库落库 part 不含**（已实测 db.sqlite）。→ 嵌套渲染走实时事件路，历史平铺。

## 4. 差距清单

### P0 核心聊天体验（本轮实现）

| # | 能力 | 桌面证据（`packages/ui/src`） | 我们现状 | 实现路径 |
|---|---|---|---|---|
| 1 | Edit/Write 工具 **diff 视图** | `ToolCallBlocks/renderers/edit.tsx`（EditInlineDiffContent）、`components/ui/diff-viewer.tsx` | 只显示 output 文本 | index.html：解析 `state.input` 的 old_string/new_string（Edit）/content（Write），行级 LCS 红绿渲染 |
| 2 | 提问卡（AskUserQuestion）**多问题/多选/自定义** | `ElicitationDialog.tsx`（normalizeElicitationQuestions、倒计时） | 平铺选项，单题 `content.answer`，无多选/自定义/拒绝 | 重写 userInput 卡：按题分区、multiSelect 复选、自定义输入、拒绝按钮、按题 answers 映射 |
| 3 | 权限卡 **始终拒绝 + 拒绝理由** | `PermissionDialog.tsx`（deny-always、freeText 理由） | 只有 批准/始终允许/拒绝 | 加"始终拒绝"（permissionUpdates deny rules）+ 可选理由输入（deny.reason） |
| 4 | **会话内查找** | `quickpick/TaskFindDialog.tsx`、`v4/conversationFindHighlightDom.ts` | 无 | index.html：查找栏 + 高亮 + 上/下一个 + 计数 |
| 5 | **子代理嵌套渲染** | `ToolCallBlocks/renderers/agent.tsx`、`v4/SubagentDrilldown.tsx`、`ConversationStatusPanel.tsx`（运行中子代理打开） | 平铺；无子代理列表 | 实时事件路：payload 元数据 parentToolUseId → 挂父 agent 行展开体内；状态条显示子代理计数 |

### P1 重要可分批

| 能力 | 桌面证据 | 说明 |
|---|---|---|
| 检查点回滚 | `components/ai-elements/checkpoint.tsx`、`ConversationFileRewindDialog.tsx` | 依赖 V4 fileRewindPreview + rewind 语义；legacy 引擎只有 session/fork(target)。先文档化 |
| 队列管理增强 | `ConversationQueuePanel.tsx`（重排/编辑/附件） | 我们已有删除；重排/编辑后续可加 |
| 上下文用量分段 | `chat-input-toolbar/contextUsage.tsx`（token 分段、缓存命中、/compact） | 已有 ctx 环 + 用量 sheet；可加 input/output/cache 分段条 |
| 数学公式/mermaid | streamdown `@streamdown/math|mermaid`（KaTeX/mermaid 库） | 零依赖约束 + SSH 内网离线；需 vendor 库，单独评估 |
| 推送通知（离线） | `docs/web-remote-control/mobile-event-push.md`（5 类事件） | 需要 Flutter 侧系统通知 + server 事件分类；独立批次 |
| 置顶/未读/拖拽排序 | `useProjectPinIntent.ts`、`useProjectUnreadSignals.ts`、SortableProjects | 侧栏增强，读任务索引标志位即可做置顶 |
| 服务器文件变更投影 | `v4/conversation/fileChanges` | 我们前端回合内统计 Write/Edit；服务端投影更准（含 Bash 侧写文件），后续桥 |

### P2 桌面特有（移植价值低）

多窗口/分屏工作台（WorkbenchPane/paneLayout）、Git 面板/提交图、xterm 终端、browser-use 视口、CUA 截图面板、白板/Treemapping、模型轨迹查看器（ModelTrajectory*）、插件沙箱侧板、自绘标题栏、高速模式扩散动画、反馈中心、Onboarding、Stripe 购买。

> 已有可复用官方移动资产：`packages/ui/src/components/mobile-ui/`（bottom-sheet 等）、`WebRemoteControlMobileShell.tsx`、`packages/web-share`（分享只读页）。

## 5. 试实施计划目标（G1…G7，逐项带验收标准）

> 执行约定：每 30 分钟巡检一次完成度（自动化任务），未完成项继续实施；已完成项须有可复现证据。
> 红线：`MODULE-DESIGN §3.7` 桥接契约（哨兵词 Deep diving / 批准拒绝短文案 / .fileMention / composer 桥 / data-composer-card）任何改动不得破坏。

| 目标 | 内容（对照差距清单 §4） | 验收标准 | 状态 |
|---|---|---|---|
| **G1** | Edit/MultiEdit/Write 工具 **diff 视图**（行级红绿 + 统计头 + 文件 chip，三路渲染口径统一） | ① Edit 会话历史里点开 Edit 工具行可见红绿 diff 与 `+N −M` 统计；② Write 新文件显示全绿；③ 深浅主题色彩正确；④ 无 ×N 重复（callId 去重不回退） | ✅ 已实现（`fillToolBody`/`buildDiffBlock`/`lineDiffRows`，2026-11-05） |
| **G2** | **提问卡升级**：多问题分区、选项描述、multiSelect 复选、每题自定义输入、拒绝按钮 | ① 多题请求按题分区提交 `content.answers{题干:答案}`；② 单题选项即点即答路径不回归；③ 拒绝按钮发 `{action:'decline'}`；④ 按钮文案不破坏 App 审批检测 | ✅ 已实现（`userInput.requested` 重写） |
| **G3** | **权限卡升级**：始终拒绝（deny 规则）+ 拒绝理由输入 + 引擎原生 options 透传 | ① 始终拒绝携带 `permissionUpdates addRules behavior:'deny'`；② 理由为空时兜底"用户拒绝"；③ 批准/拒绝短文案按钮仍存在（契约） | ✅ 已实现（`buildPermissionCard`） |
| **G4** | **会话内查找**：侧栏入口 + 顶置查找栏（高亮/计数/上下跳转/关闭） | ① 输入即筛（220ms 防抖）≤500 处命中；② Enter/↑↓ 跳转并居中；③ renderHistory/renderTail 重绘前清高亮不悬空；④ 浅深主题可读 | ✅ 已实现（`miFind`+`#findBar`） |
| **G5** | **子代理嵌套渲染 + 运行计数**：实时事件 parentToolUseId 挂父卡；状态条"N 个子代理" | ① tool.updated/payload 元数据任一命名变体可识别；② 历史渲染不受影响（落库无此字段，平铺）；③ 引擎无该方法时 15s 节流查询自动停用 | ✅ 已实现（`eventParentToolUseId`/`refreshSubagentNote`） |
| **G6** | **server.mjs 补桥**：`session/subagents`、`usage/stats`、`session/cancelBackgroundTask` 透传端点 | ① GET `/api/sessions/:id/subagents|usageStats` 失败降级 `{unavailable}`；② POST `.../cancelBackgroundTask` 校验 taskId 必填；③ `node --check` 通过 | ✅ 已实现 |
| **G7** | **验证闭环**：语法检查 + 安全重启 + 页面自测（无 JS 错误、新功能可见、既有能力不回归） | ① 两段内联脚本 `new Function` 通过；② restart_server.sh 平滑重启成功、`/api/state` 健康；③ 浏览器实测：查找栏可开、diff 可见、桥接哨兵词/审批按钮存在 | ✅ 已验证（2026-11-05：语法过、重启 HTTP 200、真机 400×850 视口实测 0 JS 错误，工具行 38、diff 8 个、查找 4/4 命中跳转/清场正常，diff 卡截图确认 `+27 −0 新文件` 红绿样式） |
| **G8** | **存量 bug 修复（验证中发现的必改项）**：共享库直查部件为引擎原样 `callID`（大写），页面读 `part.callId`——历史渲染全部工具行折叠成一个 `undefined` 键（实测 681 个 Edit 部件的会话只渲染 1 行工具）。服务端（本地+远端 node/python reader 三处）归一化 `callId`，页面三处渲染点加 `part.callId ?? part.callID ?? 'p'+partId` 键兜底 | ① 同一会话工具行数量与部件数一致（修复前 1 行 → 修复后 38 行）；② SSE 与历史两路键一致不重复计数 | ✅ 已修复并实测验证 |
| **G9** | **侧栏置顶/未读增强**（桌面证据 `project-sidebar/grouped-view.ts`：置顶独立分区 `selectProjectRows({kind:'pinned'})`、未读 `unread_at` 圆点；数据源共享任务索引 `tasks.pinned/unread_at/last_unread_at`）：服务端 groups 带出 `pinned/unreadAt`，置顶会话剔除普通分组、单列「已置顶」区（order -1 排首），会话行渲染未读蓝点 | ① 桌面置顶的会话手机置顶区可见（当前索引 0 条置顶=空区不显示，符合桌面空态）；② 未读圆点随索引标记出现（实测 85 条带标记）；③ 分组折叠/计数/搜索不回归；④ 只读展示——桌面 mark-read 带 `expectedUnreadAt` CAS，手机不直写 | ✅ 已实现（server groups + 页面 pinrow/udot，语法过、重启后实测） |
| **G10** | **上下文用量分段条**（桌面证据 `chat-input-toolbar/contextUsage.tsx` + `components/ai-elements/context.tsx`：input/output/reasoning/cache 分段与缓存命中率）：新增 `GET /api/sessions/:id/usageBreakdown`（共享库 `turn_usage` 会话聚合），用量弹层新增「Token 构成」——五段占比条（缓存读/输入/缓存写/输出/思考，色走主题变量）+ 图例 + 缓存命中率 | ① 分段条随回合增长（turn_usage 聚合）；② 命中率 = cacheRead/(input+cacheRead+cacheWrite)；③ 空会话/库不可用降级不阻塞弹层其余部分；④ 主题变量配色，深浅主题自动切换 | ✅ 已实现并实测（2026-11-05：本会话 3 回合，分段 49.7%/50.1%/1.5%，命中率 50%，截图确认与套餐/容量同屏呈现） |
| **G11** | **队列重排**（桌面证据 `v4/ConversationQueuePanel.tsx`：排队消息可重排/编辑/立即发送）：服务端补 `POST queue/move`（相邻交换，越界钳制 no-op），排队药丸新增 ↑↓ 按钮（越界侧不渲染）。已有能力对齐：✎ 取回编辑（`queue/replace` 原位插回）、⚡ 立即发出（`queue/send-now`）、✕ 删除 | ① move 后服务端推 `__ui:'queue'` 全端对账；② 越界 no-op 不报错；③ 药丸过期（404）时 refreshQueue 对齐；④ 手机无拖拽——相邻移动为移动端等价实现（官方语义=可调序） | ✅ 已实现并实测（2026-11-05：按钮边界 ↓✎⚡/↑↓✎⚡/↑✎⚡ 正确；404→refreshQueue 清场链路通；真实队列 E2E 需 busy 会话，端点逻辑与 queue/remove 同款已验证模式；另发现：重启后引擎会话未激活时 send 被拒不入队——无副作用，属引擎正常边界） |
| **G12** | **检查点回滚能力探测**（桌面证据 `ConversationFileRewindDialog.tsx` + `v4/conversation/fileRewindPreview`）：探测本机引擎（zcode.cjs 3.17.2，15.4MB）的回滚面——二进制含 `fileRewindPreview×4 / targetCheckpointId×14 / checkpointId×18`；对照 `packages/server/src/entry-stdio.ts`+`stdio.ts`：**stdio app-server 是 legacy 方法表，无 v4 路由**——`v4/conversation/fileRewindPreview`（文件回滚预览）与破坏性 rewind 不可达；legacy 面可达 = `session/fork` target `{kind:"latestCheckpoint"}` / `{kind:"checkpoint",checkpointId}` / `{kind:"message",messageId}` | ① 探测结论有源码/二进制双重证据；② 手机已覆盖可达能力：消息分叉 + 缺省最近检查点分叉（现有 fork 端点）；③ 文件级回滚预览记为「V4 通道专属，stdio 架构不可达」，与桌面差距收敛到官方 transport 差异，留待未来 bridge 升级 V4 | ✅ 探测完成（结论：无需 UI 改动，差距定性为通道差异而非功能缺失） |
| **G13** | **mermaid 图 + 数学公式渲染**（桌面证据：streamdown `@streamdown/math\|mermaid` = KaTeX/mermaid 插件；原「vendor 违背零依赖」暂缓项经用户"继续"授权重开）：vendor 官方库（npmmirror mermaid@11.12.2 UMD + katex@0.16.22，共 3.3MB 入 `public/vendor/`，仅 woff2 字体）；页面 `enhanceChatRich` 惰性增强——首次出现内容才动态加载、失败静默降级原文；mermaid 图 + 「查看源码」折叠（保留语言 class 与复制按钮）；KaTeX 支持 `$$…$$`/`\[…\]`/`\(…\)`，**刻意不支持裸 `$…$`**（防 $5/$10 价格误渲染，与桌面 markdown 安全口径一致）。服务端两处配套：MIME 补 woff2/woff/ttf/mjs；**token 门豁免 `/vendor/` 前缀**（字体由 CSS `url()` 触发无法带 token；无用户数据 + 127.0.0.1 绑定 + PUBLIC_DIR 前缀守卫仍在） | ① 真实 Chromium（本机 Chrome headless，与手机 WebView 同引擎家族）CDP 驱动 index.html 全管线：mermaid SVG+4 节点、KaTeX 3 式、KaTeX_Main 字体加载 true、复制/折叠契约在、0 JS 错误；② 截图确认深色主题图文正确；③ 安全边界：vendor 200 / api 仍 401；④ 未 vendor 场景降级为原文（loadLib 失败缓存，不重复重试） | ✅ 已实现并实测（2026-11-05；验证中修复 token 拦子资源问题；开发用 IAB 拦子资源属宿主环境特性，不代表手机 WebView） |
| **G14** | **离线推送核验 + task_failed 区分**（官方推送五类事件 question/approval/plan/task_completed/task_failed）：勘察发现推送设施**早已端到端存在**——TaskNotifier（HIGH+PUBLIC 通道、锁屏可见）+ 双层桥（页面直推 `notifyTaskState→onTaskState` + APK 注入 taskBridgeJs 扫哨兵词/审批按钮）+ 前台服务保活；本轮补齐唯一缺口：回合**失败**与完成区分——页面 `notifyTaskState` 结算时按 `lastTurnFailed` 发 `state:'failed'`、`setBusy(false)` 写 `#turnStatus[data-result]`，APK 侧 taskBridgeJs 读 data-result、新增 `showFailed()`（「DSH 任务失败」+耗时）与 handler 分派 | ① 页面语法闸过；② 我改的三个 dart 文件 analyze 零问题（14 个既有错误全在 foreground_service.dart，系 pub 环境过期：本机 Flutter 3.27 vs lockfile 需 3.47.9，与本次无关）；③ 旧版 APK 兼容：handler 无 default，'failed' 静默忽略（页面直推层）；但旧 APK 内嵌 DOM 桥仍会在失败回合报 settled→「已完成」（烙进 APK 无法修，行为与改动前一致）；④ **新版通知需重打包 APK**；页面侧（data-result/'failed' 推送）即时生效 | ✅ 已实现且 APK 已重打包（安装 Flutter 3.29.0 并行副本 /c/src/flutter-3.29.0 解决 SDK 版本墙：pubspec 需 Dart ^3.7.0 而 3.27 只有 3.6.0；`flutter build apk --release` 482s 成功出包 22.5MB，三 dart 文件 analyze 零问题） |
| **G15** | **消息区流式体验完善**（对照桌面 v4 timeline 逐项比对后的感知缺口收口，全部在 public/index.html，服务端零改动）：① 回到底部悬浮按钮（对照 `ConversationBackToBottomButton`）——上滑离底出现、直播不拽人、新内容亮小圆点（桌面无角标，手机端增强）；② 可视回合状态行（对照 `chat-loading.tsx`）——`#streamSpin` 升级为 spinner+活动文案+秒表，`setActivity/tickElapsed` 双写，`#turnStatus` 桥接隐藏 DOM 一字不动；③ 工具运行输出 live-tail（对照 `ExecuteOutput.tsx` 贴底 tail）——progress 帧 60ms 合帧+末 12 行，completed 恢复全量；④ 流式尾部光标（独立兄弟节点，不进重建 DOM，`prefers-reduced-motion` 降级）；⑤ 切会话滚动位记忆（对照 `chatSessionScrollMemory`，LRU 50，非贴底恢复）；⑥ 长会话 `content-visibility: auto`（>80 条挂 .cvchat）；⑦ 流式 remendLite（对照 Streamdown `parseIncompleteMarkdown`，奇偶计数判定+未闭合围栏跳过，settle 路径不碰） | ① 双 script 块 `node --check` 过；② 真 Chromium CDP 21 项探针：remendLite 7 用例（含已闭合对不误补/glob 尾星不补/围栏跳过）、b2b 初始隐藏→上滑出现→点击回底→圆点亮灭、光标挂载/退场、状态行槽位+双写+`#turnStatus` 仍 display:none、工具 tail 二连帧合帧+completed 清场，19/21 直接过、2 项为探针测量误判（rAF 时序/脚本源码文本含哨兵词）修正复测全过；③ **真实忙碌回合 E2E**：探针页 boot 自动恢复本会话（busySource=inferred），状态行实况「正在执行 终端 · 已运行 1 分 12 秒」、b2b 离底 2333px 亮起；④ 400×850 深色截图视觉验收（圆钮+紫点）；⑤ 桥接五红线全绿 | ✅ 已实现并实测（2026-11-06；页面指纹 pageBuild 3df9f6d5 已生效，手机端自动热更新） |

> 后续批次已全部完成（G8–G14；G15 为 2026-11-06 追加的流式体验完善批）。§4 P1 清单剩余项全部处理：置顶/未读（G9）、用量分段（G10）、队列重排（G11）、检查点回滚（G12 探测）、mermaid/公式（G13）、推送（G14）；文件变更投影为 V4 通道专属（同 G12 定性）。

## 6. 验证与巡检

- `node --check server.mjs`；页面内联脚本 `new Function` 语法闸。
- 页面构建指纹自更新（md5 经 /api/state 下发）：改 index.html 无需重启；改 server.mjs 走 `restart_server.sh`（等空闲）。
- **巡检自动化**：每 30 分钟对照本节目标表检查状态列与实际代码/git 状态的一致性，未完成项继续实施并更新状态。
- 回归点：双通道跟随、×N 去重（messageKey）、回合结算闸、App 审批检测正则、`fileMention` 成果桥。
