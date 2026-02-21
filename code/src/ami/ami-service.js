/**
 * AMI API Service - 代理 AMI 的对话功能
 *
 * 基于 AMI 真实 API 格式（Vercel AI SDK agent/v2 端点）
 * - 请求体使用 gzip 压缩
 * - 包含完整的 context / parts / agentUrl / mode 字段
 * - 支持 429 限流自动重试
 *
 * AMI SSE 事件格式：
 * - reasoning-delta: 推理过程（思考链）
 * - text-delta: 实际回复文本
 * - tool-input-available / tool-output-available: 工具调用
 */
import axios from 'axios';
import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import WebSocket from 'ws';
import { getAxiosProxyConfig } from '../proxy.js';
import { logger } from '../logger.js';

const log = logger.server;

// AMI API 配置
const AMI_CONFIG = {
    BASE_URL: 'https://app.ami.dev',
    AGENT_ENDPOINT: '/api/v1/agent/v2',
    TIMEOUT: 300000,
    MAX_RETRIES: 3,
};

// AMI 支持的模型映射（外部名 -> AMI 内部名）
export const AMI_MODELS = {
    'claude-sonnet-4':            'anthropic/claude-sonnet-4',
    'claude-sonnet-4-20250514':   'anthropic/claude-sonnet-4',
    'claude-opus-4':              'anthropic/claude-opus-4',
    'claude-opus-4-20250918':     'anthropic/claude-opus-4',
    'claude-opus-4.5':            'anthropic/claude-opus-4.5',
    'claude-opus-4-5-20251101':   'anthropic/claude-opus-4.5',
    'ami-claude-opus-4.5':        'anthropic/claude-opus-4.5',
    'claude-3-5-sonnet':          'anthropic/claude-3-5-sonnet-20241022',
    'claude-3-5-sonnet-20241022': 'anthropic/claude-3-5-sonnet-20241022',
};

// 默认模型
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4';

/**
 * 生成随机 ID（与 AMI 格式一致）
 */
function randomId(len = 21) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < len; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}

/**
 * 获取今日日期字符串
 */
