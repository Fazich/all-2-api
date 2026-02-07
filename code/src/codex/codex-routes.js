/**
 * Codex 路由模块
 */
import { CodexCredentialStore } from '../db.js';
import { CodexService, CODEX_MODELS } from './codex-service.js';
import { startCodexOAuth, completeCodexOAuth, refreshCodexToken } from './codex-auth.js';

/**
 * 设置 Codex 路由
 */
export function setupCodexRoutes(app, authMiddleware) {
    // ============ Codex 凭证管理 API ============

    // 获取所有凭证
    app.get('/api/codex/credentials', authMiddleware, async (req, res) => {
        try {
            const store = await CodexCredentialStore.create();
            const credentials = await store.getAll();
            // 隐藏敏感信息
            const safeCredentials = credentials.map(c => ({
                ...c,
                accessToken: c.accessToken ? '***' : null,
                refreshToken: c.refreshToken ? '***' : null,
                idToken: c.idToken ? '***' : null
            }));
            res.json({ success: true, data: safeCredentials });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取单个凭证
    app.get('/api/codex/credentials/:id', authMiddleware, async (req, res) => {
        try {
            const store = await CodexCredentialStore.create();
            const credential = await store.getById(parseInt(req.params.id));
            if (!credential) {
                return res.status(404).json({ success: false, error: '凭证不存在' });
            }
            // 隐藏敏感信息
            res.json({
                success: true,
                data: {
                    ...credential,
                    accessToken: credential.accessToken ? '***' : null,
                    refreshToken: credential.refreshToken ? '***' : null,
                    idToken: credential.idToken ? '***' : null
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 创建凭证（手动添加）
    app.post('/api/codex/credentials', authMiddleware, async (req, res) => {
        try {
            const { name, refreshToken, email, accountId, note } = req.body;
            if (!name || !refreshToken) {
                return res.status(400).json({ success: false, error: '名称和 refreshToken 是必填项' });
            }

            const store = await CodexCredentialStore.create();

            // 检查名称是否已存在
            const existing = await store.getByName(name);
            if (existing) {
                return res.status(400).json({ success: false, error: '凭证名称已存在' });
            }

            const id = await store.create({
                name,
                refreshToken,
                email: email || null,
                accountId: accountId || null,
                note: note || null
            });

            res.json({ success: true, data: { id }, message: '凭证创建成功' });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 更新凭证
    app.put('/api/codex/credentials/:id', authMiddleware, async (req, res) => {
        try {
            const store = await CodexCredentialStore.create();
            const credential = await store.getById(parseInt(req.params.id));
            if (!credential) {
                return res.status(404).json({ success: false, error: '凭证不存在' });
            }

            await store.update(parseInt(req.params.id), req.body);
            res.json({ success: true, message: '凭证更新成功' });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 删除凭证
    app.delete('/api/codex/credentials/:id', authMiddleware, async (req, res) => {
        try {
            const store = await CodexCredentialStore.create();
            await store.delete(parseInt(req.params.id));
            res.json({ success: true, message: '凭证删除成功' });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 刷新凭证 Token
    app.post('/api/codex/credentials/:id/refresh', authMiddleware, async (req, res) => {
        try {
            const store = await CodexCredentialStore.create();
            const credential = await store.getById(parseInt(req.params.id));
            if (!credential) {
                return res.status(404).json({ success: false, error: '凭证不存在' });
            }

            const newTokens = await refreshCodexToken(credential.refreshToken);
            await store.updateTokens(credential.id, newTokens);

            res.json({ success: true, message: 'Token 刷新成功', data: { email: newTokens.email, expiresAt: newTokens.expiresAt } });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 测试凭证
    app.post('/api/codex/credentials/:id/test', authMiddleware, async (req, res) => {
        try {
            const service = await CodexService.fromDatabase(parseInt(req.params.id));
            const result = await service.testCredential();
            res.json({ success: result.success, message: result.message });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取凭证使用限制
    app.get('/api/codex/credentials/:id/usage', authMiddleware, async (req, res) => {
        try {
            const service = await CodexService.fromDatabase(parseInt(req.params.id));
            const usage = await service.getUsageLimits();
            res.json({ success: true, data: usage });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取统计信息
    app.get('/api/codex/statistics', authMiddleware, async (req, res) => {
        try {
            const store = await CodexCredentialStore.create();
            const stats = await store.getStatistics();
            res.json({ success: true, data: stats });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ============ OAuth 认证 ============

    // 启动 OAuth 流程
    app.post('/api/codex/oauth/start', authMiddleware, async (req, res) => {
        try {
            const result = await startCodexOAuth();
            res.json(result);
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // OAuth 回调处理
    app.get('/api/codex/oauth/callback', async (req, res) => {
        try {
            const { code, state } = req.query;
            if (!code || !state) {
                return res.status(400).json({ success: false, error: '缺少 code 或 state 参数' });
            }

            const credentials = await completeCodexOAuth(code, state);

            // 保存到数据库
            const store = await CodexCredentialStore.create();
            const name = credentials.email || `codex-${Date.now()}`;

            // 检查是否已存在
            let existing = await store.getByEmail(credentials.email);
            if (existing) {
                await store.updateTokens(existing.id, credentials);
                res.json({ success: true, message: '凭证已更新', data: { id: existing.id, email: credentials.email } });
            } else {
                const id = await store.create({
                    name,
                    email: credentials.email,
                    accountId: credentials.accountId,
                    accessToken: credentials.accessToken,
                    refreshToken: credentials.refreshToken,
                    idToken: credentials.idToken,
                    expiresAt: credentials.expiresAt
                });
                res.json({ success: true, message: '凭证已保存', data: { id, email: credentials.email } });
            }
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ============ Codex 模型列表 ============

    app.get('/api/codex/models', (req, res) => {
        res.json({
            success: true,
            data: CODEX_MODELS.map(id => ({
                id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'openai'
            }))
        });
    });

    // ============ Codex OpenAI 兼容聊天端点 ============

    // OpenAI 兼容格式 - /codex/v1/chat/completions
    app.post('/codex/v1/chat/completions', async (req, res) => {
        const startTime = Date.now();
        const requestId = 'chatcmpl-' + Date.now() + Math.random().toString(36).substring(2, 8);

        try {
            const { model, messages, stream } = req.body;

            // 验证模型
            const targetModel = model || 'gpt-5';
            if (!CODEX_MODELS.includes(targetModel)) {
                return res.status(400).json({
                    error: {
                        message: `不支持的模型: ${targetModel}，支持的模型: ${CODEX_MODELS.join(', ')}`,
                        type: 'invalid_request_error'
                    }
                });
            }

            // 获取随机可用凭证
            const service = await CodexService.fromRandomActive();

            // 转换消息格式
            let systemPrompt = '';
            const convertedMessages = [];

            for (const msg of messages) {
                if (msg.role === 'system') {
                    systemPrompt += (systemPrompt ? '\n' : '') + (typeof msg.content === 'string' ? msg.content : msg.content.map(c => c.text || '').join(''));
                } else if (msg.role === 'user' || msg.role === 'assistant') {
                    let content = msg.content;
                    if (Array.isArray(content)) {
                        content = content.map(c => c.type === 'text' ? c.text : '').join('');
                    }
                    convertedMessages.push({ role: msg.role, content });
                }
            }

            if (stream) {
                // 流式响应
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');

                try {
                    for await (const event of service.chatStream(targetModel, convertedMessages, { system: systemPrompt })) {
                        if (event.type === 'content' && event.data) {
                            const chunk = {
                             id: requestId,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model: targetModel,
                                choices: [{
                                    index: 0,
                                    delta: { content: event.data },
                                    finish_reason: null
                                }]
                            };
                            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        }
                    }

                    // 发送结束标记
                    const finalChunk = {
                        id: requestId,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: targetModel,
                        choices: [{
                            index: 0,
                            delta: {},
                            finish_reason: 'stop'
                        }]
                    };
                    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                } catch (streamError) {
                    console.error(`[Codex] 流式请求错误:`, streamError.message);
                    res.write(`data: ${JSON.stringify({ error: { message: streamError.message, type: 'server_error' } })}\n\n`);
                    res.end();
                }
            } else {
                // 非流式响应
                const response = await service.chat(targetModel, convertedMessages, { system: systemPrompt });

                const inputTokens = Math.ceil(JSON.stringify(messages).length / 4);
                const outputTokens = Math.ceil(response.length / 4);

                res.json({
                    id: requestId,
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model: targetModel,
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: response },
                        finish_reason: 'stop'
                    }],
                    usage: {
                        prompt_tokens: inputTokens,
                        completion_tokens: outputTokens,
                        total_tokens: inputTokens + outputTokens
                    }
                });
            }
        } catch (error) {
            console.error(`[Codex] 聊天请求错误:`, error.message);
            res.status(500).json({
                error: {
                    message: error.message,
                    type: 'server_error'
                }
            });
        }
    });

    // OpenAI 兼容格式 - 模型列表
    app.get('/codex/v1/models', (req, res) => {
        res.json({
            object: 'list',
            data: CODEX_MODELS.map(id => ({
                id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'openai'
            }))
        });
    });

    console.log('[Codex] 路由已设置');
}