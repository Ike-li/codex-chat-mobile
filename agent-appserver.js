// agent-appserver.js —— Codex 会话桥（app-server 模式，唯一后端）。
// 长驻 `codex app-server` 子进程，走 JSON-RPC over stdio（NDJSON）。
// 与 server.js 的 CodexAppServerSession 接口一致（send/abort/dispose/emit/eventsSince）。
//
// 进程长驻、原生流式（item/agentMessage/delta）、支持手机端审批。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ApprovalBroker } from './approval-broker.js';
import { writeOwnerOnlyFile } from './file-security.js';
import { sanitize, sanitizePath } from './sanitizer.js';

const BUFFER_CAP = 500;
const TOOL_SUMMARY_CAP = 600;
const DEFAULT_INPUT_QUEUE_LIMIT = 20;
const DEFAULT_INTERRUPT_TIMEOUT_MS = 2000;
const DEFAULT_BACKPRESSURE_RETRIES = 5;
const DEFAULT_BACKPRESSURE_BASE_MS = 250;
const MAX_BACKPRESSURE_DELAY_MS = 5000;
const RPC_SUMMARY_CAP = 240;
const SENSITIVE_RPC_KEY_RE = /(token|secret|password|passwd|credential|authorization|api[_-]?key|private[_-]?key|refreshToken|accessToken|chatgptAuthTokens|dataBase64)/i;
const CONTENT_RPC_KEY_RE = /^(text|input|prompt|content|delta|aggregatedOutput|output|diff|data)$/i;

let instanceCounter = 0;
function nextEpoch() {
  return `${Date.now()}.${++instanceCounter}`;
}

export class CodexAppServerSession {
  constructor({ instanceId, resumeId, cwd, codexBin, idleTimeoutMs, onEvent, onSessionId, onExit, rpcLogPath }) {
    this.instanceId = instanceId;
    this.cwd = cwd;
    this.codexBin = codexBin || 'codex';
    this.idleTimeoutMs = idleTimeoutMs || 600000;
    this.onEvent = onEvent;
    this.onSessionId = onSessionId;
    this.onExit = onExit;

    this.sessionId = resumeId || null; // = threadId
    this.epoch = nextEpoch();
    this.seq = 0;
    this.buffer = [];
    this.bufferTrimmed = false;
    this.firstMessage = null;

    this.child = null;
    this.busy = false;
    this.disposed = false;
    this.lastActivity = Date.now();
    this.idleTimer = null;

    this.rpcId = 0;
    this.pending = new Map(); // id -> { resolve, reject }
    this.rpcLogPath = rpcLogPath || join(this.cwd, '.codex-chat-rpc.jsonl');
    this.rpcStats = {
      clientRequests: 0,
      clientResponses: 0,
      clientNotifications: 0,
      serverRequests: 0,
      serverResponses: 0,
      serverNotifications: 0,
      errors: 0,
    };
    this.initialized = null;  // initialize + initialized notification
    this.ready = null;        // initialize + thread 就绪的 promise（只做一次）
    this.stdoutBuf = '';
    this.backpressureRetries = new Set();
    this.pendingApprovals = new Set(); // 等待手机 decision 的 server→client 请求 id
    this.approvalBroker = new ApprovalBroker({
      emit: (type, payload) => this.emit(type, payload),
      respond: (approvalId, result) => this.respond(approvalId, result),
      pendingApprovals: this.pendingApprovals,
      auditPath: join(this.cwd, '.codex-chat-approval-audit.jsonl'),
    });
    this.inputQueue = [];
    this.inputQueueLimit = numberFromEnv('CODEX_INPUT_QUEUE_LIMIT', DEFAULT_INPUT_QUEUE_LIMIT);
    this.interruptTimeoutMs = numberFromEnv('CODEX_INTERRUPT_TIMEOUT_MS', DEFAULT_INTERRUPT_TIMEOUT_MS);
    this.currentTurnId = null;
    this.drainScheduled = false;
    // 审批/沙箱（仅 app-server 后端）：默认 on-request + workspace-write，可经环境变量覆盖。
    this.approvalPolicy = process.env.CODEX_APPROVAL_POLICY || 'on-request';
    this.sandbox = process.env.CODEX_SANDBOX || 'workspace-write';
  }

  // ---- 子进程与 JSON-RPC 底层 ----
  spawnIfNeeded() {
    if (this.child) return;
    this.child = spawn(this.codexBin, ['app-server'], {
      cwd: this.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'] // 需要 stdin 写 JSON-RPC，故 pipe（与 exec 模式不同）
    });
    this.child.stdout.on('data', d => this.onStdout(d));
    this.child.stderr.on('data', d => {
      if (process.env.LOG_STDERR) console.error('[codex]', sanitize(d.toString()));
    });
    this.child.on('close', () => {
      this.busy = false;
      this.child = null;
      this.initialized = null;
      this.ready = null;
      this.clearQueue('process_exit');
      this.approvalBroker.clearPending();
      this.clearBackpressureRetries(new Error('app-server 进程已退出'));
      this.rejectAllPending(new Error('app-server 进程已退出'));
      clearInterval(this.idleTimer); this.idleTimer = null;
      if (!this.disposed) this.emitStatus('process_exit');
      if (!this.disposed) this.onExit?.();
    });
    this.child.on('error', err => {
      this.busy = false;
      this.child = null;
      this.clearQueue('process_error');
      this.clearBackpressureRetries(err);
      this.rejectAllPending(err);
      this.emit('error', { message: `codex app-server 启动失败：${sanitize(err.message)}`, recoverable: false });
      this.emitStatus('process_error');
    });
    this.idleTimer = setInterval(() => this.checkIdle(), 30_000);
  }

