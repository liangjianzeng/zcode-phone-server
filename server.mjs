// zcode-phone-server —— ZCode 手机端桥接服务
//
// 职责：在电脑上以 ZCode Protocol stdio 客户端身份驱动 `zcode app-server`，
// 并把它封装成「token 鉴权 + HTTP/SSE」的移动友好服务，只监听 127.0.0.1，
// 供 DSH-Phone 风格的手机端经 SSH 隧道访问。
//
// 协议依据：开源仓库 zai-org/ZCode
//   packages/shared/src/zcode-protocol/index.ts        （方法表 / 请求 schema / 事件 schema）
//   packages/shared/src/zcode-protocol-legacy-types.ts （workspace / 消息 / 工具状态 schema）
//   apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts（服务端语义）
//   apps/zcode-cli/packages/bootstrap/src/zcode-protocol/interaction-broker.ts（agent→客户端反向请求）
//
// 线路格式：stdin/stdout 上的换行分隔帧。注意：**没有 jsonrpc 字段**
// （shared/src/zcode-protocol 的 strict schema 会拒绝多余键），帧即 {id,method,params}。
//   请求：{id,method,params} → {id,result|error}
//   事件推送：{method:"session/event", params:{eventId,sessionId,seq,type,payload?,...}}
//   agent→客户端反向请求：{jsonrpc,id,method:"interaction/requestPermission"|"interaction/requestUserInput",params}
//     → 必须应答：permission → {decision:"allow"|"deny",reason?}
//                 userInput  → {action:"accept"|"decline",content?,reason?}
//
// 零 npm 依赖；Node ≥ 22.5（需要 node:sqlite 由 zcode.cjs 自行使用）。

import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..'); // D:\MyWork\Zcode-Phone
const CONFIG_PATH = path.join(__dirname, 'config.json');
const LOG_DIR = path.join(__dirname, 'logs');

// ────────────────────────── 配置 ──────────────────────────

const DEFAULT_CONFIG = {
  /** HTTP 监听端口；服务只绑定 127.0.0.1，公网访问必须经 SSH 隧道/Tailscale。 */
  port: 8787,
  /** 访问令牌；为空时首次启动自动生成并写回 config.json。 */
  token: '',
  /** ZCode 会话的工作目录（手机端聊天的项目根）。 */
  workspacePath: ROOT,
  /**
   * 多工作区列表（[{name, path}]）：页面顶栏可切换，新建会话落在所选工作区。
   * 空数组 = 只有上面单一 workspacePath 可用。
   */
  workspaces: [],
  /** 新建会话的权限模式：plan | build | edit | yolo。 */
  mode: 'yolo',
  /** 新会话使用的模型（providerId/modelId$reasoningLevel，provider 取第一个 "/" 前，档位取 "$" 后）。 */
  model: 'account:bigmodel-individual-coding-plan/GLM-5.3-Flash$max',
  /** agent 反向交互（权限/提问）自动应答：allow=自动放行；ask=转发手机端人工处理。 */
  autoAnswer: 'allow',
  /**
   * Coding Plan API Key（id.secret 形态，引擎 V4 请求签名必需）。
   * 桌面端 oauth 的 access_token（JWT）只能完成授权推送，跑不了推理；
   * 在 https://bigmodel.cn/usercenter/proj-mgmt/apikeys 创建后粘贴到这里。
   */
  codingPlanApiKey: '',
  /** 运行 zcode.cjs 的 Node 可执行文件（引擎需要 Node ≥22.5 的 node:sqlite）。 */
  nodePath: path.join(ROOT, 'tools', 'node22', 'node.exe'),
  /** ZCode 引擎入口。 */
  zcodePath: 'C:\\Users\\jianz\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs',
  /**
   * 内置 Provider 规则文件（Registry 的模型目录来源）。
   * 直接复用桌面端随包的完整定义；CLI 自己按版本号缓存会找不到文件导致账号模型无法注册。
   */
  builtinProviderConfigPath:
    'C:\\Users\\jianz\\AppData\\Local\\Programs\\ZCode\\resources\\config\\provider\\zcode-builtin.json',
  /** 历史消息拉取条数。 */
  maxHistoryMessages: 200,
};

function loadConfig() {
  let cfg = { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    cfg = { ...cfg, ...raw };
  } catch {
    /* 首次启动无配置文件，用默认值 */
  }
  if (!cfg.token || cfg.token.length < 16) {
    cfg.token = crypto.randomBytes(24).toString('base64url');
    saveConfig(cfg);
    logLine('boot', 'generated new access token');
  }
  return cfg;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

const config = loadConfig();
fs.mkdirSync(LOG_DIR, { recursive: true });

let logStream = null;
function logLine(kind, message, extra) {
  const rec = { t: new Date().toISOString(), kind, message, ...extra };
  console.log(JSON.stringify(rec));
  try {
    if (!logStream) logStream = fs.createWriteStream(path.join(LOG_DIR, 'server.jsonl'), { flags: 'a' });
    logStream.write(JSON.stringify(rec) + '\n');
  } catch { /* 日志失败不影响服务 */ }
}

// ────────────────────────── ZCode Agent（stdio 协议客户端）──────────────────────────

class ZcodeAgent {
  constructor() {
    this.child = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map(); // id → {resolve, reject, timer, method}
    this.startedAt = 0;
    this.restartCount = 0;
    this.stopping = false;
    this.onEvent = null;     // (event) => void           session/event 推送
    this.onReset = null;     // () => void                进程退出（SSE 客户端需刷新）
    this.onClientRequest = null; // (req) => Promise<any> agent→桥反向请求
  }

  start() {
    if (!fs.existsSync(config.nodePath)) {
      throw new Error(`nodePath 不存在: ${config.nodePath}（请安装 Node ≥22.5 并修改 config.json）`);
    }
    if (!fs.existsSync(config.zcodePath)) {
      throw new Error(`zcodePath 不存在: ${config.zcodePath}（请修改 config.json 指向 zcode.cjs）`);
    }
    this.stopping = false;
    this.startedAt = Date.now();
    const child = spawn(config.nodePath, [config.zcodePath, 'app-server'], {
      cwd: __dirname,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Provider Registry 的模型目录来源：显式指向桌面端完整内置配置
        ...(config.builtinProviderConfigPath
          ? {
              ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: config.builtinProviderConfigPath,
              ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json'),
            }
          : {}),
      },
    });
    this.child = child;
    logLine('agent', 'app-server spawned', { pid: child.pid });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      for (const line of c.split('\n')) if (line.trim()) logLine('agent-stderr', line.trim());
    });
    child.on('exit', (code) => this.#onExit(code));
  }

  #onExit(code) {
    logLine('agent', `app-server exited code=${code} uptime=${Math.round((Date.now() - this.startedAt) / 1000)}s`);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('ZCode app-server 已退出'));
    }
    this.pending.clear();
    this.child = null;
    if (this.onReset) this.onReset();
    if (!this.stopping) {
      // 崩溃自动拉起；连续快速崩溃时退避
      this.restartCount++;
      const delay = Math.min(2000 * this.restartCount, 15000);
      logLine('agent', `auto restart in ${delay}ms`);
      setTimeout(() => {
        if (!this.stopping) this.start();
      }, delay);
    }
  }

  #onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        logLine('agent-nonjson', line.slice(0, 300));
        continue;
      }
      this.#onMessage(msg);
    }
  }

  #onMessage(msg) {
    // 1) 响应帧
    if (msg.id !== undefined && !msg.method && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
          const err = new Error(`[${p.method}] ${msg.error.message ?? 'protocol error'}`);
          err.code = msg.error.code;
          err.data = msg.error.data;
          p.reject(err);
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }
    // 2) agent→桥 的反向请求（权限 / 提问），必须应答
    if (msg.id !== undefined && msg.method) {
      this.#handleClientRequest(msg).catch((e) => logLine('interaction-error', String(e?.message ?? e)));
      return;
    }
    // 3) 通知帧
    if (msg.method === 'session/event' && msg.params) {
      if (this.onEvent) this.onEvent(msg.params);
      return;
    }
    // startup/* 等其余通知仅记录
    logLine('notify', msg.method ?? 'unknown');
  }

  async #handleClientRequest(req) {
    const { id, method, params } = req;
    logLine('interaction', method, { requestId: params?.requestId, toolName: params?.toolName, sessionId: params?.sessionId });
    let result;
    if (method === 'session/requestRuntimePreferences') {
      // 运行时偏好：与桌面端关闭增强/内存、自动解答提问的默认一致
      result = {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: true,
      };
    } else if (method === 'interaction/requestProviderRuntimeHeaders') {
      // 请求期鉴权：Coding Plan 模型每次请求由桥回传凭据
      // （响应合同见 shared zcodeProviderRuntimeHeadersResponseSchema）。
      // 桌面端 oauth 的 access_token 是 JWT（多个点），直接作 apiKey 会被引擎的
      // V4 签名器当「id.secret」签名凭据解析而报 invalid-config（2026-10-03 实测）；
      // 该 token 实测可直接作 anthropic 兼容端点凭据（x-api-key / Bearer 均 200），
      // 故 JWT 形态改传 headers 绕过签名器；单点形态（真正的 id.secret API key）
      // 仍走 apiKey 签名路径。
      const pid = params?.providerId ?? '';
      const apiKey = readCodingPlanApiKey(pid);
      if (apiKey && /^eyJ/.test(apiKey)) {
        // start-plan 的 zcodeJwtToken：官方即以此作 requestAuth.apiKey 直通
        // （headersApplied: true，见 accountProviderRequestAuthService L75）。
        result = { headersApplied: true, requestAuth: { apiKey } };
        logLine('interaction-auth', 'start-plan zcode-jwt passthrough', { pid, masked: apiKey.slice(0, 8) + '…(' + apiKey.length + 'ch)' });
      } else if (apiKey) {
        // standalone api-key（id.secret 形态）：原样透传，适配器自行设
        // x-api-key + Bearer（individual-coding-plan 的 api.z.ai 路径）
        result = { headersApplied: true, requestAuth: { apiKey } };
        logLine('interaction-auth', 'api-key supplied', { pid, masked: apiKey.slice(0, 10) + '…(' + apiKey.length + 'ch)', dots: (apiKey.match(/\./g) || []).length });
      } else {
        result = { headersApplied: false, errorMessage: `zcode-phone-server 未找到 ${pid} 的凭据` };
      }
    } else if (method === 'interaction/requestPermission') {
      if (config.autoAnswer === 'allow') {
        result = { decision: 'allow', reason: 'zcode-phone-server auto allow' };
      } else {
        result = await waitInteraction(params.requestId, { kind: 'permission', ...params });
      }
    } else if (method === 'interaction/requestUserInput') {
      const questions = params?.questions ?? [];
      if (config.autoAnswer === 'allow') {
        // 桌面端默认行为一致：自动采纳第一题的第一个选项（content.answer 兼容路径）
        const first = questions[0]?.options?.[0]?.value ?? '';
        result = { action: 'accept', content: { answer: String(first) } };
      } else {
        const ans = await waitInteraction(params.requestId, { kind: 'userInput', ...params });
        result = ans?.action ? ans : { action: 'accept', content: { answer: String(ans?.answer ?? '') } };
      }
    } else {
      // 未知反向请求：返回空对象，避免协议悬挂
      result = {};
    }
    this.#write({ id, result });
  }

  #write(obj) {
    if (!this.child || this.child.stdin.destroyed) {
      logLine('agent-write-failed', 'stdin not writable');
      return;
    }
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, timeoutMs = 60000) {
    if (!this.child) return Promise.reject(new Error('app-server 未运行'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[${method}] 请求超时(${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.#write({ id, method, params });
    });
  }
}

// ────────────────────────── 会话注册表 & 交互等待 ──────────────────────────

/** sessionId → {subs:Set<res>, ring:[], busy:bool, busySince, title, lastSeq} */
const sessions = new Map();
/** requestId → {resolve, timer} */
const pendingInteractions = new Map();

// 全项目会话列表缓存（官方 PC 侧边栏数据源；5s TTL 护航页面轮询）
let allListCache = null;
// 会话存储里出现过的项目路径（引擎自建的项目也允许作为转发/建会话目标）
const knownWorkspaces = new Set();

function sessionState(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { subs: new Set(), ring: [], busy: false, busySince: 0, title: '', lastSeq: 0,
          queue: [], queueFlush: null, queuePoll: null };
    sessions.set(id, s);
  }
  return s;
}

