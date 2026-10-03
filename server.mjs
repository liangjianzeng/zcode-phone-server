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
import fs from 'node:fs';
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
      if (apiKey) {
        // 桥默认使用开源引擎（ref/ZCode 构建产物，无 V4 签名层）：apiKey 原样
        // 透传，适配器自行设 x-api-key + Bearer（oauth JWT 实测直通端点）。
        // 若换回桌面闭源引擎（zcode.cjs），id.secret 形态的 key 仍走 apiKey 签名
        // 路径；JWT 形态则会被闭源签名器拒（invalid-config），需换回开源引擎。
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

/** sessionId → {subs:Set<res>, ring:[], busy:bool, title, lastSeq} */
const sessions = new Map();
/** requestId → {resolve, timer} */
const pendingInteractions = new Map();

function sessionState(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { subs: new Set(), ring: [], busy: false, title: '', lastSeq: 0 };
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
  if (event.type === 'turn.started') s.busy = true;
  if (event.type === 'turn.completed' || event.type === 'turn.failed') s.busy = false;
  pushSse(event.sessionId, event);
};

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
  if (isEvent) {
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

function workspaceRef(overridePath) {
  // 本地 workspace：workspaceKey = workspacePath（bootstrap/zcode-protocol/workspace.ts 约定）。
  // overridePath：多工作区切换时由请求显式指定（须在 config.workspaces 白名单内或等于主工作区）。
  const requested = String(overridePath ?? '').trim();
  let wp = config.workspacePath;
  if (requested) {
    const allowed = [config.workspacePath, ...(config.workspaces ?? []).map((w) => w.path)]
      .map((p) => path.resolve(String(p)));
    const resolved = path.resolve(requested);
    if (allowed.includes(resolved)) wp = resolved;
  }
  return { workspacePath: wp, workspaceKey: wp };
}

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

/** 桌面端 oauth 共享凭据键（providerId → credentials.json 键名）。 */
const OAUTH_ACCESS_KEY_BY_PROVIDER = {
  'account:bigmodel-individual-coding-plan': 'oauth:bigmodel:access_token',
  'account:zai-individual-coding-plan': 'oauth:zai:access_token',
};

/** 读取 Coding Plan api-key（standalone 键名规范见 bootstrap/src/app/standalone-account-provider-runtime.ts）。 */
function readCodingPlanApiKey(providerId) {
  // 优先级 1：config.json 显式配置的 Coding Plan API Key（id.secret 形态）。
  // 引擎对 zhipu-account provider 走 V4 请求签名，要求 apiKey 恰好一个「.」
  // （Glr：apiKeyId.apiKeySecret）；桌面端 oauth 的 access_token 是 JWT（多个点），
  // 直接作 apiKey 会被签名器拒（invalid-config），作 headers 又过不了适配器的
  // loadApiKey 强校验——所以 JWT 只能推动授权，真正推理必须用 id.secret 的 key。
  // 创建入口：https://bigmodel.cn/usercenter/proj-mgmt/apikeys
  const configured = String(config.codingPlanApiKey ?? '').trim();
  if (configured) return configured;
  try {
    const raw = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
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
    // 桌面端登录把凭据重写为 oauth:* 共享键（engine 的 createSharedZCodeCredentialStore）。
    // oauth access_token（JWT）可推动授权推送，但过不了引擎的凭据强度校验。
    const oauthKey = OAUTH_ACCESS_KEY_BY_PROVIDER[providerId];
    if (oauthKey) {
      const v = decryptCredential(raw[oauthKey] ?? '').trim();
      if (v) {
        logLine('account', '仅有 oauth JWT 凭据：可完成授权推送，但推理需 standalone '
          + 'coding-plan api-key（桌面端重登录后写入 account-provider:coding-plan:* 键）');
        return v;
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

/** 当前机器上已连接（有凭据）的 Coding Plan provider id。
 *  优先有 standalone api-key 的（能真正推理）；oauth 兜底只在其后考虑。 */
function connectedProviderId() {
  const all = ['account:bigmodel-individual-coding-plan', 'account:zai-individual-coding-plan'];
  for (const pid of all) {
    // 只认 standalone 键命中（有真凭据能推理）
    try {
      const raw = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
      const hit = Object.keys(raw).some((k) =>
        k.startsWith('account-provider:coding-plan:') && k.includes(`:${pid}:`) && k.endsWith(':api-key'));
      if (hit) return pid;
    } catch { /* fallthrough */ }
  }
  // 无 standalone：退而求其次取任一有 oauth JWT 的（可推授权，推理不可用）
  for (const pid of all) {
    if (readCodingPlanApiKey(pid)) return pid;
  }
  return undefined;
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
  const seg = p.split('/').filter(Boolean); // ['api', ...]

  if (req.method === 'GET' && p === '/api/state') {
    return sendJson(res, 200, {
      workspacePath: config.workspacePath,
      mode: config.mode,
      autoAnswer: config.autoAnswer,
      agentRunning: !!agent.child,
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
    const r = await agent.request('session/list', { workspace: workspaceRef(ws), limit: 50, includeArchived: false });
    const list = (r.sessions ?? []).map((s) => ({
      sessionId: s.sessionId,
      title: s.title,
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
      snap = await agent.request('session/resume', { sessionId: sid, workspace: wsRef }, 180000);
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
    });
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
      const r = await agent.request('session/messages', { sessionId: sid, limit: config.maxHistoryMessages });
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

    if (req.method === 'POST' && sub === 'send') {
      const body = await readBody(req);
      const content = String(body.content ?? '').trim();
      if (!content) return sendJson(res, 400, { error: 'content 为空' });
      if (sessionState(sid).busy) return sendJson(res, 409, { error: '当前回合仍在运行，请先停止或等待完成' });
      const r = await agent.request('session/send', { sessionId: sid, content, inputId: crypto.randomUUID() }, 120000);
      sessionState(sid).busy = true;
      return sendJson(res, 200, r);
    }

    if (req.method === 'POST' && sub === 'stop') {
      const r = await agent.request('session/stop', { sessionId: sid });
      return sendJson(res, 200, r ?? {});
    }

    if (req.method === 'POST' && sub === 'close') {
      const r = await agent.request('session/close', { sessionId: sid }).catch((e) => ({ error: e.message }));
      sessions.delete(sid);
      return sendJson(res, 200, r ?? {});
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