  rejectAllPending(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  clearBackpressureRetries(err) {
    for (const retry of this.backpressureRetries) {
      clearTimeout(retry.timer);
      retry.reject(err);
    }
    this.backpressureRetries.clear();
  }

  onStdout(d) {
    this.lastActivity = Date.now();
    this.stdoutBuf += d.toString();
    const lines = this.stdoutBuf.split('\n');
    this.stdoutBuf = lines.pop();
    for (const line of lines) {
      if (line.trim()) this.handleLine(line.trim());
    }
  }

  handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    // server→client 请求：有 method 且有 id（无 result/error）→ 必须回应，否则 agent 挂起。
    if (msg.method && msg.id !== undefined) {
      this.observeRpc('server_request', { direction: 'inbound', id: msg.id, method: msg.method, params: msg.params || {} });
      this.handleServerRequest(msg.id, msg.method, msg.params || {});
      return;
    }
    // 对我方请求的响应：有 id + result/error。
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        this.observeRpc('response', {
          direction: 'inbound',
          id: msg.id,
          method: p.method || null,
          result: msg.result,
          error: msg.error,
        });
        if (msg.error) p.reject(rpcError(msg.error));
        else p.resolve(msg.result);
      }
      return;
    }
    // 通知。
    if (msg.method) {
      this.observeRpc('notification', { direction: 'inbound', method: msg.method, params: msg.params || {} });
      this.handleNotification(msg.method, msg.params || {});
    }
  }

  // server→client 请求处理。审批类透传给手机；其余安全兜底回应，避免 agent 挂起。
  handleServerRequest(rpcId, method, params) {
    if (this.approvalBroker.handleRequest(rpcId, method, params)) {
      this.emitStatus('approval_requested');
    } else if (method === 'account/chatgptAuthTokens/refresh') {
      this.respondError(rpcId, -32601, `Unsupported server request: ${method}`);
      this.emit('system', {
        message: `ChatGPT auth token refresh is not supported by this bridge; no credentials were stored or forwarded: ${method}`,
        isError: true
      });
    } else {
      this.respondError(rpcId, -32601, `Unsupported server request: ${method}`);
      this.emit('system', {
        message: `Unsupported server request from Codex app-server: ${method}`,
        isError: true
      });
    }
  }

  respond(rpcId, result) {
    if (!this.child) return;
    this.observeRpc('response', { direction: 'outbound', id: rpcId, result });
    this.child.stdin.write(JSON.stringify({ id: rpcId, result }) + '\n');
  }

  respondError(rpcId, code, message) {
    if (!this.child) return;
    this.observeRpc('response', { direction: 'outbound', id: rpcId, error: { code, message } });
    this.child.stdin.write(JSON.stringify({ id: rpcId, error: { code, message } }) + '\n');
  }

  // 手机回传 decision（accept|acceptForSession|decline|cancel）。
  respondApproval(approvalId, decision, extra) {
    const ok = this.approvalBroker.respondApproval(approvalId, decision, extra);
    if (ok) this.emitStatus('approval_resolved');
    return ok;
  }

  request(method, params, options = {}) {
    const maxBackpressureRetries = integerOption(
      options.maxBackpressureRetries,
      numberFromEnv('CODEX_BACKPRESSURE_RETRIES', DEFAULT_BACKPRESSURE_RETRIES),
      { allowZero: true }
    );
    const backpressureBaseMs = integerOption(
      options.backpressureBaseMs,
      numberFromEnv('CODEX_BACKPRESSURE_BASE_MS', DEFAULT_BACKPRESSURE_BASE_MS)
    );
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 0;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = fn => value => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      const resolveOnce = finish(resolve);
      const rejectOnce = finish(reject);

      const sendAttempt = attempt => {
        if (settled) return;
        if (this.disposed) {
          rejectOnce(new Error('disposed'));
          return;
        }
        this.spawnIfNeeded();
        const id = ++this.rpcId;
        let timer = null;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          timer = null;
        };
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            this.pending.delete(id);
            rejectOnce(new Error(`${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }
        this.pending.set(id, {
          method,
          resolve: value => {
            cleanup();
            resolveOnce(value);
          },
          reject: err => {
            cleanup();
            if (isBackpressureError(err) && attempt < maxBackpressureRetries) {
              const delayMs = backpressureDelayMs(attempt, backpressureBaseMs);
              this.emit('system', {
                message: `Codex app-server 拥塞，${delayMs}ms 后重试 ${method}（${attempt + 1}/${maxBackpressureRetries}）`,
                isError: false,
                code: -32001,
                method,
                retryAfterMs: delayMs,
                attempt: attempt + 1,
                maxRetries: maxBackpressureRetries,
              });
              this.emitStatus('backpressure_retry');
              const retry = {
                timer: null,
                reject: rejectOnce,
              };
              retry.timer = setTimeout(() => {
                this.backpressureRetries.delete(retry);
                sendAttempt(attempt + 1);
              }, delayMs);
              this.backpressureRetries.add(retry);
              return;
            }
            if (isBackpressureError(err)) {
              this.emit('system', {
                message: `Codex app-server 仍然拥塞，超过重试上限（${maxBackpressureRetries}）`,
                isError: true,
                code: -32001,
                method,
              });
              this.emitStatus('backpressure_failed');
            }
            rejectOnce(err);
          },
        });
        try {
          this.observeRpc('request', { direction: 'outbound', id, method, params });
          this.child.stdin.write(JSON.stringify({ method, id, params }) + '\n');
        } catch (err) {
          this.pending.delete(id);
          cleanup();
          rejectOnce(err);
        }
      };

      sendAttempt(0);
    });
  }

  notify(method, params) {
    this.spawnIfNeeded();
    this.observeRpc('notification', { direction: 'outbound', method, params });
    this.child.stdin.write(JSON.stringify({ method, params }) + '\n');
  }

  // initialize app-server，只执行一次；登录等非 thread 操作也复用它。
  ensureInitialized() {
    if (this.initialized) return this.initialized;
    this.initialized = (async () => {
      await this.request('initialize', {
        clientInfo: { name: 'codex-chat-mobile', title: 'Codex Chat Mobile', version: '0.1.0' }
      });
      this.notify('initialized', {});
    })();
    return this.initialized;
  }

  // initialize + 建/续 thread，只执行一次。
  ensureReady() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      await this.ensureInitialized();
      if (this.sessionId) {
        if (process.env.LOG_STDERR) console.error('[appserver] thread/resume', { approvalPolicy: this.approvalPolicy, sandbox: this.sandbox });
        await this.request('thread/resume', { threadId: this.sessionId, cwd: this.cwd, approvalPolicy: this.approvalPolicy, sandbox: this.sandbox });
      } else {
        if (process.env.LOG_STDERR) console.error('[appserver] thread/start', { approvalPolicy: this.approvalPolicy, sandbox: this.sandbox });
        const r = await this.request('thread/start', { cwd: this.cwd, approvalPolicy: this.approvalPolicy, sandbox: this.sandbox });
        this.sessionId = r?.thread?.id ?? r?.threadId ?? null;
        if (this.sessionId) this.onSessionId?.(this.sessionId, this.firstMessage);
      }
      this.emit('init', { sessionId: this.sessionId, cwd: this.cwd });
      this.emitStatus('ready');
    })();
    return this.ready;
  }

  async send(text, savedAttachments) {
    text = typeof text === 'string' ? text.trim() : '';
    if (!text) return false;
    if (this.disposed) return false;
    if (this.busy) {
      if (this.currentTurnId) return this.steerTurn(text, savedAttachments);
      return this.enqueueInput(text, savedAttachments);
    }

    return this.startTurn(text, savedAttachments);
  }

  enqueueInput(text, savedAttachments) {
    if (this.inputQueue.length >= this.inputQueueLimit) {
      this.emit('system', { message: `输入队列已满（上限 ${this.inputQueueLimit} 条），请等待当前任务完成后再发送`, isError: true });
      this.emitStatus('queue_full');
      return false;
    }
    const entry = { text, savedAttachments, queuedAt: Date.now() };
    this.inputQueue.push(entry);
    this.emit('queued_message', {
      text,
      queuedAt: entry.queuedAt,
      position: this.inputQueue.length,
      queueLength: this.inputQueue.length
    });
    this.emitStatus('queued');
    return true;
  }

  async startTurn(text, savedAttachments) {
    this.busy = true;
    this.lastActivity = Date.now();
    // 有附件时注入路径到 prompt
    const promptText = savedAttachments?.length
      ? this.buildPromptText(text, savedAttachments)
      : text;
    if (this.firstMessage === null) this.firstMessage = text;
    // user_message 带附件元数据（不含服务端路径）
    const attachMeta = savedAttachments?.length
      ? savedAttachments.map(a => ({ name: a.name, mimeType: a.mimeType, size: a.size }))
      : undefined;
    this.emit('user_message', { text, attachments: attachMeta });
    this.emitStatus('turn_started');

    try {
      await this.ensureReady();
      // turn/start 立即返回 inProgress；完成经 turn/completed 通知。
      const turnStart = await this.request('turn/start', {
        threadId: this.sessionId,
        cwd: this.cwd,
        input: [{ type: 'text', text: promptText }]
      });
      this.recordCurrentTurn(turnStart);
      this.emitStatus('turn_submitted');
    } catch (err) {
      this.busy = false;
      this.emit('error', { message: `turn/start 失败：${sanitize(String(err?.message || err))}`, recoverable: true });
      this.emitStatus('turn_start_failed');
      return false;
    }
    return true;
  }

  async steerTurn(text, savedAttachments) {
    const expectedTurnId = this.currentTurnId;
    const promptText = savedAttachments?.length
      ? this.buildPromptText(text, savedAttachments)
      : text;
    const attachMeta = savedAttachments?.length
      ? savedAttachments.map(a => ({ name: a.name, mimeType: a.mimeType, size: a.size }))
      : undefined;
    this.emit('user_message', { text, attachments: attachMeta });

    try {
      await this.ensureReady();
      const steer = await this.request('turn/steer', {
        threadId: this.sessionId,
        input: [{ type: 'text', text: promptText }],
        expectedTurnId
      });
      this.recordCurrentTurn(steer);
      this.emit('system', {
        message: '已向当前运行任务追加指令',
        isError: false,
        turnId: steer?.turnId || expectedTurnId
      });
      this.emitStatus('steer_submitted');
    } catch (err) {
      this.emit('error', { message: `turn/steer 失败：${sanitize(String(err?.message || err))}`, recoverable: true });
      this.emitStatus('steer_failed');
      return false;
    }
    return true;
  }

  buildPromptText(text, savedAttachments) {
    const base = (text || '').trim();
    if (!savedAttachments || savedAttachments.length === 0) return base;
    const block = '[附件] 已上传到工作目录，可用 Read 读取：\n' + savedAttachments.map(a => a.absPath).join('\n');
    return base ? `${base}\n\n${block}` : block;
  }

  scheduleDrain() {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drainQueue().catch(err => {
        this.emit('error', { message: `队列继续执行失败：${sanitize(String(err?.message || err))}`, recoverable: true });
        this.emitStatus('queue_error');
      });
    });
  }

  async drainQueue() {
    if (this.disposed || this.busy || this.inputQueue.length === 0) return false;
    const next = this.inputQueue.shift();
    this.emit('dequeued_message', {
      text: next.text,
      queuedAt: next.queuedAt,
      queueLength: this.inputQueue.length
    });
    this.emitStatus('dequeued');
    return this.startTurn(next.text, next.savedAttachments);
  }

  // ---- app-server 通知 → 统一信封 ----
  handleNotification(method, params) {
    this.lastActivity = Date.now();
    switch (method) {
      case 'item/agentMessage/delta':
        if (params.delta) this.emit('text_delta', { text: params.delta });
        break;
      case 'item/commandExecution/outputDelta':
        this.handleCommandOutputDelta(params);
        break;
      case 'serverRequest/resolved':
        this.handleServerRequestResolved(params);
        break;
      case 'item/started':
        this.approvalBroker.registerItem(params.item);
        this.handleItem(params.item, false);
        break;
      case 'item/completed':
        this.handleItem(params.item, true);
        break;
      case 'thread/tokenUsage/updated':
        this.lastUsage = params.tokenUsage?.last ?? params.tokenUsage;
        this.emit('usage', { usage: params.tokenUsage?.last ?? params.tokenUsage });
        break;
      case 'thread/archived':
        this.emitThreadEvent('archived', params);
        break;
      case 'thread/unarchived':
        this.emitThreadEvent('unarchived', params);
        break;
      case 'thread/deleted':
        this.emitThreadEvent('deleted', params);
        break;
      case 'thread/name/updated':
        this.emitThreadEvent('name_updated', {
          ...params,
          name: params.threadName ?? params.name ?? null,
        });
        break;
      case 'thread/compacted':
        this.emit('compact', {
          status: 'compacted',
          threadId: params.threadId || null,
          turnId: params.turnId || null,
        });
        break;
      case 'account/rateLimits/updated':
        this.emit('rate_limits', params || {});
        break;
      case 'mcpServer/startupStatus/updated':
        this.emit('mcp_status', params || {});
        break;
      case 'skills/changed':
        this.emit('skills_changed', params || {});
        break;
      case 'externalAgentConfig/import/progress':
        this.emit('external_agent_config_import', { status: 'progress', ...(params || {}) });
        break;
      case 'externalAgentConfig/import/completed':
        this.emit('external_agent_config_import', { status: 'completed', ...(params || {}) });
        break;
      case 'turn/plan/updated':
        this.emit('plan', { plan: params.plan || [], explanation: params.explanation });
        break;
      case 'turn/started':
        this.recordCurrentTurn(params);
        break;
      case 'turn/diff/updated':
        if (params.diff) this.emit('diff', { diff: truncate(params.diff, TOOL_SUMMARY_CAP * 2) });
        break;
      case 'item/reasoning/summaryTextDelta':
        if (params.delta) this.emit('reasoning', reasoningPayload(params, {
          text: params.delta,
          channel: 'summary',
          kind: 'summary_text_delta',
          indexKey: 'summaryIndex'
        }));
        break;
      case 'item/reasoning/textDelta':
        if (params.delta) this.emit('reasoning', reasoningPayload(params, {
          text: params.delta,
          channel: 'full',
          kind: 'text_delta',
          indexKey: 'contentIndex'
        }));
        break;
      case 'item/reasoning/summaryPartAdded':
        this.emit('reasoning', reasoningPayload(params, {
          text: '',
          channel: 'summary',
          kind: 'summary_part_added',
          indexKey: 'summaryIndex'
        }));
        break;
      case 'account/login/completed':
        this.emit('account_login', {
          status: params.success ? 'completed' : 'failed',
          loginId: params.loginId ?? null,
          success: params.success === true,
          error: params.error ?? null
        });
        break;
      case 'account/updated':
        this.emit('account_updated', {
          authMode: params.authMode ?? null,
          planType: params.planType ?? null
        });
        break;
      case 'error':
        this.handleErrorNotification(params);
        break;
      case 'turn/completed':
        this.clearCurrentTurn(params);
        this.approvalBroker.clearItems();
        this.handleTurnCompleted(params);
        break;
      case 'turn/failed':
        this.clearCurrentTurn(params);
        this.approvalBroker.clearItems();
        this.finishTurnFailure(turnErrorMessage(params), 'turn_failed');
        break;
      // 忽略：thread/started、thread/status/changed、mcpServer/*、skills/changed、account/*、remoteControl/* 等。
    }
  }

  handleErrorNotification(params) {
    const message = protocolErrorMessage(params, 'codex app-server error');
    const willRetry = params.willRetry === true;
    this.emit('system', {
      message: willRetry ? `Codex 正在重试：${message}` : message,
      isError: !willRetry,
      willRetry,
      threadId: params.threadId || null,
      turnId: params.turnId || null
    });
    this.emitStatus(willRetry ? 'turn_retrying' : 'server_error');
  }

  emitThreadEvent(event, params) {
    this.emit('thread_event', {
      event,
      threadId: params?.threadId || null,
      name: params?.name ?? params?.threadName ?? null,
    });
  }

  handleTurnCompleted(params) {
    const status = params.turn?.status || params.status || 'completed';
    if (status === 'completed') {
      this.busy = false;
      this.approvalBroker.clearPending();
      this.emit('result', { ok: true, status });
      this.emitStatus('turn_completed');
      this.scheduleDrain();
      return;
    }
    if (status === 'failed') {
      this.finishTurnFailure(turnErrorMessage(params), 'turn_failed');
      return;
    }
    if (status === 'interrupted') {
      this.finishTurnFailure(turnErrorMessage(params, '任务已中断'), 'turn_interrupted');
      return;
    }

    this.busy = false;
    this.approvalBroker.clearPending();
    this.emit('result', { ok: false, status });
    this.emitStatus('turn_completed');
    this.scheduleDrain();
  }

  finishTurnFailure(message, statusReason) {
    this.busy = false;
    this.approvalBroker.clearPending();
    this.emit('error', { message, recoverable: true });
    this.emitStatus(statusReason);
    this.scheduleDrain();
  }

  handleCommandOutputDelta(params) {
    const text = params.delta ?? params.text ?? params.output ?? '';
    if (!text) return;
    this.emit('tool_output_delta', {
      toolUseId: params.itemId || params.toolUseId || params.item?.id || null,
      text,
      stream: params.stream || params.channel || 'stdout'
    });
  }

  handleServerRequestResolved(params) {
    this.approvalBroker.handleResolved(params);
  }

  recordCurrentTurn(source) {
    const turnId = source?.turn?.id ?? source?.turnId ?? source?.id;
    if (typeof turnId === 'string' && turnId) this.currentTurnId = turnId;
  }

  clearCurrentTurn(source) {
    const turnId = source?.turn?.id ?? source?.turnId ?? source?.id;
    if (!turnId || turnId === this.currentTurnId) this.currentTurnId = null;
  }

  // app-server item（camelCase）：
  //   agentMessage:     { type, id, text } —— 正文已由 delta 流给出，completed 不重复发。
  //   commandExecution: { type, id, command, aggregatedOutput, exitCode, status }
  handleItem(item, completed) {
    if (!item || !item.type) return;
    switch (item.type) {
      case 'agentMessage':
        break; // 流式 delta 已处理
      case 'commandExecution':
        if (!completed) {
          this.emit('tool_use', {
            toolUseId: item.id,
            name: 'ShellCall',
            inputSummary: truncate(item.command || '', TOOL_SUMMARY_CAP)
          });
        } else {
          this.emit('tool_result', {
            toolUseId: item.id,
            ok: item.exitCode === 0,
            exitCode: item.exitCode,
            status: item.status || 'completed',
            outputSummary: truncate(item.aggregatedOutput || '', TOOL_SUMMARY_CAP)
          });
        }
        break;
      case 'fileChange':
        if (completed) {
          this.emit('file_change', {
            itemId: item.id,
            status: item.status,
            files: (item.changes || []).map(c => ({
              path: c.path,
              kind: (c.kind && c.kind.type) || c.kind || 'modify',
              diff: truncate(c.diff || '', TOOL_SUMMARY_CAP)
            }))
          });
        }
        break;
      case 'mcpToolCall':
        if (!completed) {
          this.emit('mcp_use', {
            toolUseId: item.id,
            serverName: item.serverName || 'unknown',
            toolName: item.toolName || 'unknown',
            inputSummary: truncate(typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}), TOOL_SUMMARY_CAP)
          });
        } else {
          this.emit('mcp_result', {
            toolUseId: item.id,
            ok: !item.error,
            outputSummary: truncate(item.error?.message || item.result || '', TOOL_SUMMARY_CAP)
          });
        }
        break;
      case 'webSearch':
        if (completed && item.query) {
          this.emit('search', {
            query: item.query,
            results: (item.results || []).map(r => ({ title: r.title, url: r.url, snippet: truncate(r.snippet || '', TOOL_SUMMARY_CAP) }))
          });
        }
        break;
      default:
        this.emit('raw_item', {
          completed,
          item: truncatePayload(item, TOOL_SUMMARY_CAP * 2)
        });
        break;
    }
  }

  checkIdle() {
    if (!this.busy) return;
    if (Date.now() - this.lastActivity > this.idleTimeoutMs) {
      this.emit('error', {
        message: `任务静默超过 ${Math.round(this.idleTimeoutMs / 60000)} 分钟，已中断`,
        recoverable: true
      });
      this.abort();
    }
  }

  async abort() {
    if (this.child && this.sessionId && this.currentTurnId) {
      try {
        await this.request('turn/interrupt', {
          threadId: this.sessionId,
          turnId: this.currentTurnId
        }, { timeoutMs: this.interruptTimeoutMs });
      } catch (err) {
        this.emit('system', {
          message: `turn/interrupt 请求失败，已执行本地中断复位：${sanitize(String(err?.message || err))}`,
          isError: true
        });
      }
    }
    const dropped = this.clearQueue('interrupt');
    this.busy = false;
    this.approvalBroker.clearPending();
    this.approvalBroker.clearItems();
    this.currentTurnId = null;
    this.emitStatus(dropped ? 'interrupt_cleared_queue' : 'interrupt');
  }

  async forkThread(options = {}) {
    await this.ensureReady();
    const threadId = typeof options.threadId === 'string' && options.threadId
      ? options.threadId
      : this.sessionId;
    if (!threadId) throw new Error('无法 fork：当前实例没有可用 threadId');
    return this.request('thread/fork', {
      threadId,
      cwd: this.cwd,
      approvalPolicy: this.approvalPolicy,
      sandbox: this.sandbox,
      ephemeral: options.ephemeral === true
    });
  }

  async startChatgptDeviceLogin() {
    await this.ensureInitialized();
    const response = await this.request('account/login/start', { type: 'chatgptDeviceCode' });
    if (response?.type === 'chatgptDeviceCode') {
      this.emit('account_login', {
        status: 'pending',
        loginId: response.loginId,
        verificationUrl: response.verificationUrl,
        userCode: response.userCode
      });
    }
    return response;
  }

  async cancelLogin(loginId) {
    await this.ensureInitialized();
    const response = await this.request('account/login/cancel', { loginId });
    this.emit('account_login', {
      status: response?.status === 'canceled' ? 'canceled' : 'cancel_missing',
      loginId,
      cancelStatus: response?.status || null
    });
    return response;
  }

  async listThreads(options = {}) {
    await this.ensureInitialized();
    return this.request('thread/list', definedParams({
      cwd: options.cwd ?? this.cwd,
      archived: options.archived ?? false,
      limit: options.limit,
      cursor: options.cursor,
      sortKey: options.sortKey,
      sortDirection: options.sortDirection,
      searchTerm: options.searchTerm,
      sourceKinds: options.sourceKinds,
      modelProviders: options.modelProviders,
      useStateDbOnly: options.useStateDbOnly,
    }));
  }

  async archiveThread(threadId) {
    await this.ensureInitialized();
    return this.request('thread/archive', { threadId: requireThreadId(threadId, 'archive') });
  }

  async unarchiveThread(threadId) {
    await this.ensureInitialized();
    return this.request('thread/unarchive', { threadId: requireThreadId(threadId, 'unarchive') });
  }

  async deleteThread(threadId) {
    await this.ensureInitialized();
    return this.request('thread/delete', { threadId: requireThreadId(threadId, 'delete') });
  }

  async renameThread(threadId, name) {
    await this.ensureInitialized();
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('thread name is required');
    return this.request('thread/name/set', { threadId: requireThreadId(threadId, 'rename'), name: trimmed });
  }

  async compactThread(threadId = this.sessionId) {
    await this.ensureInitialized();
    return this.request('thread/compact/start', { threadId: requireThreadId(threadId, 'compact') });
  }

  async rollbackThread(options = {}) {
    await this.ensureInitialized();
    const numTurns = Number.isInteger(options.numTurns) && options.numTurns >= 1 ? options.numTurns : 1;
    return this.request('thread/rollback', {
      threadId: requireThreadId(options.threadId || this.sessionId, 'rollback'),
      numTurns,
    });
  }

  async listModels(options = {}) {
    await this.ensureInitialized();
    return this.request('model/list', definedParams({
      includeHidden: options.includeHidden ?? false,
      limit: options.limit ?? 100,
      cursor: options.cursor,
    }));
  }

  async readModelProviderCapabilities() {
    await this.ensureInitialized();
    return this.request('modelProvider/capabilities/read', {});
  }

  async readDirectory(path) {
    await this.ensureInitialized();
    return this.request('fs/readDirectory', { path: requireAbsolutePath(path, 'directory path') });
  }

  async readFile(path) {
    await this.ensureInitialized();
    return this.request('fs/readFile', { path: requireAbsolutePath(path, 'file path') });
  }

  async readAccount() {
    await this.ensureInitialized();
    return this.request('account/read', undefined);
  }

  async readUsage() {
    await this.ensureInitialized();
    return this.request('account/usage/read', undefined);
  }

  async readRateLimits() {
    await this.ensureInitialized();
    return this.request('account/rateLimits/read', undefined);
  }

  async listMcpServerStatus(options = {}) {
    await this.ensureInitialized();
    return this.request('mcpServerStatus/list', definedParams({
      detail: options.detail ?? 'Summary',
      limit: options.limit,
      cursor: options.cursor,
      threadId: options.threadId ?? this.sessionId ?? null,
    }));
  }

  async listSkills(options = {}) {
    await this.ensureInitialized();
    return this.request('skills/list', definedParams({
      cwds: options.cwds ?? [this.cwd],
      forceReload: options.forceReload,
    }));
  }

  async detectExternalAgentConfig(options = {}) {
    await this.ensureInitialized();
    return this.request('externalAgentConfig/detect', definedParams({
      includeHome: options.includeHome ?? false,
      cwds: options.cwds ?? [this.cwd],
    }));
  }

  async importExternalAgentConfig(migrationItems, options = {}) {
    await this.ensureInitialized();
    return this.request('externalAgentConfig/import', {
      migrationItems: Array.isArray(migrationItems) ? migrationItems : [],
      source: options.source ?? 'mobile',
    });
  }

  async writeConfigValue(options = {}) {
    await this.ensureInitialized();
    const keyPath = requireString(options.keyPath, 'config keyPath');
    const mergeStrategy = requireMergeStrategy(options.mergeStrategy);
    return this.request('config/value/write', definedParams({
      keyPath,
      value: options.value,
      mergeStrategy,
      filePath: options.filePath,
      expectedVersion: options.expectedVersion,
    }));
  }

  async writeConfigBatch(options = {}) {
    await this.ensureInitialized();
    if (!Array.isArray(options.edits) || options.edits.length === 0) throw new Error('config edits are required');
    return this.request('config/batchWrite', definedParams({
      edits: options.edits.map(edit => ({
        keyPath: requireString(edit?.keyPath, 'config edit keyPath'),
        value: edit?.value,
        mergeStrategy: requireMergeStrategy(edit?.mergeStrategy),
      })),
      filePath: options.filePath,
      expectedVersion: options.expectedVersion,
      reloadUserConfig: options.reloadUserConfig,
    }));
  }

  async installPlugin(options = {}) {
    await this.ensureInitialized();
    const params = definedParams({
      marketplacePath: options.marketplacePath === undefined || options.marketplacePath === null
        ? options.marketplacePath
        : requireAbsolutePath(options.marketplacePath, 'marketplace path'),
      remoteMarketplaceName: options.remoteMarketplaceName,
      pluginName: requireString(options.pluginName, 'pluginName'),
    });
    return this.request('plugin/install', params);
  }

  async uninstallPlugin(pluginId) {
    await this.ensureInitialized();
    return this.request('plugin/uninstall', { pluginId: requireString(pluginId, 'pluginId') });
  }

  async marketplaceAdd(options = {}) {
    await this.ensureInitialized();
    return this.request('marketplace/add', definedParams({
      source: requireString(options.source, 'marketplace source'),
      refName: options.refName,
      sparsePaths: options.sparsePaths,
    }));
  }

  async marketplaceRemove(marketplaceName) {
    await this.ensureInitialized();
    return this.request('marketplace/remove', { marketplaceName: requireString(marketplaceName, 'marketplaceName') });
  }

  async marketplaceUpgrade(marketplaceName = null) {
    await this.ensureInitialized();
    return this.request('marketplace/upgrade', definedParams({ marketplaceName }));
  }

  async writeFile(path, dataBase64) {
    await this.ensureInitialized();
    return this.request('fs/writeFile', {
      path: requireAbsolutePath(path, 'file path'),
      dataBase64: requireString(dataBase64, 'dataBase64'),
    });
  }

  async removePath(path, options = {}) {
    await this.ensureInitialized();
    return this.request('fs/remove', definedParams({
      path: requireAbsolutePath(path, 'remove path'),
      recursive: options.recursive,
      force: options.force,
    }));
  }

  async copyPath(options = {}) {
    await this.ensureInitialized();
    return this.request('fs/copy', definedParams({
      sourcePath: requireAbsolutePath(options.sourcePath, 'source path'),
      destinationPath: requireAbsolutePath(options.destinationPath, 'destination path'),
      recursive: options.recursive,
    }));
  }

  async callMcpTool(options = {}) {
    await this.ensureInitialized();
    return this.request('mcpServer/tool/call', definedParams({
      threadId: requireThreadId(options.threadId || this.sessionId, 'call MCP tool'),
      server: requireString(options.server, 'MCP server'),
      tool: requireString(options.tool, 'MCP tool'),
      arguments: options.arguments,
      _meta: options._meta,
    }));
  }

  async logoutAccount() {
    await this.ensureInitialized();
    return this.request('account/logout', undefined);
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.idleTimer); this.idleTimer = null;
    this.clearQueue('dispose', false);
    this.clearBackpressureRetries(new Error('disposed'));
    if (this.child) {
      try { this.child.kill('SIGTERM'); } catch { /* noop */ }
      this.child = null;
    }
    this.rejectAllPending(new Error('disposed'));
  }

  emit(type, payload) {
    const envelope = {
      seq: ++this.seq,
      epoch: this.epoch,
      sessionId: this.sessionId,
      instanceId: this.instanceId,
      cwd: this.cwd,
      ts: Date.now(),
      type,
      payload
    };
    this.buffer.push(envelope);
    if (this.buffer.length > BUFFER_CAP) {
      this.buffer.shift();
      this.bufferTrimmed = true;
    }
    this.onEvent(envelope);
  }

  eventsSince(lastSeq) {
    const events = this.buffer.filter(e => e.seq > lastSeq);
    const oldest = this.buffer.length ? this.buffer[0].seq : this.seq + 1;
    const gap = lastSeq > 0 && this.bufferTrimmed && oldest > lastSeq + 1;
    return { events, gap, epoch: this.epoch };
  }

  clearQueue(reason, emitEvent = true) {
    const dropped = this.inputQueue.length;
    this.inputQueue = [];
    if (emitEvent && dropped > 0 && !this.disposed) {
      this.emit('queue_cleared', { reason, dropped });
    }
    return dropped;
  }

  statusPayload(reason) {
    const state = this.pendingApprovals.size > 0
      ? 'awaiting_approval'
      : (this.busy ? 'running' : (this.inputQueue.length > 0 ? 'queued' : 'idle'));
    return {
      reason,
      state,
      sessionId: this.sessionId,
      instanceId: this.instanceId,
      cwd: this.cwd,
      busy: this.busy,
      queueLength: this.inputQueue.length,
      pendingApprovals: this.pendingApprovals.size,
      approvalPolicy: this.approvalPolicy,
      sandbox: this.sandbox,
      childRunning: Boolean(this.child),
      lastActivity: this.lastActivity,
      rpcStats: { ...this.rpcStats }
    };
  }

  emitStatus(reason) {
    if (this.disposed) return;
    this.emit('status', this.statusPayload(reason));
  }

  observeRpc(frame, details = {}) {
    this.incrementRpcStats(frame, details);
    this.appendRpcLog(buildRpcLogEntry({
      ...details,
      frame,
      instanceId: this.instanceId,
      sessionId: this.sessionId,
    }));
  }

  incrementRpcStats(frame, details) {
    if (frame === 'request' && details.direction === 'outbound') this.rpcStats.clientRequests += 1;
    if (frame === 'response' && details.direction === 'inbound') this.rpcStats.clientResponses += 1;
    if (frame === 'response' && details.direction === 'outbound') this.rpcStats.serverResponses += 1;
    if (frame === 'notification' && details.direction === 'outbound') this.rpcStats.clientNotifications += 1;
    if (frame === 'notification' && details.direction === 'inbound') this.rpcStats.serverNotifications += 1;
    if (frame === 'server_request') this.rpcStats.serverRequests += 1;
    if (details.error) this.rpcStats.errors += 1;
  }

  appendRpcLog(entry) {
    if (!this.rpcLogPath) return;
    try {
      mkdirSync(dirname(this.rpcLogPath), { recursive: true, mode: 0o700 });
      const previous = existsSync(this.rpcLogPath) ? readFileSync(this.rpcLogPath, 'utf8') : '';
      writeOwnerOnlyFile(this.rpcLogPath, previous + JSON.stringify(entry) + '\n');
    } catch {
      // Observability must not interfere with JSON-RPC protocol progress.
    }
  }
}

function truncate(s, cap) {
  if (typeof s !== 'string') return '';
  return s.length > cap ? s.slice(0, cap) + ' …（已截断）' : s;
}

function buildRpcLogEntry(details) {
  const sensitiveMethod = SENSITIVE_RPC_KEY_RE.test(details.method || '');
  const entry = {
    ts: Date.now(),
    direction: details.direction || null,
    frame: details.frame,
    id: details.id ?? null,
    method: details.method || null,
    instanceId: details.instanceId || null,
    sessionId: details.sessionId || null,
  };
  if (details.params !== undefined) entry.params = sensitiveMethod ? '<redacted>' : redactRpcValue(details.params);
  if (details.result !== undefined) entry.result = sensitiveMethod ? '<redacted>' : redactRpcValue(details.result);
  if (details.error !== undefined) entry.error = redactRpcError(details.error);
  return entry;
}

function redactRpcError(error) {
  if (!error || typeof error !== 'object') return { message: redactRpcString(String(error ?? ''), 'message') };
  const out = {};
  if (error.code !== undefined) out.code = error.code;
  if (error.message !== undefined) out.message = redactRpcString(String(error.message), 'message');
  if (error.data !== undefined) out.data = redactRpcValue(error.data, 'data');
  return out;
}

function redactRpcValue(value, key = '') {
  if (SENSITIVE_RPC_KEY_RE.test(key)) return '<redacted>';
  if (typeof value === 'string') return redactRpcString(value, key);
  if (Array.isArray(value)) {
    if (CONTENT_RPC_KEY_RE.test(key)) return `<redacted:${value.length} items>`;
    return value.slice(0, 30).map(item => redactRpcValue(item));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [childKey, child] of Object.entries(value).slice(0, 40)) {
      out[childKey] = redactRpcValue(child, childKey);
    }
    return out;
  }
  return value;
}

function redactRpcString(value, key = '') {
  if (CONTENT_RPC_KEY_RE.test(key)) return `<redacted:${value.length} chars>`;
  const pathSafe = key === 'cwd' || key === 'path' || /^([A-Za-z]:\\|\/Users\/|\/home\/|\/tmp\/|\/var\/)/.test(value)
    ? sanitizePath(value)
    : value;
  return truncate(sanitize(pathSafe), RPC_SUMMARY_CAP);
}

function definedParams(params) {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
}

function requireThreadId(threadId, action) {
  if (typeof threadId === 'string' && threadId) return threadId;
  throw new Error(`无法 ${action}：缺少 threadId`);
}

function requireAbsolutePath(path, label) {
  if (typeof path === 'string' && (/^\//.test(path) || /^[A-Za-z]:\\/.test(path))) return path;
  throw new Error(`无效 ${label}`);
}

function requireString(value, label) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(`${label} is required`);
}

function requireMergeStrategy(value) {
  if (value === 'replace' || value === 'upsert') return value;
  throw new Error('mergeStrategy must be replace or upsert');
}

function rpcError(error) {
  const err = new Error(error?.message || JSON.stringify(error));
  if (error?.code !== undefined) err.code = error.code;
  if (error?.data !== undefined) err.data = error.data;
  return err;
}

function isBackpressureError(err) {
  return err?.code === -32001 || /Server overloaded; retry later/i.test(String(err?.message || err));
}

function backpressureDelayMs(attempt, baseMs) {
  return Math.min(MAX_BACKPRESSURE_DELAY_MS, baseMs * (2 ** attempt));
}

function integerOption(value, fallback, options = {}) {
  const n = Number(value);
  if (Number.isInteger(n) && (options.allowZero ? n >= 0 : n > 0)) return n;
  return fallback;
}

function truncatePayload(value, cap, depth = 4) {
  if (typeof value === 'string') return truncate(value, cap);
  if (Array.isArray(value)) {
    if (depth <= 0) return [];
    return value.slice(0, 50).map(item => truncatePayload(item, cap, depth - 1));
  }
  if (value && typeof value === 'object') {
    if (depth <= 0) return {};
    const out = {};
    for (const [key, child] of Object.entries(value).slice(0, 50)) {
      out[key] = truncatePayload(child, cap, depth - 1);
    }
    return out;
  }
  return value;
}

function turnErrorMessage(params, fallback = '任务失败') {
  return protocolErrorMessage(params?.turn, null)
    || protocolErrorMessage(params, null)
    || fallback;
}

function protocolErrorMessage(source, fallback) {
  return source?.error?.message
    || source?.message
    || fallback;
}

function reasoningPayload(params, { text, channel, kind, indexKey }) {
  const payload = { text, channel, kind };
  for (const key of ['threadId', 'turnId', 'itemId']) {
    if (typeof params?.[key] === 'string') payload[key] = params[key];
  }
  if (params?.[indexKey] !== undefined) payload[indexKey] = params[indexKey];
  return payload;
}

function numberFromEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
