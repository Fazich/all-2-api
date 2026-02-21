/**
 * AMI API 路由
 * 提供 AMI 凭据管理和对话 API
 */
import { AmiService, AMI_MODELS } from './ami-service.js';
import { logger } from '../logger.js';

const log = logger.server;

/**
 * 清洗 sessionCookie：自动去除 wos-session= 前缀
 */
function cleanCookie(raw) {
    if (!raw) return raw;
    return raw.startsWith('wos-session=') ? raw.substring('wos-session='.length) : raw;
}

/**
 * 创建 AMI 对话请求 handler（可复用）
 * 供 /ami/v1/messages 路由和 server.js Model-Provider 路由共用
 */
export function createAmiMessagesHandler(amiStore, verifyApiKey) {
    return async function handleAmiMessages(req, res) {
        let credential = null;

        try {
            // 验证 API Key
            const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
            if (!apiKey) {
                return res.status(401).json({
                    type: 'error',
                    error: { type: 'authentication_error', message: '缺少 API Key' },
                });
            }

            const keyRecord = await verifyApiKey(apiKey);
            if (!keyRecord || !keyRecord.isActive) {
                return res.status(401).json({
                    type: 'error',
                    error: { type: 'authentication_error', message: 'API Key 无效或已禁用' },
                });
            }

            const { model, messages, stream = true, system, max_tokens, temperature, tools } = req.body;

            // 使用 DB 层负载均衡选取凭据（按 use_count 升序 + 随机）
            credential = await amiStore.getRandomActive();

            if (!credential) {
                return res.status(503).json({
                    type: 'error',
                    error: { type: 'service_unavailable', message: '没有可用的 AMI 凭据' },
                });
            }

            // 自动清洗 cookie
            credential.sessionCookie = cleanCookie(credential.sessionCookie);

            const service = new AmiService(credential);

            // 如果缺少 projectId 或 chatId，自动创建项目并回写 DB
            if (!credential.projectId || !credential.chatId) {
                const project = await service.createProject(`API-${credential.name || credential.id}`);
                await amiStore.update(credential.id, {
                    projectId: project.projectId,
                    chatId: project.chatId,
                });
            }

            log.info(`[AMI] 对话请求: model=${model}, stream=${stream}, credential=${credential.id}`);

            const requestBody = { messages, system, max_tokens, temperature, tools };

            if (stream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');

                try {
                    for await (const event of service.generateContentStream(model, requestBody)) {
                        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                    }
                } catch (streamError) {
                    log.error(`[AMI] 流式响应错误: ${streamError.message}`);
                    res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: streamError.message } })}\n\n`);
                    await amiStore.incrementErrorCount(credential.id, streamError.message);
                }

                res.end();
            } else {
                const response = await service.generateContent(model, requestBody);
                res.json(response);
            }

            // 成功后递增使用次数
            await amiStore.incrementUseCount(credential.id);
        } catch (error) {
            log.error(`[AMI] 对话请求失败: ${error.message}`);

            if (credential) {
                await amiStore.incrementErrorCount(credential.id, error.message);
            }

            if (!res.headersSent) {
                res.status(500).json({
                    type: 'error',
                    error: { type: 'api_error', message: error.message },
                });
            }
        }
    };
}

export function setupAmiRoutes(app, amiStore, verifyApiKey) {

    // ============ 统计 API ============

    app.get('/api/ami/statistics', async (req, res) => {
        try {
            const stats = await amiStore.getStatistics();
            res.json({
                success: true,
                data: {
                    total: stats.total,
                    active: stats.active,
                    error: stats.error,
                    totalUsage: stats.totalUseCount,
                },
            });
        } catch (error) {
            log.error(`[AMI] 获取统计信息失败: ${error.message}`);
            res.json({ success: true, data: { total: 0, active: 0, error: 0, totalUsage: 0 } });
        }
    });

    // ============ 凭据管理 API ============

    // 获取所有 AMI 凭据
    app.get('/api/ami/credentials', async (req, res) => {
        try {
            const credentials = await amiStore.getAll();
            const safeCredentials = credentials.map(c => ({
                ...c,
                sessionCookie: c.sessionCookie ? '***' + c.sessionCookie.slice(-20) : null,
            }));
            res.json({ success: true, data: safeCredentials });
        } catch (error) {
            log.error(`[AMI] 获取凭据列表失败: ${error.message}`);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 添加 AMI 凭据
    app.post('/api/ami/credentials', async (req, res) => {
        try {
            const { name, sessionCookie, projectId, chatId, note } = req.body;

            if (!sessionCookie) {
                return res.status(400).json({ success: false, error: '缺少 sessionCookie' });
            }

            const credential = await amiStore.add({
                name: name || `AMI-${Date.now()}`,
                sessionCookie: cleanCookie(sessionCookie),
                projectId: projectId || '',
                chatId: chatId || '',
                note: note || '',
                status: 'active',
            });

            log.info(`[AMI] 添加凭据: ${credential.name}`);
            res.json({ success: true, data: { ...credential, sessionCookie: '***' } });
        } catch (error) {
            log.error(`[AMI] 添加凭据失败: ${error.message}`);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 更新 AMI 凭据
    app.put('/api/ami/credentials/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            const { name, sessionCookie, projectId, chatId, note, status } = req.body;

            const updateData = { name, projectId, chatId, note, status };
            if (sessionCookie !== undefined) {
                updateData.sessionCookie = cleanCookie(sessionCookie);
            }

            const updated = await amiStore.update(id, updateData);

            if (!updated) {
                return res.status(404).json({ success: false, error: '凭据不存在' });
            }

            log.info(`[AMI] 更新凭据: ${id}`);
            res.json({ success: true, data: { ...updated, sessionCookie: '***' } });
        } catch (error) {
            log.error(`[AMI] 更新凭据失败: ${error.message}`);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 删除 AMI 凭据
    app.delete('/api/ami/credentials/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            const deleted = await amiStore.delete(id);

            if (!deleted) {
                return res.status(404).json({ success: false, error: '凭据不存在' });
            }

            log.info(`[AMI] 删除凭据: ${id}`);
            res.json({ success: true });
        } catch (error) {
            log.error(`[AMI] 删除凭据失败: ${error.message}`);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 测试 AMI 凭据
    app.post('/api/ami/credentials/:id/test', async (req, res) => {
        const id = parseInt(req.params.id);
        try {
            const credential = await amiStore.getById(id);

            if (!credential) {
                return res.status(404).json({ success: false, error: '凭据不存在' });
            }
            if (!credential.sessionCookie) {
                return res.status(400).json({ success: false, error: '缺少 sessionCookie' });
            }

            // 自动清洗 cookie
            credential.sessionCookie = cleanCookie(credential.sessionCookie);

            log.info(`[AMI] 开始测试凭据: ${id} (${credential.name})`);
            const service = new AmiService(credential);

            // 如果缺少 projectId 或 chatId，自动创建项目
            if (!credential.projectId || !credential.chatId) {
                log.info(`[AMI] 凭据 ${id} 缺少 projectId/chatId，自动创建项目...`);
                const project = await service.createProject(`API-${credential.name || id}`);
                // 回写到数据库
                await amiStore.update(id, {
                    projectId: project.projectId,
                    chatId: project.chatId,
                });
                log.info(`[AMI] 自动创建项目成功: projectId=${project.projectId}, chatId=${project.chatId}`);
            }

            const testResult = await service.generateContent('claude-sonnet-4', {
                messages: [{ role: 'user', content: 'Hi' }],
                max_tokens: 50,
            });

            // 测试成功：重置错误计数
            await amiStore.resetErrorCount(id);

            log.info(`[AMI] 测试凭据成功: ${id}`);
            res.json({ success: true, message: '凭据有效', response: testResult });
        } catch (error) {
            await amiStore.incrementErrorCount(id, error.message);
            log.error(`[AMI] 测试凭据失败: ${error.message}`);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 验证 AMI 凭据格式（不发送实际请求）
    app.post('/api/ami/credentials/:id/validate', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            const credential = await amiStore.getById(id);

            if (!credential) {
                return res.status(404).json({ success: false, error: '凭据不存在' });
            }

            const issues = [];

            if (!credential.sessionCookie) {
                issues.push('缺少 sessionCookie');
            }
            if (!credential.projectId) {
                issues.push('缺少 projectId');
            }
            if (!credential.chatId) {
                issues.push('缺少 chatId');
            }

            if (issues.length > 0) {
                return res.json({
                    success: false,
                    valid: false,
                    issues,
                    message: '凭据格式验证失败：' + issues.join('; '),
                });
            }

            res.json({ success: true, valid: true, message: '凭据格式验证通过，可以进行测试' });
        } catch (error) {
            log.error(`[AMI] 验证凭据格式失败: ${error.message}`);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ============ 对话 API (Claude 格式) ============

    // 创建可复用的 handler（供 /ami/v1/messages 路由和 server.js 的 Model-Provider 路由共用）
    const amiMessagesHandler = createAmiMessagesHandler(amiStore, verifyApiKey);

    app.post('/ami/v1/messages', amiMessagesHandler);

    // ============ 模型列表 ============

    app.get('/ami/v1/models', (req, res) => {
        const models = Object.keys(AMI_MODELS).map(id => ({
            id,
            object: 'model',
            created: Date.now(),
            owned_by: 'ami',
            permission: [],
            root: id,
            parent: null,
        }));

        res.json({ object: 'list', data: models });
    });

    log.info('[AMI] 路由已注册');
}

export default setupAmiRoutes;