function waitInteraction(requestId, info) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingInteractions.delete(requestId);
      broadcastInteraction(requestId, { kind: info.kind, requestId, expired: true });
      resolve(info.kind === 'permission'
        ? { decision: 'deny', reason: 'zcode-phone-server: 等待应答超时' }
        : { action: 'decline' });
    }, 30 * 60 * 1000);
    pendingInteractions.set(requestId, {
      resolve: (answer) => {
        clearTimeout(timer);
        pendingInteractions.delete(requestId);
        resolve(answer);
      },
      info,
    });
    broadcastInteraction(requestId, { ...info, requestId, pending: true });
  });
}

function broadcastInteraction(requestId, payload) {
  const sid = payload.sessionId;
  if (sid) pushSse(sid, { __ui: 'interaction', ...payload });
}

// ────────────────────────── Agent 实例 ──────────────────────────

const agent = new ZcodeAgent();

agent.onEvent = (event) => {
  const s = sessionState(event.sessionId);
  s.lastSeq = Math.max(s.lastSeq, event.seq ?? 0);
  if (event.type === 'turn.started') { s.busy = true; s.busySince = Date.now(); }
  // 回合可能由外部（桌面端）驱动、桥进程错过 turn.started：见到回合内
  // 活动事件也标记 busy，会话列表的"运行中"才不撒谎；completed/failed 复位。
  if (event.type === 'tool.updated' && !s.busy) { s.busy = true; if (!s.busySince) s.busySince = Date.now(); }
  if (event.type === 'turn.completed' || event.type === 'turn.failed') {
    s.busy = false; s.busySince = 0;
    // 本回合结束：若有排队消息，稍候自动补发为下一回合（预备任务语义）
    scheduleQueueFlush(event.sessionId, 1500);
  }
  // 429 限流自动重试：桌面端与手机共用同一账户，桌面跑任务期间手机新回合
  // 大概率撞并发限流；而桌面在工具执行间隙账户是空闲的，退避重试基本能过。
  // 只重试手机发起的发送（lastSend），最多 5 次、间隔 20 秒。
  if (event.type === 'turn.failed') scheduleRateLimitRetry(event.sessionId, event.payload?.error);
  pushSse(event.sessionId, event);
};

// model.streaming（token 级流式）：只直播给在线订阅者，不进重放环——
// 一个回合动辄上百个 chunk，进环会挤掉其他事件且重连重放语义不对
// （文本以存储持久化为准，直播中断即丢，页面从后续 delta 续流）。
function isStreamOnlyEvent(event) {
  return event.type === 'model.streaming';
}

const RATE_LIMIT_RE = /\b429\b|rate[._ ]?limit/i;
// 1113/余额类错误重试永远不会成功（凭据没有计费额度），不进入重试循环
const NO_RETRY_RE = /\b1113\b|insufficient balance|no resource package|余额不足|资源包|额度不足/i;

function scheduleRateLimitRetry(sid, error) {
  const s = sessionState(sid);
  const ls = s.lastSend;
  if (!ls?.content) return;
  const msg = String(error?.message ?? error ?? '');
  if (Date.now() - ls.at > 5 * 60 * 1000) return; // 只重试 5 分钟内的发送
  if (NO_RETRY_RE.test(msg)) {
    pushSse(sid, { __ui: 'note', text: '该凭据无推理额度（1113 余额/资源包不足）：请在平台给账户充值，或在模型菜单换其他模型。此错误不会自动重试。' });
    return;
  }
  if (!RATE_LIMIT_RE.test(msg)) return;
  if (ls.retries >= 5) {
    pushSse(sid, { __ui: 'note', text: '限流重试已达上限（5 次），请等桌面任务完成后再试，或在模型菜单换其他模型' });
    return;
  }
  ls.retries++;
  const n = ls.retries;
  pushSse(sid, { __ui: 'note', text: `模型账户限流（429），${n}/5 次，20 秒后自动重试…` });
  ls.timer = setTimeout(async () => {
    ls.timer = null; // 已触发：排队补发的 pending-重试守卫据此放行
    const cur = sessionState(sid);
    if (cur.busy || cur.lastSend !== ls) return; // 用户已停止或发了新消息
    try {
      // inputId 打 __retry 标记：turn.started 会回带 inputId，页面据此跳过
      // 用户消息回显（同一内容的气泡第一次失败时已经渲染过，重发不再重复）
      await agent.request('session/send', { sessionId: sid, content: ls.content, inputId: `__retry-${n}-${crypto.randomUUID()}` }, 120000);
      cur.busy = true;
      if (!cur.busySince) cur.busySince = Date.now();
      pushSse(sid, { __ui: 'note', text: `限流重试（第 ${n} 次）已发出` });
    } catch (e) {
      pushSse(sid, { __ui: 'note', text: `限流重试失败：${e?.message ?? e}` });
    }
  }, 20000);
}

// ────────────────────────── 排队消息（预备任务）──────────────────────────
// 协议层 session/send 在回合运行中会抛 -32010 "A prompt is already running"，
// 引擎没有排队/插话能力。桥在此自建每会话队列：
//   运行中收到 send → 入队（页面可取回编辑/删除）；回合结束（completed/
//   failed 事件）后自动补发队首为下一回合。
// 桌面端驱动的回合桥收不到结束事件（SSE 是进程内的），由 queuePoll 每 3s
// 用共享存储核实回合确已收尾（sessionLooksFinished）后补发，页面关着也生效。

const SEND_BUSY_RE = /-32010|already running/i;

function pushQueueState(sid) {
  pushSse(sid, { __ui: 'queue', sessionId: sid, queue: sessionState(sid).queue });
}

