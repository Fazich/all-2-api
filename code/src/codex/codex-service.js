/**
 * Codex API 服务类
 */
import axios from 'axios';
import crypto from 'crypto';
import { logger } from '../logger.js';
import { getAxiosProxyConfig } from '../proxy.js';
import { refreshCodexToken } from './codex-auth.js';
import { CodexCredentialStore } from '../db.js';

const log = logger.client;

// Codex API 端点
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

// Codex 支持的模型
export const CODEX_MODELS = [
    'gpt-5', 'gpt-5-codex', 'gpt-5-codex-mini',
    'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5.1-codex-max',
    'gpt-5.2', 'gpt-5.2-codex', 'gpt-5.3-codex'
];

/**
 * Codex API 服务类
 */
export class CodexService {
    constructor(credential) {
        this.credential = credential;
        this.baseUrl = CODEX_BASE_URL;
        this.conversationCache = new Map();

        // 配置 axios
        const axiosConfig = { timeout: 120000 };
        const proxyConfig = getAxiosProxyConfig();
        if (proxyConfig) {
            axiosConfig.httpAgent = proxyConfig.httpAgent;
            axiosConfig.httpsAgent = proxyConfig.httpsAgent;
        }
        this.httpClient = axios.create(axiosConfig);
    }

    /**
     * 从数据库创建服务实例
     */
    static async fromDatabase(credentialId) {
        const store = await CodexCredentialStore.create();
        const credential = await store.getById(credentialId);
        if (!credential) {
            throw new Error(`Codex 凭证 ID ${credentialId} 不存在`);
        }
        return new CodexService(credential);
    }

    /**
     * 获取随机可用凭证创建服务实例
     */
    static async fromRandomActive() {
        const store = await CodexCredentialStore.create();
        const credential = await store.getRandomActive();
        if (!credential) {
            throw new Error('没有可用的 Codex 凭证');
        }
        return new CodexService(credential);
    }

    /**
     * 构建请求头
     */
    buildHeaders(cacheId) {
        return {
            'version': '0.98.0',
            'x-codex-beta-features': 'powershell_utf8',
            'x-oai-web-search-eligible': 'true',
            'session_id': cacheId,
            'accept': 'text/event-stream',
            'authorization': `Bearer ${this.credential.accessToken}`,
            'chatgpt-account-id': this.credential.accountId,
            'content-type': 'application/json',
            'user-agent': 'codex_cli_rs/0.89.0 (Windows 10.0.26100; x86_64) WindowsTerminal',
            'originator': 'codex_cli_rs',
            'host': 'chatgpt.com',
            'Connection': 'close'
        };
    }

    /**
     * 获取或创建会话缓存 ID
     */
    getCacheId(model, userId = 'default') {
        const cacheKey = `${model}-${userId}`;
        let cache = this.conversationCache.get(cacheKey);

        if (!cache || cache.expire < Date.now()) {
            cache = {
                id: crypto.randomUUID(),
                expire: Date.now() + 3600000 // 1 小时
            };
            this.conversationCache.set(cacheKey, cache);
        }
        return cache.id;
    }

    /**
     * 检查 Token 是否即将过期
     */
    isTokenExpiringSoon(minutesThreshold = 20) {
        if (!this.credential.expiresAt) return true;
        const expiresAt = new Date(this.credential.expiresAt).getTime();
        const threshold = minutesThreshold * 60 * 1000;
        return (expiresAt - Date.now()) < threshold;
    }

    /**
     * 刷新 Token
     */
    async refreshToken() {
        try {
            const newTokens = await refreshCodexToken(this.credential.refreshToken);

            // 更新数据库
            const store = await CodexCredentialStore.create();
            await store.updateTokens(this.credential.id, newTokens);

            // 更新本地凭证
            this.credential.accessToken = newTokens.accessToken;
            this.credential.refreshToken = newTokens.refreshToken;
            this.credential.idToken = newTokens.idToken;
            this.credential.expiresAt = newTokens.expiresAt;

            log.info(`[Codex] Token 刷新成功: ${this.credential.email}`);
            return true;
        } catch (error) {
            log.error(`[Codex] Token 刷新失败:`, error.message);

            // 记录错误
            const store = await CodexCredentialStore.create();
            await store.incrementErrorCount(this.credential.id, error.message);

            throw error;
        }
    }

