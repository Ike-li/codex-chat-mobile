// agent-appserver.js —— Codex 会话桥（app-server 模式，唯一后端）。
// 长驻 `codex app-server` 子进程，走 JSON-RPC over stdio（NDJSON）。
// 与 server.js 的 CodexAppServerSession 接口一致（send/abort/dispose/emit/eventsSince）。
//
// 进程长驻、原生流式（item/agentMessage/delta）、支持手机端审批。
import { spawn } from 'node:child_process';
import { sanitize } from './sanitizer.js';

const BUFFER_CAP = 500;
const TOOL_SUMMARY_CAP = 600;
const DEFAULT_INPUT_QUEUE_LIMIT = 20;

let instanceCounter = 0;
function nextEpoch() {
  return `${Date.now()}.${++instanceCounter}`;
}

export class CodexAppServerSession {
  constructor({ instanceId, resumeId, cwd, codexBin, idleTimeoutMs, onEvent, onSessionId, onExit }) {
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
    this.ready = null;        // initialize + thread 就绪的 promise（只做一次）
    this.stdoutBuf = '';
    this.pendingApprovals = new Set(); // 等待手机 decision 的 server→client 请求 id
    this.inputQueue = [];
    this.inputQueueLimit = numberFromEnv('CODEX_INPUT_QUEUE_LIMIT', DEFAULT_INPUT_QUEUE_LIMIT);
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
      this.ready = null;
      this.clearQueue('process_exit');
      this.rejectAllPending(new Error('app-server 进程已退出'));
      clearInterval(this.idleTimer); this.idleTimer = null;
      if (!this.disposed) this.emitStatus('process_exit');
      if (!this.disposed) this.onExit?.();
    });
    this.child.on('error', err => {
      this.busy = false;
      this.child = null;
      this.clearQueue('process_error');
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
      this.handleServerRequest(msg.id, msg.method, msg.params || {});
      return;
    }
    // 对我方请求的响应：有 id + result/error。
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      return;
    }
    // 通知。
    if (msg.method) this.handleNotification(msg.method, msg.params || {});
  }

  // server→client 请求处理。审批类透传给手机；其余安全兜底回应，避免 agent 挂起。
  handleServerRequest(rpcId, method, params) {
    if (/requestApproval/i.test(method)) {
      this.pendingApprovals.add(rpcId);
      this.emit('approval_request', {
        approvalId: rpcId,
        kind: method,
        command: params.command || null,
        cwd: params.cwd || null,
        reason: params.reason || null,
        availableDecisions: params.availableDecisions || ['accept', 'decline'],
      });
      this.emitStatus('approval_requested');
    } else {
      // 未知 server 请求：回空，避免挂起。
      this.respond(rpcId, {});
    }
  }

  respond(rpcId, result) {
    if (!this.child) return;
    this.child.stdin.write(JSON.stringify({ id: rpcId, result }) + '\n');
  }

  // 手机回传 decision（accept|acceptForSession|decline|cancel）。
  respondApproval(approvalId, decision) {
    const id = Number(approvalId);
    if (!this.pendingApprovals.has(id)) return false;
    this.pendingApprovals.delete(id);
    this.respond(id, { decision: decision || 'decline' });
    this.emitStatus('approval_resolved');
    return true;
  }

  request(method, params) {
    this.spawnIfNeeded();
    const id = ++this.rpcId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ method, id, params }) + '\n');
    });
  }

  notify(method, params) {
    this.spawnIfNeeded();
    this.child.stdin.write(JSON.stringify({ method, params }) + '\n');
  }

  // initialize + 建/续 thread，只执行一次。
  ensureReady() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      await this.request('initialize', {
        clientInfo: { name: 'codex-chat-mobile', title: 'Codex Chat Mobile', version: '0.1.0' }
      });
      this.notify('initialized', {});
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
      await this.request('turn/start', {
        threadId: this.sessionId,
        cwd: this.cwd,
        input: [{ type: 'text', text: promptText }]
      });
      this.emitStatus('turn_submitted');
    } catch (err) {
      this.busy = false;
      this.emit('error', { message: `turn/start 失败：${sanitize(String(err?.message || err))}`, recoverable: true });
      this.emitStatus('turn_start_failed');
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
      case 'item/started':
        this.handleItem(params.item, false);
        break;
      case 'item/completed':
        this.handleItem(params.item, true);
        break;
      case 'turn/completed':
        this.busy = false;
        this.pendingApprovals.clear();
        this.emit('result', { ok: params.turn?.status === 'completed', status: params.turn?.status });
        this.emitStatus('turn_completed');
        this.scheduleDrain();
        break;
      case 'turn/failed':
        this.busy = false;
        this.pendingApprovals.clear();
        this.emit('error', { message: params.turn?.error?.message || params.error?.message || '任务失败', recoverable: true });
        this.emitStatus('turn_failed');
        this.scheduleDrain();
        break;
      case 'thread/tokenUsage/updated':
        this.lastUsage = params.tokenUsage?.last ?? params.tokenUsage;
        this.emit('usage', { usage: params.tokenUsage?.last ?? params.tokenUsage });
        break;
      case 'turn/plan/updated':
        this.emit('plan', { plan: params.plan || [], explanation: params.explanation });
        break;
      case 'turn/diff/updated':
        if (params.diff) this.emit('diff', { diff: truncate(params.diff, TOOL_SUMMARY_CAP * 2) });
        break;
      case 'item/reasoning/summaryTextDelta':
        if (params.delta) this.emit('reasoning', { text: params.delta });
        break;
      // 忽略：thread/started、thread/status/changed、mcpServer/*、skills/changed、account/*、remoteControl/* 等。
    }
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
        // 未知 item type：静默忽略。
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

  abort() {
    if (this.child && this.sessionId) {
      try { this.notify('turn/interrupt', { threadId: this.sessionId }); } catch { /* noop */ }
    }
    const dropped = this.clearQueue('interrupt');
    this.busy = false;
    this.pendingApprovals.clear();
    this.emitStatus(dropped ? 'interrupt_cleared_queue' : 'interrupt');
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.idleTimer); this.idleTimer = null;
    this.clearQueue('dispose', false);
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
      lastActivity: this.lastActivity
    };
  }

  emitStatus(reason) {
    if (this.disposed) return;
    this.emit('status', this.statusPayload(reason));
  }
}

function truncate(s, cap) {
  if (typeof s !== 'string') return '';
  return s.length > cap ? s.slice(0, cap) + ' …（已截断）' : s;
}

function numberFromEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