function startQueuePoll(sid) {
  const s = sessionState(sid);
  if (s.queuePoll) return;
  s.queuePoll = setInterval(async () => {
    if (!s.queue.length) { clearInterval(s.queuePoll); s.queuePoll = null; return; }
    if (s.busy || s.lastSend?.timer) return; // 回合运行中 / 限流重试待发：都不补发
    try {
      // status=running 但存储显示回合已收尾（外进程驱动）→ 可以补发下一轮
      if (await sessionLooksFinished(sid)) await flushQueue(sid);
    } catch { /* 下个周期再试 */ }
  }, 3000);
}

async function flushQueue(sid) {
  const s = sessionState(sid);
  if (!s.queue.length || s.busy || s.lastSend?.timer) return;
  const item = s.queue[0];
  // -32010 重试：回合刚结束引擎清理有间隙；连续被拒说明仍有回合在跑，放弃本轮
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await agent.request('session/send', { sessionId: sid, content: item.text, inputId: crypto.randomUUID() }, 120000);
      s.queue.shift();
      s.busy = true;
      if (!s.busySince) s.busySince = Date.now();
      if (s.lastSend?.timer) clearTimeout(s.lastSend.timer);
      s.lastSend = { content: item.text, at: Date.now(), retries: 0, timer: null };
      pushQueueState(sid);
      return;
    } catch (e) {
      if (!SEND_BUSY_RE.test(String(e?.message ?? e))) {
        // 真实失败（限流/余额等）：留在队首，页面提示，等用户处理
        pushSse(sid, { __ui: 'note', text: `排队消息发送失败：${String(e?.message ?? e).slice(0, 120)}（已保留在队列，可在输入框上方点击取回）` });
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

function scheduleQueueFlush(sid, delay = 1500) {
  const s = sessionState(sid);
  if (!s.queue.length) return;
  if (s.queueFlush) clearTimeout(s.queueFlush);
  s.queueFlush = setTimeout(() => { s.queueFlush = null; flushQueue(sid).catch(() => {}); }, delay);
}

function enqueueMessage(sid, content) {
  const s = sessionState(sid);
  s.queue.push({ id: crypto.randomUUID(), text: content, at: Date.now() });
  startQueuePoll(sid);
  pushQueueState(sid);
}

agent.onReset = () => {
  for (const [sid, s] of sessions) {
    for (const res of s.subs) {
      try { res.write(`event: reset\ndata: {"reason":"app-server restarted"}\n\n`); res.end(); } catch { /* ignore */ }
    }
    s.subs.clear();
    s.busy = false;
  }
};

function pushSse(sessionId, obj) {
  const s = sessionState(sessionId);
  const isEvent = !obj.__ui;
  const streamOnly = isEvent && isStreamOnlyEvent(obj);
  if (isEvent && !streamOnly) {
    s.ring.push(obj);
    if (s.ring.length > 1000) s.ring.shift();
  }
  const data = JSON.stringify(obj);
  for (const res of s.subs) {
    try {
      if (isEvent) res.write(`id: ${obj.seq}\n`);
      res.write(`event: ${obj.__ui ? 'ui' : 'zcode'}\ndata: ${data}\n\n`);
    } catch { /* 断开的连接由 close 事件清理 */ }
  }
}

function parseModelSelection(value) {
  const v = String(value ?? '').trim();
  if (!v) return undefined;
  const i = v.indexOf('/');
  if (i <= 0) return undefined;
  const selection = { providerId: v.slice(0, i), modelId: v.slice(i + 1) };
  // 支持 provider/model$level 形式（reasoning 附加档位）
  const d = selection.modelId.indexOf('$');
  if (d > 0) selection.options = { reasoningLevel: selection.modelId.slice(d + 1) };
  if (d > 0) selection.modelId = selection.modelId.slice(0, d);
  return selection;
}

// ── 会话设置投影（对照官方 zcode.z.ai：模型选择 / 思考档位 / 权限模式 / slash 命令）──

/** modelSelection → 纯 JSON（宽松：引擎可能带 options.reasoningLevel 或顶层 reasoningLevel）。 */
function modelRefToJson(ref) {
  if (!ref || typeof ref !== 'object') return null;
  const out = { providerId: String(ref.providerId ?? ''), modelId: String(ref.modelId ?? '') };
  const lvl = ref.options?.reasoningLevel ?? ref.reasoningLevel;
  if (lvl) out.reasoningLevel = String(lvl);
  return out;
}

/**
 * 引擎投影的 contextUsed 只在本进程内有活回合时才非 0——会话 resume 后处于
 * idle 时恒报 0（2026-10-04 实测），页面就会显示「0 / 20万」这种错误容量。
 * 从源头补：共享 DB（与桌面端同一个 sqlite）里该会话最后一次模型请求的
 * input+output 就是当前上下文占用的真实值（实测与运行态投影吻合：
 * 投影 126,275 ↔ 最后一请求 input 127,568，差一次回复长度）。
 */
const AGENT_DB_PATH = path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
let agentDbHandle = null;
function dbContextUsage(sessionId) {
  if (!sessionId) return null;
  try {
    if (!agentDbHandle) agentDbHandle = new DatabaseSync(AGENT_DB_PATH, { readOnly: true });
    const row = agentDbHandle.prepare(
      'SELECT provider_id, model_id, input_tokens, output_tokens FROM model_usage WHERE session_id = ? ORDER BY started_at DESC, id DESC LIMIT 1'
    ).get(sessionId);
    if (!row) return null;
    const used = Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0);
    if (used <= 0) return null;
    return { used, providerId: String(row.provider_id ?? ''), modelId: String(row.model_id ?? '') };
  } catch { return null; }
}

// ── 会话管理（归档/删除/任务计划）：引擎无对应 RPC，桌面版同款做法是直接
// 读写共享 db.sqlite（session.time_archived 列 + todo 表）。WAL 多进程写安全，
// busy_timeout 防止与引擎写入互锁。
let agentDbWriteHandle = null;
function agentDbWrite() {
  if (!agentDbWriteHandle) {
    agentDbWriteHandle = new DatabaseSync(AGENT_DB_PATH);
    agentDbWriteHandle.exec('PRAGMA busy_timeout=5000');
    agentDbWriteHandle.exec('PRAGMA journal_mode=WAL');
  }
  return agentDbWriteHandle;
}

function dbSessionArchived(sid) {
  try {
    if (!agentDbHandle) agentDbHandle = new DatabaseSync(AGENT_DB_PATH, { readOnly: true });
    const row = agentDbHandle.prepare('SELECT time_archived FROM session WHERE id = ?').get(sid);
    return row ? row.time_archived != null : null;
  } catch { return null; }
}

function dbArchiveSession(sid, archived) {
  const db = agentDbWrite();
  db.prepare('UPDATE session SET time_archived = ? WHERE id = ?')
    .run(archived ? Date.now() : null, sid);
}

// 删除会话：先关引擎内激活实例，再连带清所有 session 维度数据行（只删该会话）
const SESSION_SCOPED_TABLES = [
  'part', 'message', 'todo', 'session_entry', 'session_input',
  'model_usage', 'turn_usage', 'tool_usage', 'input_history',
  'session_target',
];
function dbDeleteSession(sid) {
  const db = agentDbWrite();
  db.exec('BEGIN');
  try {
    // session_task_link 两列都可能指向该会话
    db.prepare('DELETE FROM session_task_link WHERE child_session_id = ? OR parent_session_id = ?').run(sid, sid);
    for (const t of SESSION_SCOPED_TABLES) {
      db.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(sid);
    }
    db.prepare('DELETE FROM session WHERE id = ?').run(sid);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* noop */ }
    throw e;
  }
}

function dbSessionTodos(sid) {
  try {
    if (!agentDbHandle) agentDbHandle = new DatabaseSync(AGENT_DB_PATH, { readOnly: true });
    return agentDbHandle.prepare(
      'SELECT content, status, priority, position FROM todo WHERE session_id = ? ORDER BY position'
    ).all(sid);
  } catch { return []; }
}

/**
 * z.ai Coding Plan 的 GLM-5.3 系列真实上下文窗口是 1M（100万 KV）：
 * 引擎内置 provider 目录写的是 200K 老默认值，且投影 contextUsed 实测已
 * 冲到 20.3 万任务仍正常跑（context_exceeded 从未触发），200K 显然错误。
 * 非 GLM-5.3 或非 z.ai 账户返回 null（沿用引擎值）。
 */
function realContextWindow(providerId, modelId) {
  if (/^account:/.test(String(providerId ?? '')) && /glm-5\.3/i.test(String(modelId ?? ''))) {
    return 1_000_000;
  }
  return null;
}

/**
 * 把 session/create|resume|read 的快照投影成前端友好的设置对象：
 * model.current/available（含 reasoning 档位）、thoughtLevel、mode、slashCommands、
 * projection（上下文占用，供官方样式「上下文容量」卡片使用）。
 */