    /**
     * 发送聊天请求（流式）
     */
    async *chatStream(model, messages, options = {}) {
        // 检查 Token 是否需要刷新，或缺少 accountId
        if (this.isTokenExpiringSoon() || !this.credential.accountId) {
            log.info(`[Codex] Token 即将过期或缺少 accountId，正在刷新...`);
            await this.refreshToken();
        }

        const cacheId = this.getCacheId(model, options.userId);
        const headers = this.buildHeaders(cacheId);
        const url = `${this.baseUrl}/responses`;

        // 构建 Codex 格式的请求体
        const input = this.formatMessages(messages);

        // 在 input 开头注入特殊指令
        if (input.length > 0 && options.system) {
            input.unshift({
                type: 'message',
                role: 'user',
                content: [{
                    type: 'input_text',
                    text: 'EXECUTE ACCORDING TO THE FOLLOWING INSTRUCTIONS!!!'
                }]
            });
        }

        const body = {
            model: model,
            instructions: options.system || '',
            input: input,
            stream: true,
            store: false,
            reasoning: {
                effort: 'medium',
                summary: 'auto'
            },
            parallel_tool_calls: true,
            include: ['reasoning.encrypted_content'],
            prompt_cache_key: cacheId
        };

        try {
            // 检查凭证完整性
            if (!this.credential.accessToken) {
                throw new Error('缺少 accessToken，请先刷新凭证');
            }
            if (!this.credential.accountId) {
                throw new Error('缺少 accountId，请检查凭证配置');
            }

            log.info(`[Codex] 发送请求到 ${url}, model: ${model}, accountId: ${this.credential.accountId?.substring(0, 8)}...`);
            log.debug(`[Codex] 请求体:`, JSON.stringify(body));

            const response = await this.httpClient.post(url, body, {
                headers,
                responseType: 'stream'
            });

            // 增加使用计数
            const store = await CodexCredentialStore.create();
            await store.incrementUseCount(this.credential.id);

            yield* this.parseSSEStream(response.data);
        } catch (error) {
            log.error(`[Codex] 请求失败:`, error.message);
            if (error.response) {
                log.error(`[Codex] 状态码: ${error.response.status}`);
                // 安全地获取响应数据
                try {
                    const responseData = error.response.data;
                    if (typeof responseData === 'string') {
                        log.error(`[Codex] 响应数据: ${responseData}`);
                    } else if (responseData && typeof responseData === 'object') {
                        // 如果是流，尝试读取
                        if (typeof responseData.on === 'function') {
                            let errorBody = '';
                            responseData.on('data', chunk => errorBody += chunk.toString());
                            responseData.on('end', () => log.error(`[Codex] 响应数据: ${errorBody}`));
                        } else {
                            log.error(`[Codex] 响应数据: ${JSON.stringify(responseData)}`);
                        }
                    }
                } catch (logError) {
                    log.error(`[Codex] 无法解析响应数据`);
                }
            }
            await this.handleError(error);
            throw error;
        }
    }

    /**
     * 发送聊天请求（非流式）
     */
    async chat(model, messages, options = {}) {
        const chunks = [];
        for await (const chunk of this.chatStream(model, messages, options)) {
            if (chunk.type === 'content') {
                chunks.push(chunk.data);
            }
        }
        return chunks.join('');
    }

    /**
     * 格式化消息为 Codex 格式
     */
    formatMessages(messages) {
        const input = [];

        for (const msg of messages) {
            const role = msg.role;
            const content = msg.content;

            if (role === 'user' || role === 'assistant') {
                const isAssistant = role === 'assistant';
                let textContent = '';

                if (typeof content === 'string') {
                    textContent = content;
                } else if (Array.isArray(content)) {
                    textContent = content.map(c => c.type === 'text' ? c.text : (c.text || '')).join('');
                }

                if (textContent) {
                    input.push({
                        type: 'message',
                        role: role,
                        content: [{
                            type: isAssistant ? 'output_text' : 'input_text',
                            text: textContent
                        }]
                    });
                }
            }
        }

        return input;
    }

    /**
     * 解析 SSE 流
     */
    async *parseSSEStream(stream) {
        let buffer = '';

        for await (const chunk of stream) {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();
                    if (data && data !== '[DONE]') {
                        try {
                            const parsed = JSON.parse(data);
                            yield this.transformEvent(parsed);
                        } catch (e) {
                            // 忽略解析错误
                        }
                    }
                }
            }
        }

        // 处理剩余 buffer
        if (buffer.startsWith('data: ')) {
            const data = buffer.slice(6).trim();
            if (data && data !== '[DONE]') {
                try {
                    const parsed = JSON.parse(data);
                    yield this.transformEvent(parsed);
                } catch (e) {
                    // 忽略
                }
            }
        }
    }

    /**
     * 转换事件格式
     */
    transformEvent(event) {
        if (event.type === 'response.output_text.delta') {
            return { type: 'content', data: event.delta || '' };
        } else if (event.type === 'response.completed') {
            return { type: 'done', data: event };
        }
        return { type: event.type, data: event };
    }

    /**
     * 处理错误
     */
    async handleError(error) {
        if (error.response?.status === 401) {
            log.warn(`[Codex] 401 错误，标记凭证需要刷新`);
            const store = await CodexCredentialStore.create();
            await store.incrementErrorCount(this.credential.id, '401 Unauthorized');
        }
    }

    /**
     * 获取使用限制
     */
    async getUsageLimits() {
        // 检查 Token 是否需要刷新
        if (this.isTokenExpiringSoon()) {
            log.info(`[Codex] Token 即将过期，正在刷新...`);
            await this.refreshToken();
        }

        const headers = {
            'user-agent': 'codex_cli_rs/0.89.0 (Windows 10.0.26100; x86_64)',
            'authorization': `Bearer ${this.credential.accessToken}`,
            'chatgpt-account-id': this.credential.accountId,
            'accept': '*/*',
            'host': 'chatgpt.com'
        };

        try {
            const response = await this.httpClient.get(CODEX_USAGE_URL, { headers });
            return response.data;
        } catch (error) {
            log.error(`[Codex] 获取使用限制失败:`, error.message);
            // 如果是 401 错误，尝试刷新 Token 后重试一次
            if (error.response?.status === 401) {
                log.info(`[Codex] 401 错误，尝试刷新 Token 后重试...`);
                try {
                    await this.refreshToken();
                    // 更新 headers 中的 token
                    headers.authorization = `Bearer ${this.credential.accessToken}`;
                    const retryResponse = await this.httpClient.get(CODEX_USAGE_URL, { headers });
                    return retryResponse.data;
                } catch (retryError) {
                    log.error(`[Codex] 刷新 Token 后重试仍失败:`, retryError.message);
                    throw retryError;
                }
            }
            throw error;
        }
    }

    /**
     * 列出可用模型
     */
    listModels() {
        return CODEX_MODELS.map(id => ({
            id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'openai'
        }));
    }

    /**
     * 测试凭证是否有效
     */
    async testCredential() {
        try {
            await this.getUsageLimits();
            return { success: true, message: '凭证有效' };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }
}

export default CodexService;