function today() {
    return new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * gzip 压缩 Buffer
 */
function gzipAsync(buf) {
    return new Promise((resolve, reject) =>
        zlib.gzip(buf, (err, result) => err ? reject(err) : resolve(result)));
}

/**
 * 从错误响应中提取错误信息
 */
async function extractErrorBody(responseData) {
    if (!responseData) return '';
    try {
        if (responseData.readable || typeof responseData.on === 'function') {
            const chunks = [];
            for await (const chunk of responseData) chunks.push(chunk);
            return Buffer.concat(chunks).toString('utf8');
        }
        if (typeof responseData === 'string') return responseData;
        if (Buffer.isBuffer(responseData)) return responseData.toString('utf8');
        if (responseData.message) return responseData.message;
        if (responseData.error) return typeof responseData.error === 'string' ? responseData.error : JSON.stringify(responseData);
        return JSON.stringify(responseData);
    } catch {
        return '';
    }
}

// ── AmiDaemon — WebSocket daemon（工具执行）──────────────────────

class AmiDaemon {
    constructor(userId, bridgeToken) {
        this.userId = userId;
        this.bridgeToken = bridgeToken;
        this.projects = {};
        this.ws = null;
        this.connected = false;
        this.authenticated = false;
    }

    addProject(projectId, localPath = '/tmp') {
        this.projects[projectId] = localPath;
    }

    start(timeout = 10000) {
        return new Promise((resolve) => {
            const url = `wss://bridge.ami.dev/api/v1/user-streams?userId=${this.userId}`;
            this.ws = new WebSocket(url, { rejectUnauthorized: false });
            const timer = setTimeout(() => resolve(false), timeout);

            this.ws.on('open', () => { this.connected = true; });
            this.ws.on('message', (raw) => {
                let data;
                try { data = JSON.parse(raw); } catch { return; }
                const tag = data._tag || '';
                if (tag === 'auth_required') {
                    this.ws.send(JSON.stringify({ _tag: 'auth', token: this.bridgeToken, type: 'cli' }));
                } else if (tag === 'auth_success') {
                    this.authenticated = true;
                    this.ws.send(JSON.stringify({ _tag: 'presence_request' }));
                    clearTimeout(timer);
                    resolve(true);
                } else if (tag === 'rpc_call') {
                    this._handleRpc(data);
                }
            });
            this.ws.on('error', (err) => {
                log.warn(`[AmiDaemon] WebSocket error: ${err.message}`);
            });
            this.ws.on('close', () => {
                this.connected = false;
                this.authenticated = false;
            });
        });
    }

    _handleRpc(data) {
        const rid = data.requestId;
        const method = data.method || '';
        const input = data.input || {};
        let result;

        if (method === 'daemon:get_project') {
            const p = this.projects[input.projectId];
            result = p
                ? { exists: true, path: p, isGitRepo: fs.existsSync(path.join(p, '.git')) }
                : { exists: true, path: '/tmp', isGitRepo: false };
        } else if (method === 'daemon:cancel_all_bash') {
            result = { cancelledCount: 0 };
        } else if (method === 'daemon:tool_run' || method === 'daemon:execute_tool') {
            const toolName = input.toolName || '';
            let args = input.toolInput || input.args || {};
            if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
            result = { result: this._executeTool(toolName, args, input.cwd || '/tmp') };
        } else {
            result = { ok: true };
        }

        if (this.ws && this.connected) {
            this.ws.send(JSON.stringify({ _tag: 'rpc_result', requestId: rid, data: result }));
        }
    }

    _executeTool(toolName, args, cwd) {
        try {
            if (toolName.includes('Bash')) {
                const out = execSync(args.command || 'echo ok', {
                    cwd, timeout: 60000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
                });
                return { type: 'success', result: { stdout: out.slice(-5000), stderr: '', interrupted: false, isImage: false } };
            }
            if (toolName.includes('Read')) {
                const lines = fs.readFileSync(args.file_path || '', 'utf8').split('\n');
                const start = Math.max(0, (args.offset || 1) - 1);
                const sel = lines.slice(start, start + (args.limit || 999999));
                return { type: 'success', result: { type: 'text', file: {
                    filePath: args.file_path, content: sel.join('\n'),
                    numLines: sel.length, startLine: start + 1, totalLines: lines.length,
                }}};
            }
            if (toolName.includes('Write')) {
                fs.mkdirSync(path.dirname(args.file_path || '.'), { recursive: true });
                fs.writeFileSync(args.file_path || '', args.content || '', 'utf8');
                return { type: 'success', result: { success: true, message: `Wrote ${args.file_path}`, diff: '' } };
            }
            if (toolName.includes('Glob')) {
                const t0 = Date.now();
                const out = execSync(
                    `find ${args.path || cwd} -name "${args.pattern || '*'}" -type f 2>/dev/null | head -1000`,
                    { encoding: 'utf8', timeout: 30000 },
                ).trim();
                const files = out ? out.split('\n') : [];
                return { type: 'success', result: { durationMs: Date.now() - t0, filenames: files, numFiles: files.length, truncated: files.length >= 1000 } };
            }
            if (toolName.includes('Grep')) {
                const out = execSync(
                    `grep -rn --color=never ${JSON.stringify(args.pattern || '')} ${args.path || cwd} 2>/dev/null | head -200`,
                    { encoding: 'utf8', timeout: 30000 },
                );
                return { type: 'success', result: { stdout: out.slice(-5000), stderr: '', exitCode: 0 } };
            }
            return { type: 'error', error: { type: 'unknown', message: `Unsupported tool: ${toolName}` } };
        } catch (e) {
            return { type: 'error', error: { type: 'execution', message: e.message } };
        }
    }

    stop() {
        if (this.ws) { try { this.ws.close(); } catch {} }
        this.ws = null;
        this.connected = false;
        this.authenticated = false;
    }

    get isAlive() {
        return this.ws && this.connected && this.authenticated;
    }
}

// ── 全局 daemon 池（按凭据 ID 复用）──────────────────────────────

const daemonPool = new Map();

/**
 * AMI Service - 处理与 AMI API 的通信
 */
export class AmiService {
    constructor(credential) {
        this.credential = credential;
        this.sessionCookie = credential.sessionCookie;
        this.projectId = credential.projectId;
        this.chatId = credential.chatId;

        const agentOpts = { keepAlive: true, maxSockets: 50, timeout: AMI_CONFIG.TIMEOUT };
        const httpAgent = new http.Agent(agentOpts);
        const httpsAgent = new https.Agent(agentOpts);

        const axiosConfig = {
            timeout: AMI_CONFIG.TIMEOUT,
            httpAgent,
            httpsAgent,
            headers: {
                'Accept': '*/*',
                'Origin': AMI_CONFIG.BASE_URL,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
            },
        };

        // 配置代理
        const proxyConfig = getAxiosProxyConfig();
        if (proxyConfig.proxy === false) {
            axiosConfig.proxy = false;
        }
        if (proxyConfig.httpsAgent) {
            axiosConfig.httpsAgent = proxyConfig.httpsAgent;
        }
        if (proxyConfig.httpAgent) {
            axiosConfig.httpAgent = proxyConfig.httpAgent;
        }

        this.axiosInstance = axios.create(axiosConfig);
        this.baseUrl = AMI_CONFIG.BASE_URL;
    }

    /**
     * tRPC 通用请求头（含 session cookie）
     */
    get _tRPCHeaders() {
        return {
            'Cookie': `wos-session=${this.sessionCookie}`,
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'Origin': this.baseUrl,
        };
    }

    /**
     * tRPC GET 请求
     */
    async _tRPCGet(path, params = {}) {
        const qs = Object.keys(params).length
            ? '?' + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
            : '';
        const res = await this.axiosInstance.get(`${this.baseUrl}${path}${qs}`, {
            headers: this._tRPCHeaders,
        });
        return res.data;
    }

    /**
     * tRPC POST 请求
     */
    async _tRPCPost(path, body) {
        const res = await this.axiosInstance.post(`${this.baseUrl}${path}`, body, {
            headers: this._tRPCHeaders,
        });
        return res.data;
    }

    /**
     * 创建 AMI 项目（自动创建 project + chat）
     * @param {string} title - 项目名称
     * @param {string} cwd - 工作目录
     * @returns {{ projectId: string, chatId: string }}
     */
    async createProject(title = 'API Proxy', cwd = '/tmp') {
        const data = await this._tRPCPost('/api/v1/trpc/projects.create', { cwd, title });
        const result = data?.result?.data ?? {};
        if (!result.projectId) {
            throw new Error('创建项目失败：未返回 projectId');
        }
        this.projectId = result.projectId;
        this.chatId = result.chatId;
        log.info(`[AmiService] 创建项目成功: projectId=${result.projectId}, chatId=${result.chatId}`);
        return result;
    }

    /**
     * 确保凭据有 projectId 和 chatId，没有则自动创建
     * @returns {{ projectId: string, chatId: string }}
     */
    async ensureProjectAndChat() {
        if (this.projectId && this.chatId) {
            return { projectId: this.projectId, chatId: this.chatId };
        }
        log.info(`[AmiService] 凭据缺少 projectId/chatId，自动创建项目...`);
        return await this.createProject();
    }

    /**
     * 确保 daemon 已连接（按凭据 ID 复用）
     * 流程：getSession → 启动 WebSocket daemon → 注册 project
     */
    async ensureDaemon() {
        const credId = this.credential.id;

        // 检查池中是否已有存活的 daemon
        const existing = daemonPool.get(credId);
        if (existing && existing.isAlive) {
            // 确保当前 project 已注册
            if (this.projectId) existing.addProject(this.projectId, '/tmp');
            return existing;
        }

        // 获取 session 信息（userId + bridgeToken）
        log.info(`[AmiService] 获取 session 用于启动 daemon (credential=${credId})`);
        const sessionData = await this._tRPCGet('/api/v1/trpc/user.session.get');
        const session = sessionData?.result?.data ?? {};
        const userId = session?.user?.id;
        const bridgeToken = session?.bridge_token;

        if (!userId || !bridgeToken) {
            log.warn(`[AmiService] 无法获取 userId/bridgeToken，daemon 启动失败`);
            return null;
        }

        // 创建并启动 daemon
        const daemon = new AmiDaemon(userId, bridgeToken);
        if (this.projectId) daemon.addProject(this.projectId, '/tmp');

        log.info(`[AmiService] 启动 daemon WebSocket (userId=${userId})`);
        const ok = await daemon.start();

        if (ok) {
            // 等待 1s 让 presence 生效
            await new Promise(r => setTimeout(r, 1000));
            daemonPool.set(credId, daemon);
            log.info(`[AmiService] daemon 启动成功 (credential=${credId})`);
            return daemon;
        } else {
            log.warn(`[AmiService] daemon 启动超时 (credential=${credId})`);
            daemon.stop();
            return null;
        }
    }

    /**
     * 构建符合 AMI agent/v2 格式的请求体
     * 参考 ami_chat.js 的真实格式
     */
    buildRequest(messages, model, options = {}) {
        const amiModel = AMI_MODELS[model] || model || DEFAULT_MODEL;
        const cwd = '/tmp';

        // AMI 不支持 assistant prefill，移除末尾的 assistant 消息
        let filteredMessages = [...messages];
        while (filteredMessages.length > 0 && filteredMessages[filteredMessages.length - 1].role === 'assistant') {
            filteredMessages.pop();
        }

        return {
            messages: filteredMessages.map(msg => ({
                id: msg.id || randomId(21),
                role: msg.role,
                parts: [{ type: 'text', text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }],
            })),
            agentUrl: AMI_CONFIG.BASE_URL,
            context: {
                environment: {
                    cwd,
                    rules: { agents: null, claude: null, gemini: null, cursor: null },
                    homeDir: os.homedir(),
                    workingDirectory: cwd,
                    isGitRepo: false,
                    platform: 'darwin',
                    osVersion: `Darwin Kernel Version 24.6.0`,
                    today: today(),
                    isCodeServerAvailable: true,
                    isCodebaseSearchEnabled: false,
                    isBrowserToolsEnabled: true,
                },
                systemContext: [
                    { type: 'Diagnostics', diagnostics: {} },
                    { type: 'OpenBrowserTabsChanged', tabs: [] },
                ],
                attachments: [],
            },
            cwd,
            id: this.chatId,
            model: amiModel,
            projectId: this.projectId,
            mode: 'agent',
        };
    }

    /**
     * 将 AMI SSE 事件转换为 Claude 格式
     */
    convertAmiEventToClaude(amiEvent) {
        const { type, delta, id, messageId, messageMetadata, finishReason } = amiEvent;

        switch (type) {
            case 'start':
                return {
                    type: 'message_start',
                    message: {
                        id: messageId || `msg_${Date.now()}`,
                        type: 'message',
                        role: 'assistant',
                        content: [],
                        model: messageMetadata?.model || 'ami-model',
                        stop_reason: null,
                        stop_sequence: null,
                        usage: { input_tokens: 0, output_tokens: 0 },
                    },
                };

            case 'reasoning-start':
                return {
                    type: 'content_block_start',
                    index: parseInt(id) || 0,
                    content_block: { type: 'thinking', thinking: '' },
                };

            case 'reasoning-delta':
                if (!delta) return null;
                return {
                    type: 'content_block_delta',
                    index: parseInt(id) || 0,
                    delta: { type: 'thinking_delta', thinking: delta },
                };

            case 'reasoning-end':
                return { type: 'content_block_stop', index: parseInt(id) || 0 };

            case 'text-start':
                return {
                    type: 'content_block_start',
                    index: parseInt(id) || 1,
                    content_block: { type: 'text', text: '' },
                };

            case 'text-delta':
                if (!delta) return null;
                return {
                    type: 'content_block_delta',
                    index: parseInt(id) || 1,
                    delta: { type: 'text_delta', text: delta },
                };

            case 'text-end':
                return { type: 'content_block_stop', index: parseInt(id) || 1 };

            case 'finish':
                return {
                    type: 'message_delta',
                    delta: {
                        stop_reason: finishReason === 'stop' ? 'end_turn' : finishReason,
                        stop_sequence: null,
                    },
                    usage: { output_tokens: 0 },
                };

            case 'error': {
                const errText = amiEvent.errorText || 'unknown error';
                log.error(`[AmiService] 流内错误: ${errText}`);
                // 将错误信息作为文本传递给客户端
                return {
                    type: 'content_block_delta',
                    index: 1,
                    delta: { type: 'text_delta', text: `\n[AMI Error: ${errText}]\n` },
                };
            }

            // 可安全忽略的事件
            case 'data-context-window':
            case 'finish-step':
            case 'start-step':
            case 'data-otel':
            case 'data-lifecycle':
            case 'data-initial':
            case 'data-heartbeat':
            case 'tool-input-start':
            case 'tool-input-delta':
            case 'tool-input-available':
            case 'tool-output-available':
            case 'tool-output-error':
                return null;

            default:
                log.debug(`[AmiService] 未知事件类型: ${type}`);
                return null;
        }
    }

    /**
     * 解析 SSE 流，yield 原始 AMI 事件
     */
    async *parseSSEStream(responseData) {
        let buffer = '';
        for await (const chunk of responseData) {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const raw = line.slice(6).trim();
                if (raw === '[DONE]') return;
                try {
                    yield JSON.parse(raw);
                } catch {
                    log.warn(`[AmiService] 解析 SSE 事件失败: ${line}`);
                }
            }
        }
        // 处理剩余 buffer
        if (buffer.startsWith('data: ')) {
            const raw = buffer.slice(6).trim();
            if (raw && raw !== '[DONE]') {
                try { yield JSON.parse(raw); } catch { /* ignore */ }
            }
        }
    }

    /**
     * 发送请求到 AMI（含 gzip 压缩和 429 重试）
     */
    async sendRequest(amiRequest) {
        const bodyBuf = Buffer.from(JSON.stringify(amiRequest), 'utf8');
        const bodyGzip = await gzipAsync(bodyBuf);

        const headers = {
            'Host': 'app.ami.dev',
            'Cookie': `wos-session=${this.sessionCookie}`,
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'Origin': this.baseUrl,
            'Referer': `${this.baseUrl}/chat/${this.projectId}?chat=${this.chatId}`,
            'Content-Encoding': 'gzip',
            'Content-Length': String(bodyGzip.length),
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Dest': 'empty',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Ami/0.0.15 Chrome/142.0.7444.235 Electron/39.2.7 Safari/537.36',
        };

        const url = `${this.baseUrl}${AMI_CONFIG.AGENT_ENDPOINT}`;

        for (let attempt = 0; attempt < AMI_CONFIG.MAX_RETRIES; attempt++) {
            try {
                const response = await this.axiosInstance.post(url, bodyGzip, {
                    headers,
                    responseType: 'stream',
                    // axios 不应再次压缩已 gzip 的数据
                    transformRequest: [(data) => data],
                });

                if (response.status === 200) return response;
            } catch (error) {
                const status = error.response?.status;

                if (status === 429) {
                    const wait = Math.min(10000 * (attempt + 1), 30000);
                    log.warn(`[AmiService] 限流 429，等待 ${wait / 1000}s 后重试 (${attempt + 1}/${AMI_CONFIG.MAX_RETRIES})`);
                    await new Promise(r => setTimeout(r, wait));
                    continue;
                }

                // 非 429 错误，提取详细信息后抛出
                const body = await extractErrorBody(error.response?.data);
                let msg = error.message;
                if (body) {
                    try { msg = JSON.parse(body).message || JSON.parse(body).error || body.substring(0, 500); } catch { msg = body.substring(0, 500); }
                }

                log.error(`[AmiService] 请求失败: status=${status}, msg=${msg}`);

                if (status === 401) throw new Error('认证失败，请检查 sessionCookie 是否有效');
                if (status === 403) throw new Error('访问被拒绝，请检查 projectId 和 chatId 是否正确');
                if (status === 404) throw new Error('项目或聊天不存在，请检查 projectId 和 chatId');
                if (status === 500) throw new Error(`AMI 服务器内部错误: ${msg}`);
                throw new Error(`AMI API 错误 (${status || 'unknown'}): ${msg}`);
            }
        }

        throw new Error('请求失败: 重试后仍被限流');
    }

    /**
     * 流式生成内容
     * @param {string} model - 模型名称
     * @param {object} requestBody - Claude 格式的请求体
     * @yields {object} Claude 格式的 SSE 事件
     */
    async *generateContentStream(model, requestBody) {
        const { messages, system, max_tokens, temperature } = requestBody;

        // 确保 daemon 已连接（工具执行需要）
        await this.ensureDaemon();

        // 如果有 system prompt，将其添加到消息开头
        const allMessages = system
            ? [{ role: 'system', content: system }, ...messages]
            : messages;

        const amiRequest = this.buildRequest(allMessages, model, { max_tokens, temperature });

        log.info(`[AmiService] 发送请求: model=${model}, projectId=${this.projectId}, chatId=${this.chatId}`);

        const response = await this.sendRequest(amiRequest);

        for await (const amiEvent of this.parseSSEStream(response.data)) {
            const claudeEvent = this.convertAmiEventToClaude(amiEvent);
            if (claudeEvent) yield claudeEvent;
        }

        yield { type: 'message_stop' };
    }

    /**
     * 非流式生成内容
     */
    async generateContent(model, requestBody) {
        let thinkingContent = '';
        let textContent = '';

        for await (const event of this.generateContentStream(model, requestBody)) {
            if (event.type === 'content_block_delta') {
                if (event.delta?.type === 'thinking_delta') {
                    thinkingContent += event.delta.thinking || '';
                } else if (event.delta?.type === 'text_delta') {
                    textContent += event.delta.text || '';
                }
            }
        }

        const content = [];
        if (thinkingContent) content.push({ type: 'thinking', thinking: thinkingContent });
        if (textContent) content.push({ type: 'text', text: textContent });

        return {
            id: `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            content,
            model: AMI_MODELS[model] || model,
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
        };
    }
}

export default AmiService;