function projectSettings(snapshot, fallbackSid = '') {
  const st = snapshot?.settings ?? {};
  const model = st.model ?? {};
  const thought = st.thoughtLevel ?? {};
  const proj = snapshot?.projection ?? null;
  // session/read 快照不带 session 对象（2026-10-04 实测），路由侧补传 sid，
  // 否则 DB 回退查不到 model_usage，容量恒显 0
  const sid = String(snapshot?.session?.id ?? snapshot?.sessionId ?? fallbackSid ?? '');
  const cur = modelRefToJson(model.current);
  // 投影缺 0（idle/外进程驱动）时用共享 DB 的真实上下文占用补；
  // DB 回退还能带回该会话实际用的模型（provider/model），用于修正窗口
  const dbCtx = Number(proj?.contextUsed ?? 0) > 0
    ? null
    : dbContextUsage(sid);
  const used = Number(proj?.contextUsed ?? 0) > 0 ? Number(proj.contextUsed) : (dbCtx?.used ?? 0);
  // 窗口修正：引擎内置目录的 GLM-5.3 是 200K 老默认值，真实 1M。
  // 优先看会话实际用的模型，再看当前选中模型。
  const winOverride = realContextWindow(dbCtx?.providerId, dbCtx?.modelId)
    ?? realContextWindow(cur.providerId, cur.modelId);
  const available = (Array.isArray(model.available) ? model.available : []).map((o) => ({
    providerId: o.ref?.providerId ?? '',
    modelId: o.ref?.modelId ?? '',
    reasoningLevel: o.ref?.options?.reasoningLevel ?? '',
    label: o.label ?? o.ref?.modelId ?? '',
    providerLabel: o.providerLabel ?? '',
    description: o.description ?? '',
    contextWindow: realContextWindow(o.ref?.providerId, o.ref?.modelId)
      ?? (o.contextWindow ?? 0),
    reasoningLevels: (o.reasoning?.levels ?? []).map((l) => ({
      value: l.value, label: l.label, description: l.description ?? '',
    })),
    defaultReasoningLevel: o.reasoning?.defaultLevel ?? '',
    disabledReason: o.disabledReason ?? '',
  }));
  return {
    model: {
      current: cur,
      available,
    },
    thoughtLevel: {
      enabled: !!thought.enabled,
      current: thought.current ?? null,
      defaultLevel: thought.defaultLevel ?? null,
      available: (Array.isArray(thought.available) ? thought.available : []).map((l) => ({
        value: l.value, label: l.label, description: l.description ?? '',
      })),
    },
    mode: { current: st.mode?.current ?? snapshot?.session?.mode ?? config.mode },
    slashCommands: Array.isArray(snapshot?.slashCommands) ? snapshot.slashCommands : [],
    projection: (proj || used > 0) ? {
      contextUsed: used,
      contextWindow: winOverride
        ?? (Number(proj?.contextWindow ?? 0) > 0 ? Number(proj.contextWindow) : 0),
      totalTokenCount: proj?.totalTokenCount ?? 0,
      status: proj?.status ?? '',
    } : null,
  };
}

/** 把会话内的模型/档位选择持久化进 config.model（provider/model$level），新会话沿用。 */
function persistModelConfig(sel) {
  if (!sel?.providerId || !sel?.modelId) return;
  config.model = `${sel.providerId}/${sel.modelId}${sel.reasoningLevel ? '$' + sel.reasoningLevel : ''}`;
  saveConfig(config);
}

function workspaceRef(overridePath) {
  // 本地 workspace：workspaceKey = workspacePath（bootstrap/zcode-protocol/workspace.ts 约定）。
  // overridePath：切换项目时由请求显式指定。允许：主工作区、config.workspaces 白名单、
  // 以及会话存储里出现过 knownWorkspaces（官方 PC 可打开任意历史项目，语义一致）。
  const requested = String(overridePath ?? '').trim();
  let wp = config.workspacePath;
  if (requested) {
    const allowed = new Set(
      [config.workspacePath, ...(config.workspaces ?? []).map((w) => w.path)]
        .map((p) => path.resolve(String(p))),
    );
    for (const k of knownWorkspaces) allowed.add(k);
    const resolved = path.resolve(requested);
    if (allowed.has(resolved)) wp = resolved;
    else logLine('workspace', 'requested workspace not allowed, fallback to main', { requested: resolved });
  }
  return { workspacePath: wp, workspaceKey: wp };
}

// ────────────────────────── 桌面任务索引双向同步 ──────────────────────────
// 桌面端 UI 的会话列表不读 session/list，而是读自己的任务索引
// ~/.zcode/v2/tasks-index.sqlite（tasks 表，task_id = sessionId），只有桌面
// 自己创建/打开过的会话才有记录——手机建的会话因此"桌面不可见"。
// 桥把手机会话 upsert 进该表（会话正文本就落在共享 db.sqlite，桌面点开
// 即可正常加载），实现 双向可见：桌面→手机本来就走共享存储，无需处理。
const TASKS_DB_PATH = path.join(os.homedir(), '.zcode', 'v2', 'tasks-index.sqlite');
let tasksDbHandle = null;

function tasksDb() {
  if (!tasksDbHandle) {
    tasksDbHandle = new DatabaseSync(TASKS_DB_PATH);
    tasksDbHandle.exec('PRAGMA busy_timeout=3000');
  }
  return tasksDbHandle;
}

/** 把会话列表（/api/sessions?all=1 的映射行）同步进桌面任务索引。
 *  只增改不删：桌面侧删除/归档/手动改题的记录一律尊重（deleted/archived/
 *  title_overridden 不回写覆盖）。同步失败绝不影响主流程。 */
async function syncTaskIndexRows(list) {
  const rows = (list ?? []).filter((s) => s.sessionId && !String(s.sessionId).startsWith('sess_subagent'));
  if (!rows.length) return 0;
  let changed = 0;
  try {
    const db = tasksDb();
    const existing = new Map();
    for (const r of db.prepare('SELECT task_id, title, task_status, mode, updated_at, deleted, archived, title_overridden, meta_json FROM tasks').all()) {
      existing.set(r.task_id, r);
    }
    const ins = db.prepare(
      'INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, task_status, provider, mode, model, created_at, updated_at, pinned, archived, deleted, title_overridden, meta_json, searchable_text) ' +
      'VALUES (?, ?, NULL, ?, ?, ?, \'glm\', ?, NULL, ?, ?, 0, 0, 0, 0, ?, ?)',
    );
    const upd = db.prepare('UPDATE tasks SET title=?, task_status=?, mode=?, updated_at=?, meta_json=? WHERE task_id=?');
    for (const s of rows) {
      const status = String(s.status ?? '').toLowerCase() === 'running' ? 'running' : 'completed';
      const ws = String(s.workspacePath ?? '').replace(/\//g, '\\');
      if (!ws) continue;
      const createdAt = Number(s.createdAt ?? s.updatedAt ?? Date.now());
      const updatedAt = Number(s.updatedAt ?? Date.now());
      const old = existing.get(s.sessionId);
      if (!old) {
        const meta = {
          taskId: s.sessionId, traceId: crypto.randomUUID(), title: String(s.title ?? ''),
          workspacePath: ws, createdAt, updatedAt, mode: String(s.mode ?? ''),
          provider: 'glm', status, target: null, titleOverridden: false,
        };
        ins.run(ws, ws, s.sessionId, String(s.title ?? ''), status, String(s.mode ?? ''),
          createdAt, updatedAt, JSON.stringify(meta), String(s.title ?? ''));
        changed++;
        continue;
      }
      if (Number(old.deleted) || Number(old.archived)) continue; // 桌面已删/归档：尊重
      const titleOverridden = Number(old.title_overridden);
      const newTitle = titleOverridden ? old.title : String(s.title ?? old.title ?? '');
      if (old.title === newTitle && Number(old.updated_at) === updatedAt && old.task_status === status) continue;
      let meta = {};
      try { meta = JSON.parse(old.meta_json ?? '{}'); } catch { /* 空对象兜底 */ }
      meta.taskId = s.sessionId;
      meta.traceId = meta.traceId ?? crypto.randomUUID();
      meta.title = newTitle;
      meta.workspacePath = ws;
      meta.createdAt = Number(meta.createdAt ?? createdAt);
      meta.updatedAt = updatedAt;
      meta.mode = String(s.mode ?? old.mode ?? '');
      meta.provider = meta.provider ?? 'glm';
      meta.status = status;
      meta.titleOverridden = !!titleOverridden;
      upd.run(newTitle, status, String(s.mode ?? old.mode ?? ''), updatedAt, JSON.stringify(meta), s.sessionId);
      changed++;
    }
  } catch (e) {
    logLine('task-sync', `同步桌面任务索引失败：${String(e?.message ?? e).slice(0, 200)}`);
  }
  return changed;
}

// 桌面标题自动生成有延迟、页面也未必开着：每 60s 全量对账一次
setInterval(() => {
  agent.request('session/list', { limit: 200, includeArchived: false })
    .then((r) => syncTaskIndexRows((r.sessions ?? []).map((s) => ({
      sessionId: s.sessionId,
      title: String(s.title ?? '').includes('\uFFFD') ? '' : s.title,
      status: s.status,
      mode: s.mode,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      workspacePath: s.workspace?.workspacePath ?? s.workspace?.workspaceKey ?? s.workspacePath ?? '',
    }))))
    .catch(() => { /* 引擎未就绪：下个周期再试 */ });
}, 60000).unref();

// ────────────────────────── 共享凭据（与桌面端同文件同密钥）──────────────────────────
// 依据：adapters/src/auth/credential-cipher.ts + shared-credentials.ts

import os from 'node:os';

const CRED_PATH = path.join(os.homedir(), '.zcode', 'v2', 'credentials.json');

function credentialSecret() {
  const configured = process.env.ZCODE_CREDENTIAL_SECRET?.trim();
  if (configured) return configured;
  // 与引擎一致的机器自包含兜底密钥（同机同用户即可解密）
  return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${os.userInfo().username}`;
}

function decryptCredential(value) {
  const v = String(value ?? '');
  if (!v.startsWith('enc:v1:')) return v;
  const [ivRaw, tagRaw, dataRaw] = v.slice('enc:v1:'.length).split('.');
  const key = crypto.createHash('sha256').update(credentialSecret()).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataRaw, 'base64url')), decipher.final()]).toString('utf8');
}

/** 桌面端 oauth 共享凭据键（providerId → credentials.json 键名）。
 *  zai-start-plan 与 zai-individual-coding-plan 共用同一个 Z.AI oauth 登录态。 */
const OAUTH_ACCESS_KEY_BY_PROVIDER = {
  'account:zai-start-plan': 'oauth:zai:access_token',
  'account:bigmodel-individual-coding-plan': 'oauth:bigmodel:access_token',
  'account:zai-individual-coding-plan': 'oauth:zai:access_token',
};

/** 当前机器上已连接（有凭据）的 Coding Plan provider id。
 *
 * start-plan 优先：凭据文件存在 `zcodejwttoken` = 桌面 start-plan 登录态
 * （官方 AccountProviderRequestAuthService：planKind==='start-plan' 时
 * requestAuth.apiKey = tokenSet.zcodeJwtToken）。用户当前套餐即 start-plan；
 * account:zai-individual-coding-plan 的 standalone key 是独立计费键（无余额
 * 必报 1113），只作没有 start-plan 登录态时的兜底。 */
function connectedProviderId() {
  try {
    const raw = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
    const zjwt = decryptCredential(raw['zcodejwttoken'] ?? '').trim();
    if (zjwt) return 'account:zai-start-plan';
  } catch { /* fallthrough */ }
  const all = ['account:zai-individual-coding-plan', 'account:bigmodel-individual-coding-plan'];
  for (const pid of all) {
    // 只认 standalone 键命中（有真凭据能推理）
    try {
      const raw = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
      const hit = Object.keys(raw).some((k) =>
        k.startsWith('account-provider:coding-plan:') && k.includes(`:${pid}:`) && k.endsWith(':api-key'));
      if (hit) return pid;
    } catch { /* fallthrough */ }
  }
  return undefined;
}

/** 读取 Coding Plan api-key（standalone 键名规范见 bootstrap/src/app/standalone-account-provider-runtime.ts）。 */
function readCodingPlanApiKey(providerId) {
  // 优先级 0：config.json 显式配置的 Coding Plan API Key（id.secret 形态）。
  // 注意：standalone api-key 是**独立计费**的按量付费凭据——账户没充值时推理
  // 一律报 [1113] Insufficient balance（2026-10-04 实测），套餐订阅额度只挂在
  // 桌面端 oauth 凭据上。
  const configured = String(config.codingPlanApiKey ?? '').trim();
  if (configured) return configured;
  try {
    const raw = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
    // start-plan：官方 requestAuth 凭据是 oauth token set 里的 zcodeJwtToken
    // （accountProviderRequestAuthService.ts L73-76：planKind==='start-plan'
    //  → apiKey = tokenSet.zcodeJwtToken）。凭据文件里存于 `zcodejwttoken` 键。
    // 注意不是 oauth:zai:access_token——那个普通登录 JWT 直通 zcode-plan 端点
    // 实测 401（2026-10-03），此前"无法复刻"的结论就是错用了它。
    if (providerId === 'account:zai-start-plan') {
      const jwt = decryptCredential(raw['zcodejwttoken'] ?? '').trim();
      if (jwt) return jwt;
      return undefined;
    }
    // individual-coding-plan：standalone 独立计费 api-key（账户需有余额）
    const identity = decryptCredential(raw[`account-provider:${providerId}:identity`] ?? '').trim();
    if (identity) {
      const key = `account-provider:coding-plan:${providerId}:account:${encodeURIComponent(identity)}:api-key`;
      const apiKey = decryptCredential(raw[key] ?? '').trim();
      if (apiKey) return apiKey;
    }
    // identity 键缺席时直接扫键匹配（2026-10-03 实测 Z.AI 重登录后凭据文件只有
    // account-provider:coding-plan:account:<providerId>:account:<uuid>:api-key，
    // 没有 identity 键——UUID 已直接嵌在键名里）。
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith(`account-provider:coding-plan:`) && k.includes(`:${providerId}:`) && k.endsWith(':api-key')) {
        const apiKey = decryptCredential(v).trim();
        if (apiKey) return apiKey;
      }
    }
    // 最后兜底：任取一个 oauth:*:access_token（provider 映射缺失时尽量可用）
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('oauth:') && k.endsWith(':access_token')) {
        const d = decryptCredential(v).trim();
        if (d) return d;
      }
    }
    return undefined;
  } catch (e) {
    logLine('credential-error', String(e?.message ?? e));
    return undefined;
  }
}

/**
 * z.ai 计费端点调用助手（GET/POST JSON）。
 * 必须用 node:https + agent:false（每次新建连接）——全局 fetch(undici) 的
 * 连接池在 z.ai 端 RST 后会被污染，此后所有请求报 "fetch failed"（2026-10-04 实测）。
 */
function zaiBillingRequest(pathAndQuery, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const key = readCodingPlanApiKey(connectedProviderId());
    if (!key) return reject(new Error('no coding plan api key'));
    const u = new URL(pathAndQuery.startsWith('http') ? pathAndQuery : 'https://zcode.z.ai' + pathAndQuery);
    const payload = method === 'POST' && body != null ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method,
      agent: false,
      timeout: 15000,
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 套餐概览缓存（billing/current 返回含 grant_units/有效期；5 分钟内直接复用）。 */
let planOverviewCache = { at: 0, data: null };
async function fetchPlanOverview() {
  if (planOverviewCache.data && Date.now() - planOverviewCache.at < 300000) return planOverviewCache.data;
  const r = await zaiBillingRequest('/api/v1/zcode-plan/billing/current');
  if (r.status !== 200) throw new Error(`billing/current ${r.status}: ${r.body.slice(0, 120)}`);
  const j = JSON.parse(r.body);
  if (j.code !== 0) throw new Error(`billing/current code=${j.code} ${j.msg ?? ''}`.slice(0, 160));
  planOverviewCache = { at: Date.now(), data: j.data ?? {} };
  return planOverviewCache.data;
}

/**
 * 把账号授权推送给 agent（等价桌面 host 的 provider/updateAccountConfig）。
 * providers 仅含 access 覆盖（config/schema.ts accountProviderConfigSchema）；
 * states 中 entitled 的 builtin provider 必须带 current 布尔。
 * basedOnZCodeBuiltinRevision 必须与 agent 进程内置配置的真实 revision 完全一致
 * （zcode-builtin:{revision}:{sha256(文件绝对路径)}，见 zcode-builtin-provider-config-source.ts），
 * 否则 RegistryService 会静默跳过本次组合。
 */
function pushAccountConfig() {
  const pid = connectedProviderId();
  if (!pid) {
    logLine('account', '未找到 Coding Plan api-key 凭据，跳过授权推送');
    return Promise.resolve(false);
  }
  // access 协议信封只接受 {type, entitled}（strict 校验）；accountType/mode 等
  // 完整字段由引擎按 builtin 配置与 pid 自行装配
  let basedOn = 'zcode-builtin';
  try {
    const cfgFile = path.resolve(config.builtinProviderConfigPath);
    const rev = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).revision;
    const sourceKey = crypto.createHash('sha256').update(cfgFile).digest('hex');
    basedOn = `zcode-builtin:${rev}:${sourceKey}`;
  } catch (e) {
    logLine('account-error', '内置配置 revision 计算失败: ' + String(e?.message ?? e));
  }
  return agent.request('provider/updateAccountConfig', {
    revision: `zcode-phone-${Date.now()}`,
    basedOnZCodeBuiltinRevision: basedOn,
    providers: {
      // 协议 strict 校验只认 {type, entitled}；planKind 由引擎按 providerId
      // 从内置配置（zcode-builtin.json）自行解析，多传会被拒（unrecognized_keys）
      [pid]: { access: { type: 'zhipu-account', entitled: true } },
    },
    states: { [pid]: { availability: 'available', entitled: true, current: true } },
  }).then((r) => {
    logLine('account', '授权推送完成', { providerCount: r?.providerCount, status: r?.status, pid });
    return true;
  }).catch((e) => {
    logLine('account-error', String(e?.message ?? e));
    return false;
  });
}

// ────────────────────────── HTTP 服务 ──────────────────────────

const PUBLIC_DIR = path.join(__dirname, 'public');
/** index.html 内容指纹（md5 前 8 位）：页面经 /api/state 比对，变了自动 reload。 */
const PAGE_BUILD_FINGERPRINT = crypto.createHash('md5')
  .update(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')))
  .digest('hex').slice(0, 8);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function checkAuth(req, url) {
  const t = url.searchParams.get('token') ?? req.headers['x-zptoken'] ?? req.headers.cookie?.match(/zpt=([^;]+)/)?.[1] ?? '';
  return t && timingSafeEqual(t, config.token);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const p = url.pathname;
/** 会话是否已收尾（最后 assistant 消息以 step-finish 结尾），10 秒缓存。
 * status=running 的会话若回合由外进程驱动，桥引擎收不到结束事件，
 * status 永远停在 running（僵尸 running）——必须用共享存储核实。 */
const finishedCache = new Map();
async function sessionLooksFinished(sid) {
  const c = finishedCache.get(sid);
  if (c && Date.now() - c.t < 10000) return c.finished;
  let finished = false;
  try {
    const r = await agent.request('session/messages', { sessionId: sid, limit: 1 });
    const last = (r.messages ?? []).at(-1);
    finished = !!last
      && String(last.info?.role ?? '') === 'assistant'
      && (last.parts ?? []).length > 0
      && String(last.parts.at(-1)?.type ?? '') === 'step-finish';
  } catch { finished = true; } // 会话未挂载/读取失败：不按 running 处理
  finishedCache.set(sid, { t: Date.now(), finished });
  return finished;
}

  const seg = p.split('/').filter(Boolean); // ['api', ...]

  if (req.method === 'GET' && p === '/api/state') {
    return sendJson(res, 200, {
      workspacePath: config.workspacePath,
      mode: config.mode,
      model: config.model,
      autoAnswer: config.autoAnswer,
      agentRunning: !!agent.child,
      // 页面构建指纹（index.html 内容 md5 前 8 位）：页面轮询对比，服务端
      // 更新页面后客户端自动 reload——否则手机一直跑内存里的旧 JS，
      // 所有页面级修复都到不了终端（2026-10-04 卡死/容量环教训）
      pageBuild: PAGE_BUILD_FINGERPRINT,
    });
  }

  if (req.method === 'GET' && p === '/api/workspaces') {
    // 可选工作区（主工作区 + config.workspaces），供页面顶栏切换器使用
    return sendJson(res, 200, {
      workspaces: [
        { name: '默认', path: config.workspacePath },
        ...(config.workspaces ?? []),
      ],
    });
  }

  if (req.method === 'POST' && p === '/api/upload') {
    // App 拍照/相册图片落盘：存到所选工作区的 .zcode-uploads/，消息中以路径引用（模型工具可直接读取）
    const body = await readBody(req, 16 * 1024 * 1024);
    const wsRef = workspaceRef(body.workspace);
    const safeName = String(body.name ?? 'image.png').replace(/[\\/:*?"<>|]/g, '_').slice(-80);
    const dir = path.join(wsRef.workspacePath, '.zcode-uploads');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${safeName}`);
    fs.writeFileSync(file, Buffer.from(String(body.dataBase64 ?? ''), 'base64'));
    return sendJson(res, 200, { path: file });
  }

  if (req.method === 'GET' && p === '/api/sessions') {
    const ws = url.searchParams.get('workspace');
    // all=1：全项目会话（官方 PC「项目 ⇄ 会话」分组列表的数据源）。
    // session/list 的 workspace 可选——不传即返回全部会话，每条带归属 workspace。
    if (url.searchParams.get('all') === '1') {
      const now = Date.now();
      const wantArchived = url.searchParams.get('archived') === '1';
      if (!allListCache || allListCache.archived !== wantArchived || now - allListCache.t > 5000) {
        const r = await agent.request('session/list', { limit: 200, includeArchived: true });
        const mapped = await Promise.all((r.sessions ?? []).map(async (s) => ({
          sessionId: s.sessionId,
          title: String(s.title ?? '').includes('\uFFFD') ? '' : s.title,
          status: s.status,
          mode: s.mode,
          updatedAt: s.updatedAt,
          createdAt: s.createdAt,
          archived: dbSessionArchived(s.sessionId) === true,
          workspacePath:
            s.workspace?.workspacePath ?? s.workspace?.workspaceKey ?? s.workspacePath ?? '',
          // status=running 必须经存储核实：外进程驱动的回合结束后桥收不到
          // 事件，status 永远 running（僵尸 running → 手机永久转圈点不动）
          busy: sessionState(s.sessionId).busy
            || (String(s.status ?? '').toLowerCase() === 'running'
              && !(await sessionLooksFinished(s.sessionId))),
        })));
        const list = mapped.filter((s) => s.archived === wantArchived);
        list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
        allListCache = { t: now, list, archived: wantArchived };
        // 双向同步：手机侧会话同步进桌面任务索引（桌面→手机本就走共享存储）
        syncTaskIndexRows(list).catch(() => {});
        for (const it of list) {
          if (it.workspacePath) knownWorkspaces.add(path.resolve(it.workspacePath));
        }
      }
      return sendJson(res, 200, { sessions: allListCache.list });
    }
    const r = await agent.request('session/list', { workspace: workspaceRef(ws), limit: 50, includeArchived: false });
    const list = (r.sessions ?? []).map((s) => ({
      sessionId: s.sessionId,
      title: String(s.title ?? '').includes('�') ? '' : s.title,
      status: s.status,
      mode: s.mode,
      updatedAt: s.updatedAt,
      createdAt: s.createdAt,
      busy: sessionState(s.sessionId).busy,
    }));
    list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return sendJson(res, 200, { sessions: list });
  }

  // 创建（POST /api/sessions {sessionId?}）—— sessionId 存在则 resume。
  // create/resume 均返回完整 snapshot：{protocol, session:{sessionId,title,...}, messages, runtime, ...}
  if (req.method === 'POST' && p === '/api/sessions') {
    const body = await readBody(req);
    let sid = body.sessionId;
    const wsRef = workspaceRef(body.workspace);
    let snap;
    // 账号授权推送（幂等；app-server 重启后同样生效）
    await pushAccountConfig();
    if (sid) {
      // resume 不带 workspace = 沿用会话自身所属项目（避免把别的项目会话改绑到当前项目）。
      // 仅当调用方显式指定项目时才传（新建时必传，用于落点）。
      const resumeParams = { sessionId: sid };
      if (String(body.workspace ?? '').trim()) resumeParams.workspace = wsRef;
      snap = await agent.request('session/resume', resumeParams, 180000);
    } else {
      snap = await agent.request('session/create', {
        workspace: wsRef,
        mode: config.mode,
        model: parseModelSelection(config.model),
        titleGenerationEnabled: true,
      }, 180000);
      sid = snap?.session?.sessionId ?? snap?.sessionId;
    }
    if (!sid) throw new Error('session/create 未返回 sessionId');
    sessionState(sid);
    // 订阅事件流（legacy 通道：subscribe 后才有 session/event 推送）
    await agent.request('session/subscribe', { sessionId: sid, deliveryKind: 'desktop-continuous', includeSnapshot: false });
    // 显式落一次模型选择：create 的 model 参数不保证写入会话运行时（turn 期校验用的是会话选择）。
    // session/setModel 的 model 是 {providerId, modelId, options?} 对象（2026-10-03 实测：
    // 传字符串报 expected object；此前 [object Object] 报错实为 Registry 空所致）。
    const sel = parseModelSelection(config.model);
    if (sel) {
      await agent.request('session/setModel', { sessionId: sid, model: sel }).catch((e) =>
        logLine('set-model-error', String(e?.message ?? e)));
    }
    return sendJson(res, 200, {
      sessionId: sid,
      title: snap?.session?.title ?? '',
      status: snap?.session?.status ?? 'idle',
      messages: snap?.messages ?? [],
      // lastSeq：页面首连从此序号只收新事件（历史已由 messages 渲染，重放会重复）
      lastSeq: sessionState(sid).lastSeq,
      // 运行态恢复：页面刷新/重开后能立即回到"运行中"并接续计时
      busy: sessionState(sid).busy,
      busySince: sessionState(sid).busySince || undefined,
      // 会话设置（模型列表/思考档位/权限模式/slash 命令/上下文投影）：
      // 供官方样式的模型选择、思考档位、权限模式菜单与上下文容量卡使用
      settings: projectSettings(snap, sid),
    });
    // 新会话尽快在桌面任务列表可见（标题生成后的更新由 60s 周期对账覆盖）
    setTimeout(() => {
      syncTaskIndexRows([{
        sessionId: sid,
        title: snap?.session?.title ?? '',
        status: snap?.session?.status ?? 'idle',
        mode: config.mode,
        createdAt: snap?.session?.createdAt ?? Date.now(),
        updatedAt: snap?.session?.updatedAt ?? Date.now(),
        workspacePath: wsRef.workspacePath,
      }]).catch(() => {});
    }, 2000).unref();
  }

  if (seg[0] === 'api' && seg[1] === 'sessions' && seg[2]) {
    const sid = decodeURIComponent(seg[2]);
    const sub = seg[3];

    // 计划/目标（容错：引擎方法参数不符时返回 unavailable，前端优雅降级）
    if (req.method === 'GET' && sub === 'goal') {
      try {
        const r = await agent.request('session/goal', { sessionId: sid, action: 'show' });
        return sendJson(res, 200, r ?? {});
      } catch (e) {
        return sendJson(res, 200, { unavailable: String(e?.message ?? e).slice(0, 200) });
      }
    }

    // 会话用量（token/缓存/成本，形状以引擎返回为准）
    if (req.method === 'GET' && sub === 'usage') {
      try {
        const r = await agent.request('session/usage', { sessionId: sid });
        return sendJson(res, 200, r ?? {});
      } catch (e) {
        return sendJson(res, 200, { unavailable: String(e?.message ?? e).slice(0, 200) });
      }
    }

    if (req.method === 'GET' && sub === 'messages') {
      // limit 可由查询参数覆盖：页面轮询用小 limit 轻量探测，变化才全量拉取
      const limit =
        Number(url.searchParams.get('limit')) || config.maxHistoryMessages;
      const r = await agent.request('session/messages', { sessionId: sid, limit });
      return sendJson(res, 200, { messages: r.messages ?? [] });
    }

    if (req.method === 'GET' && sub === 'stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      const s = sessionState(sid);
      const afterSeq = Number(url.searchParams.get('afterSeq') ?? '-1');
      for (const ev of s.ring) if ((ev.seq ?? 0) > afterSeq) {
        res.write(`id: ${ev.seq}\nevent: zcode\ndata: ${JSON.stringify(ev)}\n\n`);
      }
      s.subs.add(res);
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 15000);
      req.on('close', () => { clearInterval(hb); s.subs.delete(res); });
      return;
    }

    if (req.method === 'GET' && sub === 'queue') {
      return sendJson(res, 200, { queue: sessionState(sid).queue });
    }

    // 立即发出：把该项挪到队首并请求停止当前回合；停止完成后 flushQueue 优先补发
    if (req.method === 'POST' && sub === 'queue/send-now') {
      const body = await readBody(req);
      const id = String(body.id ?? '');
      const st = sessionState(sid);
      const idx = st.queue.findIndex((q) => q.id === id);
      if (idx < 0) return sendJson(res, 404, { error: '排队项不存在' });
      if (idx > 0) {
        const [item] = st.queue.splice(idx, 1);
        st.queue.unshift(item);
      }
      st.flushOnStop = true;
      if (st.lastSend?.timer) clearTimeout(st.lastSend.timer);
      st.lastSend = null;
      const r = await agent.request('session/stop', { sessionId: sid }).catch((e) => ({ error: e.message }));
      // 停止请求已下：引擎收尾有间隙，短延迟试发 + queuePoll 3s 周期兜底
      scheduleQueueFlush(sid, 2500);
      startQueuePoll(sid);
      return sendJson(res, 200, r ?? {});
    }

    if (req.method === 'POST' && sub === 'queue/remove') {
      const body = await readBody(req);
      const id = String(body.id ?? '');
      const st = sessionState(sid);
      const idx = st.queue.findIndex((q) => q.id === id);
      if (idx < 0) return sendJson(res, 404, { error: '排队项不存在' });
      const [item] = st.queue.splice(idx, 1);
      pushQueueState(sid);
      return sendJson(res, 200, { ok: true, removed: item, queue: st.queue });
    }

    if (req.method === 'POST' && sub === 'send') {
      const body = await readBody(req);
      const content = String(body.content ?? '').trim();
      if (!content) return sendJson(res, 400, { error: 'content 为空' });
      const st = sessionState(sid);
      if (!st.busy) {
        try {
          const r = await agent.request('session/send', { sessionId: sid, content, inputId: crypto.randomUUID() }, 120000);
          st.busy = true;
          if (!st.busySince) st.busySince = Date.now();
          // 记录本次发送：回合若因 429 限流失败可自动重试（见 scheduleRateLimitRetry）
          if (st.lastSend?.timer) clearTimeout(st.lastSend.timer);
          st.lastSend = { content, at: Date.now(), retries: 0, timer: null };
          return sendJson(res, 200, r);
        } catch (e) {
          // 回合由外进程（桌面端）驱动时本进程 busy 标记是 false，但引擎同样
          // 拒绝并发 send（-32010）——此时转入队，而非把错误抛给页面
          if (!SEND_BUSY_RE.test(String(e?.message ?? e))) throw e;
          st.busy = true;
          if (!st.busySince) st.busySince = Date.now();
        }
      }
      // 运行中：入队为"下一轮预备任务"，回合结束后由 flushQueue 自动补发
      enqueueMessage(sid, content);
      return sendJson(res, 200, { queued: true, queue: st.queue });
    }

    if (req.method === 'POST' && sub === 'stop') {
      const st = sessionState(sid);
      if (st.lastSend?.timer) clearTimeout(st.lastSend.timer);
      st.lastSend = null; // 用户主动停止：取消待执行的限流重试
      const r = await agent.request('session/stop', { sessionId: sid });
      return sendJson(res, 200, r ?? {});
    }

    if (req.method === 'POST' && sub === 'close') {
      const r = await agent.request('session/close', { sessionId: sid }).catch((e) => ({ error: e.message }));
      sessions.delete(sid);
      return sendJson(res, 200, r ?? {});
    }

    // 归档 / 取消归档：直接写共享 DB 的 session.time_archived（桌面版同源数据）。
    // 归档当前激活会话时顺带关闭引擎实例，避免僵尸 running。
    if (req.method === 'POST' && sub === 'archive') {
      const body = await readBody(req);
      const archived = body.archived !== false;
      dbArchiveSession(sid, archived);
      allListCache = null;
      if (archived) {
        const st = sessionState(sid);
        st.busy = false; st.busySince = 0;
        agent.request('session/close', { sessionId: sid }).catch(() => {});
        sessions.delete(sid);
      }
      return sendJson(res, 200, { archived, sessionId: sid });
    }

    // 删除会话：运行中拒绝；先关引擎实例再连带清全部 session 维度数据行。
    if (req.method === 'POST' && sub === 'delete') {
      const st = sessionState(sid);
      if (st.busy || sessionState(sid).lastSend?.timer) {
        return sendJson(res, 409, { error: '会话正在运行任务，先停止再删除' });
      }
      await agent.request('session/close', { sessionId: sid }).catch(() => {});
      sessions.delete(sid);
      try {
        dbDeleteSession(sid);
      } catch (e) {
        return sendJson(res, 500, { error: String(e?.message ?? e).slice(0, 200) });
      }
      allListCache = null;
      return sendJson(res, 200, { deleted: true, sessionId: sid });
    }

    // 任务计划（TodoWrite 落库的实时状态，桌面版同源数据）
    if (req.method === 'GET' && sub === 'todos') {
      return sendJson(res, 200, { todos: dbSessionTodos(sid) });
    }

    // 会话设置快照（session/read，消息取 1 条保持轻量）：模型菜单/思考档位/权限
    // 模式/上下文容量实时刷新用
    if (req.method === 'GET' && sub === 'settings') {
      try {
        const r = await agent.request('session/read', { sessionId: sid, messageLimit: 1 });
        const ps = projectSettings(r ?? {}, sid);
        return sendJson(res, 200, ps);
      } catch (e) {
        // 会话不在本进程激活（引擎重启后未 resume）：模型/档位拿不到，但
        // 上下文容量仍可从共享 DB 回答（页面弹卡需要它，不能整包 unavailable）
        const dbCtx = dbContextUsage(sid);
        if (dbCtx) {
          return sendJson(res, 200, {
            unavailable: String(e?.message ?? e).slice(0, 200),
            projection: {
              contextUsed: dbCtx.used,
              contextWindow: realContextWindow(dbCtx.providerId, dbCtx.modelId) ?? 200000,
              totalTokenCount: 0,
              status: '',
            },
          });
        }
        return sendJson(res, 200, { unavailable: String(e?.message ?? e).slice(0, 200) });
      }
    }

    // 切换模型（对照官方 GLM-5.3-Flash ▾ 菜单）；同时持久化为新会话默认。
    // 引擎对部分模型强制要求思考档位（如 z.ai 的 GLM-5.3-Flash），
    // 页面未带档位时回退到当前默认档位，避免 setModel 直接报错。
    if (req.method === 'POST' && sub === 'model') {
      const body = await readBody(req);
      const providerId = String(body.providerId ?? '').trim();
      const modelId = String(body.modelId ?? '').trim();
      if (!providerId || !modelId) return sendJson(res, 400, { error: 'providerId / modelId 必填' });
      const reasoningLevel = String(body.reasoningLevel ?? '').trim()
        || parseModelSelection(config.model)?.options?.reasoningLevel
        || '';
      const model = reasoningLevel
        ? { providerId, modelId, options: { reasoningLevel } }
        : { providerId, modelId };
      await agent.request('session/setModel', { sessionId: sid, model });
      persistModelConfig({ providerId, modelId, reasoningLevel });
      return sendJson(res, 200, { ok: true, model: modelRefToJson(model) });
    }

    // 切换思考档位（对照官方 低/高/最高 菜单）
    if (req.method === 'POST' && sub === 'thoughtLevel') {
      const body = await readBody(req);
      const thoughtLevel = String(body.thoughtLevel ?? '').trim();
      if (!thoughtLevel) return sendJson(res, 400, { error: 'thoughtLevel 必填' });
      await agent.request('session/setThoughtLevel', { sessionId: sid, thoughtLevel });
      // 档位并入 config.model 的 $ 后缀，新会话沿用
      const cur = parseModelSelection(config.model);
      if (cur) persistModelConfig({ ...cur, reasoningLevel: thoughtLevel });
      return sendJson(res, 200, { ok: true, thoughtLevel });
    }

    // 切换权限模式（对照官方 计划/变更前确认/自动编辑/完全访问 菜单）
    if (req.method === 'POST' && sub === 'mode') {
      const body = await readBody(req);
      const mode = String(body.mode ?? '').trim();
      if (!['plan', 'build', 'edit', 'yolo', 'auto'].includes(mode)) {
        return sendJson(res, 400, { error: `mode 不支持：${mode}` });
      }
      // 只改当前会话的模式（session/setMode 是会话级持久化，引擎落库）。
      // 之前这里连带 config.mode = mode 写全局默认——切某个会话的盾牌档位
      // 会悄悄改掉之后所有新建会话的默认模式，是两件不该耦合的事。
      await agent.request('session/setMode', { sessionId: sid, mode });
      return sendJson(res, 200, { ok: true, mode });
    }

    // 交互应答开关（审批是否落到手机端）：allow=自动放行权限请求/自动采纳
    // 提问第一选项；ask=推到手机端审批卡人工处理（30 分钟无应答自动拒绝）。
    // 运行时可改（config 对象内存生效 + saveConfig 落盘），无需重启服务。
    if (req.method === 'POST' && p === '/api/autoAnswer') {
      const body = await readBody(req);
      const v = String(body.autoAnswer ?? '').trim();
      if (!['allow', 'ask'].includes(v)) {
        return sendJson(res, 400, { error: `autoAnswer 不支持：${v}（仅 allow/ask）` });
      }
      config.autoAnswer = v;
      saveConfig(config);
      logLine('config', `autoAnswer -> ${v}`);
      return sendJson(res, 200, { ok: true, autoAnswer: v });
    }

    // 压缩上下文（对照官方容量卡的主动收缩入口）
    if (req.method === 'POST' && sub === 'compact') {
      const r = await agent.request('session/compact', { sessionId: sid });
      return sendJson(res, 200, r ?? { ok: true });
    }
  }

  if (req.method === 'GET' && p === '/api/plugins') {
    // 插件清单（只读 + 启停）；引擎不支持时优雅降级
    try {
      const r = await agent.request('plugins/list', { workspace: workspaceRef(url.searchParams.get('workspace')) });
      return sendJson(res, 200, r ?? {});
    } catch (e) {
      return sendJson(res, 200, { unavailable: String(e?.message ?? e).slice(0, 200) });
    }
  }

  if (req.method === 'POST' && p === '/api/plugins/setEnabled') {
    const body = await readBody(req);
    try {
      const r = await agent.request('plugins/setEnabled', { id: body.id, enabled: !!body.enabled });
      return sendJson(res, 200, r ?? { ok: true });
    } catch (e) {
      return sendJson(res, 200, { unavailable: String(e?.message ?? e).slice(0, 200) });
    }
  }

  // 技能目录（对照官方「选择技能」$ 菜单；只读引用投影）
  if (req.method === 'GET' && p === '/api/skills') {
    try {
      const r = await agent.request('skills/referenceCatalog', { workspace: workspaceRef(url.searchParams.get('workspace')) });
      const skills = (r.skills ?? []).map((s) => ({
        id: s.id, name: s.name, description: s.description ?? '',
        scope: s.scope ?? '', pluginName: s.pluginName ?? '',
      }));
      return sendJson(res, 200, { skills });
    } catch (e) {
      return sendJson(res, 200, { unavailable: String(e?.message ?? e).slice(0, 200) });
    }
  }

  // 已保存工作流（对照官方「工作流」菜单；工作区档 + 全局档合并）
  if (req.method === 'GET' && p === '/api/workflows') {
    const ws = workspaceRef(url.searchParams.get('workspace'));
    try {
      const [proj, glob] = await Promise.all([
        agent.request('workflows/list', { workspace: ws }).catch(() => ({})),
        agent.request('workflows/list', { workspace: ws, scope: 'global' }).catch(() => ({})),
      ]);
      const merge = (list, scope) => (Array.isArray(list) ? list : []).map((w) => ({
        name: w.name ?? '', description: w.description ?? '',
        args: Array.isArray(w.args) ? w.args : [], scope,
      }));
      return sendJson(res, 200, {
        workflows: [...merge(proj.workflows, 'project'), ...merge(glob.workflows, 'global')],
      });
    } catch (e) {
      return sendJson(res, 200, { unavailable: String(e?.message ?? e).slice(0, 200) });
    }
  }

  // 套餐概览（z.ai billing/current：套餐名/状态/额度/有效期；5 分钟缓存）
  if (req.method === 'GET' && p === '/api/plan') {
    try {
      const d = await fetchPlanOverview();
      const plans = (d.plans ?? []).map((pl) => ({
        name: pl.name ?? '',
        planId: pl.plan_id ?? '',
        status: pl.status ?? '',
        startsAt: pl.starts_at ?? 0,
        endsAt: pl.ends_at ?? 0,
        entitlements: (pl.entitlements ?? []).map((en) => ({
          model: en.show_name ?? '',
          grantUnits: en.grant_units ?? 0,
          unitType: en.unit_type ?? '',
          period: en.period ?? '',
        })),
      }));
      return sendJson(res, 200, { plans });
    } catch (e) {
      return sendJson(res, 200, { unavailable: String(e?.message ?? e).slice(0, 200) });
    }
  }

  // 本机用量统计（agent-db，与桌面端共用同一 sqlite：含桌面端驱动的会话）
  if (req.method === 'GET' && p === '/api/usage-stats') {
    const range = ['all', '7d', '30d'].includes(url.searchParams.get('range')) ? url.searchParams.get('range') : '7d';
    try {
      const r = await agent.request('usage/stats', { range });
      const s = r?.summary ?? {};
      return sendJson(res, 200, {
        range: r?.range ?? range,
        totalTokens: s.totalTokens ?? 0,
        inputTokens: s.inputTokens ?? 0,
        outputTokens: s.outputTokens ?? 0,
        cacheReadTokens: s.cacheReadTokens ?? 0,
        totalSessions: s.totalSessions ?? 0,
        totalTurns: s.totalTurns ?? 0,
      });
    } catch (e) {
      return sendJson(res, 200, { unavailable: String(e?.message ?? e).slice(0, 200) });
    }
  }

  if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'interactions' && seg[2]) {
    const requestId = decodeURIComponent(seg[2]);
    const body = await readBody(req);
    const entry = pendingInteractions.get(requestId);
    if (!entry) return sendJson(res, 404, { error: '交互请求不存在或已处理' });
    entry.resolve(body);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: `unknown api ${p}` });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (!checkAuth(req, url)) {
      return sendJson(res, 401, { error: 'token 无效。请经 SSH 隧道用 /?token=<访问令牌> 访问。' });
    }
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    const staticPath = path.join(PUBLIC_DIR, path.normalize(url.pathname).replace(/^([.][.][/\\])+/, ''));
    if (staticPath.startsWith(PUBLIC_DIR) && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(staticPath)] ?? 'application/octet-stream' });
      return res.end(fs.readFileSync(staticPath));
    }
    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    logLine('http-error', String(e?.message ?? e), { path: url.pathname });
    if (!res.headersSent) sendJson(res, 500, { error: String(e?.message ?? e) });
  }
});

// ────────────────────────── 启动 ──────────────────────────

server.listen(config.port, '127.0.0.1', () => {
  logLine('boot', `zcode-phone-server listening on http://127.0.0.1:${config.port}/?token=<token>`, {
    workspace: config.workspacePath,
    mode: config.mode,
    autoAnswer: config.autoAnswer,
    token: config.token, // 本机日志便于自测；服务只监听回环地址
  });
  console.log('');
  console.log('──────────────────────────────────────────────────');
  console.log('  zcode-phone-server 已启动');
  console.log(`  本机访问:  http://127.0.0.1:${config.port}/?token=${config.token}`);
  console.log(`  工作目录:  ${config.workspacePath}`);
  console.log(`  权限模式:  ${config.mode}   交互应答: ${config.autoAnswer}`);
  console.log('  手机端:    SSH 隧道 <本机端口> → 127.0.0.1:' + config.port);
  console.log('──────────────────────────────────────────────────');
});

agent.start();

process.on('SIGINT', () => {
  agent.stopping = true;
  agent.child?.kill();
  process.exit(0);
});
