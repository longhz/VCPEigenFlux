// eigenflux-bridge.js — VCPEigenFlux 插件主入口 (hybridservice)
// 直调 EigenFlux Hub HTTP API，不依赖 CLI 二进制
// 契约：initialize(config) / processToolCall(args) / registerApiRoutes(router, config, basePath, wss)

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

// ============================================================
// 常量 & 全局状态
// ============================================================

const DATA_FILE = path.join(__dirname, 'eigenflux-data.json');
const CONFIG_FILE = path.join(__dirname, 'config.env');
const ARCHIVE_ROOT = path.join(__dirname, 'data', 'feed-archive');
const LATEST_FEED_FILE = path.join(__dirname, 'data', 'latest-feed.json');
const ARCHIVE_STATE_FILE = path.join(__dirname, 'data', 'eigenflux-state.json');

let efConfig = {
    hubEndpoint: 'https://www.eigenflux.ai',
    accessToken: '',
    heartbeatIntervalMin: 30,
    autoPublish: false,
    feedLimit: 20,
    proxy: 'http://127.0.0.1:10808'
};

let state = {
    connected: false,
    lastFeedPoll: null,
    lastMsgCheck: null,
    feedCache: [],
    unreadMessages: [],
    profile: null,
    heartbeatTimer: null,
    startTime: null,
    webSocketServer: null,
    stats: {
        feedPollCount: 0,
        publishCount: 0,
        msgSendCount: 0,
        errorCount: 0
    }
};

// ============================================================
// 配置加载
// ============================================================

function loadConfigFromEnv() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
            for (const line of content.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx === -1) continue;
                const key = trimmed.substring(0, eqIdx).trim();
                const val = trimmed.substring(eqIdx + 1).trim();
                switch (key) {
                    case 'EF_HUB_ENDPOINT': efConfig.hubEndpoint = val || efConfig.hubEndpoint; break;
                    case 'EF_ACCESS_TOKEN': efConfig.accessToken = val; break;
                    case 'EF_HEARTBEAT_INTERVAL_MIN': efConfig.heartbeatIntervalMin = parseInt(val) || 30; break;
                    case 'EF_AUTO_PUBLISH': efConfig.autoPublish = val === 'true'; break;
                    case 'EF_FEED_LIMIT': efConfig.feedLimit = parseInt(val) || 20; break;
                    case 'EF_PROXY': efConfig.proxy = val || ''; break;
                }
            }
        }
    } catch (e) {
        console.error('[VCPEigenFlux] 加载配置失败:', e.message);
    }
}

// 也从 PluginManager 传入的 pluginSpecificEnvConfig 加载
function loadConfigFromPluginEnv(pluginEnv) {
    if (!pluginEnv) return;
    if (pluginEnv.EF_HUB_ENDPOINT) efConfig.hubEndpoint = pluginEnv.EF_HUB_ENDPOINT;
    if (pluginEnv.EF_ACCESS_TOKEN) efConfig.accessToken = pluginEnv.EF_ACCESS_TOKEN;
    if (pluginEnv.EF_HEARTBEAT_INTERVAL_MIN) efConfig.heartbeatIntervalMin = parseInt(pluginEnv.EF_HEARTBEAT_INTERVAL_MIN) || 30;
    if (pluginEnv.EF_AUTO_PUBLISH) efConfig.autoPublish = pluginEnv.EF_AUTO_PUBLISH === 'true';
    if (pluginEnv.EF_FEED_LIMIT) efConfig.feedLimit = parseInt(pluginEnv.EF_FEED_LIMIT) || 20;
    if (pluginEnv.EF_PROXY) efConfig.proxy = pluginEnv.EF_PROXY;
}

// ============================================================
// 数据持久化
// ============================================================

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf-8');
            const data = JSON.parse(raw);
            state.feedCache = data.feedCache || [];
            state.unreadMessages = data.unreadMessages || [];
            state.profile = data.profile || null;
            state.stats = { ...state.stats, ...(data.stats || {}) };
        }
    } catch (e) {
        console.error('[VCPEigenFlux] 加载数据失败:', e.message);
    }
}

function saveData() {
    try {
        const data = {
            feedCache: state.feedCache.slice(0, 100),
            unreadMessages: state.unreadMessages.slice(0, 50),
            profile: state.profile,
            stats: state.stats,
            lastSaved: new Date().toISOString()
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
        console.error('[VCPEigenFlux] 保存数据失败:', e.message);
    }
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function safeJsonRead(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
        console.error(`[VCPEigenFlux] JSON读取失败 ${filePath}:`, e.message);
        return fallback;
    }
}

function safeJsonWrite(filePath, data) {
    ensureDir(path.dirname(filePath));
    const tmpFile = `${filePath}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpFile, filePath);
}

function getLocalDateParts(date = new Date()) {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return { year, month, day, dateKey: `${year}-${month}-${day}` };
}

function getFeedItemId(item) {
    if (!item || typeof item !== 'object') return '';
    if (item.item_id) return String(item.item_id);
    if (item.id) return String(item.id);
    const basis = [
        item.author_id || item.author_name || '',
        item.created_at || item.createdAt || '',
        item.summary || '',
        item.content || ''
    ].join('|');
    let hash = 0;
    for (let i = 0; i < basis.length; i++) {
        hash = ((hash << 5) - hash + basis.charCodeAt(i)) | 0;
    }
    return `hash_${Math.abs(hash)}`;
}

function archiveFeedItems(items, meta = {}) {
    try {
        if (!Array.isArray(items)) return { archived: false, newItems: 0, totalItems: 0 };

        const now = new Date();
        const nowIso = now.toISOString();
        const { year, month, dateKey } = getLocalDateParts(now);
        const dayDir = path.join(ARCHIVE_ROOT, year, month);
        const dailyFile = path.join(dayDir, `${dateKey}-eigenflux-feed.json`);

        const archive = safeJsonRead(dailyFile, {
            date: dateKey,
            source: 'EigenFlux',
            title: `EigenFlux Feed Archive ${dateKey}`,
            createdAt: nowIso,
            updatedAt: nowIso,
            heartbeatCount: 0,
            totalItems: 0,
            newItems: 0,
            items: []
        });

        const archiveState = safeJsonRead(ARCHIVE_STATE_FILE, {
            source: 'EigenFlux',
            createdAt: nowIso,
            updatedAt: nowIso,
            totalSeenItems: 0,
            days: {},
            seenItemIds: {}
        });

        const byId = new Map();
        for (const oldItem of archive.items || []) {
            const id = getFeedItemId(oldItem);
            if (id) byId.set(id, oldItem);
        }

        let newCount = 0;
        for (const rawItem of items) {
            const id = getFeedItemId(rawItem);
            if (!id) continue;

            if (byId.has(id)) {
                const existing = byId.get(id);
                existing.lastSeenAt = nowIso;
                existing.seenCount = (existing.seenCount || 1) + 1;
                existing.raw = rawItem;
            } else {
                const archivedItem = {
                    item_id: id,
                    firstSeenAt: nowIso,
                    lastSeenAt: nowIso,
                    seenCount: 1,
                    raw: rawItem
                };
                archive.items.push(archivedItem);
                byId.set(id, archivedItem);
                newCount++;
            }

            archiveState.seenItemIds[id] = {
                firstSeenAt: archiveState.seenItemIds[id]?.firstSeenAt || nowIso,
                lastSeenAt: nowIso,
                lastDate: dateKey
            };
        }

        archive.updatedAt = nowIso;
        archive.heartbeatCount = (archive.heartbeatCount || 0) + 1;
        archive.totalItems = archive.items.length;
        archive.newItems = (archive.newItems || 0) + newCount;
        archive.lastHeartbeat = {
            at: nowIso,
            feedCount: items.length,
            newItems: newCount,
            action: meta.action || 'refresh',
            limit: meta.limit || efConfig.feedLimit
        };

        archiveState.updatedAt = nowIso;
        archiveState.totalSeenItems = Object.keys(archiveState.seenItemIds || {}).length;
        archiveState.days[dateKey] = {
            file: dailyFile,
            totalItems: archive.totalItems,
            updatedAt: nowIso
        };

        const latest = {
            source: 'EigenFlux',
            updatedAt: nowIso,
            date: dateKey,
            feedCount: items.length,
            newItems: newCount,
            dailyArchiveFile: dailyFile,
            items
        };

        safeJsonWrite(dailyFile, archive);
        safeJsonWrite(LATEST_FEED_FILE, latest);
        safeJsonWrite(ARCHIVE_STATE_FILE, archiveState);

        return { archived: true, newItems: newCount, totalItems: archive.totalItems, file: dailyFile };
    } catch (e) {
        state.stats.errorCount++;
        console.error('[VCPEigenFlux] Feed归档失败:', e.message);
        return { archived: false, error: e.message, newItems: 0, totalItems: 0 };
    }
}

// ============================================================
// HTTP 客户端（支持代理）
// ============================================================

function makeRequest(method, apiPath, body = null) {
    return new Promise((resolve, reject) => {
        const baseUrl = efConfig.hubEndpoint.replace(/\/$/, '');
        const fullUrl = `${baseUrl}/api/v1${apiPath}`;
        const parsed = new URL(fullUrl);

        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'VCPEigenFlux/0.1.0'
        };
        if (efConfig.accessToken) {
            headers['Authorization'] = `Bearer ${efConfig.accessToken}`;
        }

        let bodyStr = null;
        if (body) {
            bodyStr = JSON.stringify(body);
            headers['Content-Length'] = Buffer.byteLength(bodyStr);
        }

        const useProxy = efConfig.proxy && efConfig.proxy.length > 0;
        const isHttps = parsed.protocol === 'https:';

        function doRequest(socket) {
            const reqOptions = {
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: method,
                headers: headers
            };
            if (socket) {
                reqOptions.socket = socket;
                reqOptions.agent = false;
            }

            const transport = isHttps ? https : http;
            const req = transport.request(reqOptions, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        resolve({ status: res.statusCode, data: json });
                    } catch (e) {
                        resolve({ status: res.statusCode, data: data });
                    }
                });
            });

            req.on('error', (e) => {
                state.stats.errorCount++;
                reject(e);
            });

            req.setTimeout(30000, () => {
                req.destroy();
                reject(new Error('请求超时 (30s)'));
            });

            if (bodyStr) req.write(bodyStr);
            req.end();
        }

        if (useProxy && isHttps) {
            // HTTPS over HTTP proxy: 先建立 CONNECT 隧道
            const proxyUrl = new URL(efConfig.proxy);
            const connectReq = http.request({
                hostname: proxyUrl.hostname,
                port: proxyUrl.port || 10808,
                method: 'CONNECT',
                path: `${parsed.hostname}:${parsed.port || 443}`
            });

            connectReq.on('connect', (res, socket) => {
                if (res.statusCode === 200) {
                    doRequest(socket);
                } else {
                    reject(new Error(`代理 CONNECT 失败: ${res.statusCode}`));
                }
            });

            connectReq.on('error', (e) => {
                state.stats.errorCount++;
                reject(new Error(`代理连接失败: ${e.message}`));
            });

            connectReq.setTimeout(15000, () => {
                connectReq.destroy();
                reject(new Error('代理 CONNECT 超时 (15s)'));
            });

            connectReq.end();
        } else if (useProxy && !isHttps) {
            // HTTP over HTTP proxy: 直接把完整 URL 当 path
            const proxyUrl = new URL(efConfig.proxy);
            const req = http.request({
                hostname: proxyUrl.hostname,
                port: proxyUrl.port || 10808,
                path: fullUrl,
                method: method,
                headers: { ...headers, 'Host': parsed.hostname }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        resolve({ status: res.statusCode, data: json });
                    } catch (e) {
                        resolve({ status: res.statusCode, data: data });
                    }
                });
            });

            req.on('error', (e) => {
                state.stats.errorCount++;
                reject(e);
            });

            req.setTimeout(30000, () => {
                req.destroy();
                reject(new Error('请求超时 (30s)'));
            });

            if (bodyStr) req.write(bodyStr);
            req.end();
        } else {
            // 无代理直连
            doRequest(null);
        }
    });
}

// ============================================================
// EigenFlux API 封装
// ============================================================

async function feedPoll(limit, action = 'refresh', cursor = '') {
    const params = new URLSearchParams();
    params.set('limit', String(limit || efConfig.feedLimit));
    if (action) params.set('action', action);
    if (cursor) params.set('cursor', cursor);
    const resp = await makeRequest('GET', `/items/feed?${params.toString()}`);
    if (resp.status === 200 && resp.data && resp.data.code === 0) {
        state.feedCache = resp.data.data?.items || [];
        state.lastFeedPoll = new Date().toISOString();
        state.stats.feedPollCount++;
        const archiveResult = archiveFeedItems(state.feedCache, { limit, action, cursor });
        state.lastArchive = archiveResult;
        saveData();
    }
    return resp;
}

async function publish(content, notes = {}) {
    const body = {
        content: content,
        notes: JSON.stringify({
            type: notes.type || 'info',
            domains: notes.domains || [],
            summary: notes.summary || content.substring(0, 200),
            expire_time: notes.expire_time || new Date(Date.now() + 7 * 86400000).toISOString(),
            source_type: notes.source_type || 'original'
        }),
        accept_reply: notes.accept_reply !== false
    };
    const resp = await makeRequest('POST', '/items/publish', body);
    if (resp.status === 200) {
        state.stats.publishCount++;
        saveData();
    }
    return resp;
}

async function feedGet(itemId) {
    return await makeRequest('GET', `/items/${itemId}`);
}

async function feedback(items) {
    return await makeRequest('POST', '/items/feedback', { items });
}

async function msgSend(content, opts = {}) {
    const body = { content };
    if (opts.item_id) body.item_id = opts.item_id;
    if (opts.conv_id) body.conv_id = opts.conv_id;
    if (opts.receiver_id) body.receiver_id = opts.receiver_id;
    const resp = await makeRequest('POST', '/pm/send', body);
    if (resp.status === 200) {
        state.stats.msgSendCount++;
        saveData();
    }
    return resp;
}

async function msgFetch(limit = 20) {
    const resp = await makeRequest('GET', `/pm/fetch?limit=${limit}`);
    if (resp.status === 200 && resp.data && resp.data.code === 0) {
        state.unreadMessages = resp.data.data?.messages || [];
        state.lastMsgCheck = new Date().toISOString();
        saveData();
    }
    return resp;
}

async function msgHistory(convId, limit = 50) {
    return await makeRequest('GET', `/pm/history?conv_id=${convId}&limit=${limit}`);
}

async function msgClose(convId) {
    return await makeRequest('POST', '/pm/close', { conv_id: convId });
}

async function profileShow() {
    const resp = await makeRequest('GET', '/agents/me');
    if (resp.status === 200 && resp.data && resp.data.code === 0) {
        state.profile = resp.data.data;
        saveData();
    }
    return resp;
}

async function profileUpdate(bio) {
    return await makeRequest('PUT', '/agents/profile', { bio });
}

async function relationApply(email, greeting = '', remark = '') {
    return await makeRequest('POST', '/relations/apply', { to_email: email, greeting, remark });
}

async function relationHandle(requestId, action, remark = '') {
    return await makeRequest('POST', '/relations/handle', { request_id: requestId, action, remark });
}

async function relationFriends(limit = 20) {
    return await makeRequest('GET', `/relations/friends?limit=${limit}`);
}

// ============================================================
// 心跳定时器
// ============================================================

function startHeartbeat() {
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);

    const intervalMs = Math.max(efConfig.heartbeatIntervalMin, 5) * 60 * 1000;
    console.log(`[VCPEigenFlux] 心跳启动，间隔 ${efConfig.heartbeatIntervalMin} 分钟`);

    state.heartbeatTimer = setInterval(async () => {
        await runHeartbeat();
    }, intervalMs);

    // 启动后延迟 5 秒执行一次初始连接
    setTimeout(async () => {
        if (efConfig.accessToken) {
            try {
                await profileShow();
                await runHeartbeat();
                state.connected = true;
                console.log(`[VCPEigenFlux] 初始连接成功，Profile: ${state.profile?.profile?.agent_name || 'unknown'}`);
            } catch (e) {
                console.error('[VCPEigenFlux] 初始连接失败:', e.message);
            }
        } else {
            console.warn('[VCPEigenFlux] 未配置 EF_ACCESS_TOKEN，心跳未激活');
        }
    }, 5000);
}

async function runHeartbeat() {
    try {
        await feedPoll(efConfig.feedLimit);
        await msgFetch(20);
        console.log(`[VCPEigenFlux] 心跳完成: Feed ${state.feedCache.length} 条, 未读 ${state.unreadMessages.length} 条`);

        // WebSocket 推送通知（如果有新内容）
        if (state.webSocketServer && (state.feedCache.length > 0 || state.unreadMessages.length > 0)) {
            try {
                state.webSocketServer.broadcast(JSON.stringify({
                    type: 'eigenflux_notification',
                    data: {
                        feedCount: state.feedCache.length,
                        unreadCount: state.unreadMessages.length,
                        timestamp: new Date().toISOString()
                    }
                }));
            } catch (wsErr) {
                // WebSocket 推送失败不影响主流程
            }
        }
    } catch (e) {
        console.error('[VCPEigenFlux] 心跳错误:', e.message);
        state.stats.errorCount++;
    }
}

function stopHeartbeat() {
    if (state.heartbeatTimer) {
        clearInterval(state.heartbeatTimer);
        state.heartbeatTimer = null;
        console.log('[VCPEigenFlux] 心跳已停止');
    }
}

// ============================================================
// processToolCall — PluginManager 调用入口
// ============================================================

async function processToolCall(args) {
    const command = args.command || '';

    try {
        switch (command) {
            case 'EFPublish': {
                if (!args.content) return formatResult(false, '缺少 content 参数');
                const domains = args.domains ? args.domains.split(',').map(d => d.trim()) : [];
                const resp = await publish(args.content, {
                    type: args.type || 'info',
                    domains,
                    summary: args.summary || '',
                    accept_reply: args.accept_reply !== 'false'
                });
                return formatResult(true, '广播发布成功', resp.data);
            }

            case 'EFFeed': {
                const resp = await feedPoll(
                    parseInt(args.limit) || efConfig.feedLimit,
                    args.action || 'refresh',
                    args.cursor || ''
                );
                const items = resp.data?.data?.items || [];
                if (items.length === 0) {
                    return formatResult(true, 'Feed 当前为空，可能是新账号尚未匹配到内容，或已全部消费完毕。');
                }
                // 格式化 Feed 为 Agent 友好的文本
                let feedText = `## EigenFlux Feed (${items.length} 条)\n\n`;
                items.forEach((item, i) => {
                    feedText += `### ${i + 1}. [${item.broadcast_type || 'info'}] ${item.summary || '(无摘要)'}\n`;
                    feedText += `- 作者: ${item.author_name || 'unknown'}\n`;
                    feedText += `- 领域: ${(item.domains || []).join(', ') || 'N/A'}\n`;
                    feedText += `- 内容: ${item.content || ''}\n`;
                    feedText += `- item_id: ${item.item_id}\n\n`;
                });
                return formatResult(true, feedText);
            }

            case 'EFMessage': {
                const action = args.action;
                if (!action) return formatResult(false, '缺少 action 参数 (send/fetch/history/close)');
                switch (action) {
                    case 'send': {
                        if (!args.content) return formatResult(false, '缺少 content 参数');
                        const resp = await msgSend(args.content, {
                            item_id: args.item_id, conv_id: args.conv_id, receiver_id: args.receiver_id
                        });
                        return formatResult(true, '消息发送成功', resp.data);
                    }
                    case 'fetch': {
                        const resp = await msgFetch(parseInt(args.limit) || 20);
                        return formatResult(true, '未读消息获取成功', resp.data);
                    }
                    case 'history': {
                        if (!args.conv_id) return formatResult(false, '缺少 conv_id 参数');
                        const resp = await msgHistory(args.conv_id, parseInt(args.limit) || 50);
                        return formatResult(true, '对话历史获取成功', resp.data);
                    }
                    case 'close': {
                        if (!args.conv_id) return formatResult(false, '缺少 conv_id 参数');
                        const resp = await msgClose(args.conv_id);
                        return formatResult(true, '对话已关闭', resp.data);
                    }
                    default: return formatResult(false, `未知 action: ${action}`);
                }
            }

            case 'EFFriend': {
                const action = args.action;
                if (!action) return formatResult(false, '缺少 action 参数 (apply/handle/list)');
                switch (action) {
                    case 'apply': {
                        if (!args.email) return formatResult(false, '缺少 email 参数');
                        const resp = await relationApply(args.email, args.greeting || '', args.remark || '');
                        return formatResult(true, '好友申请已发送', resp.data);
                    }
                    case 'handle': {
                        if (!args.request_id || !args.handle_action) return formatResult(false, '缺少 request_id 或 handle_action');
                        const resp = await relationHandle(args.request_id, args.handle_action, args.remark || '');
                        return formatResult(true, '好友请求已处理', resp.data);
                    }
                    case 'list': {
                        const resp = await relationFriends(parseInt(args.limit) || 20);
                        return formatResult(true, '好友列表获取成功', resp.data);
                    }
                    default: return formatResult(false, `未知 action: ${action}`);
                }
            }

            case 'EFProfile': {
                if (args.bio) {
                    const resp = await profileUpdate(args.bio);
                    return formatResult(true, 'Profile 更新成功', resp.data);
                } else {
                    const resp = await profileShow();
                    return formatResult(true, 'Profile 信息', resp.data);
                }
            }

            case 'EFStatus': {
                return formatResult(true, 'EigenFlux 连接状态', {
                    connected: state.connected,
                    hubEndpoint: efConfig.hubEndpoint,
                    hasToken: !!efConfig.accessToken,
                    heartbeatInterval: `${efConfig.heartbeatIntervalMin}min`,
                    heartbeatRunning: !!state.heartbeatTimer,
                    lastFeedPoll: state.lastFeedPoll,
                    lastMsgCheck: state.lastMsgCheck,
                    feedCacheCount: state.feedCache.length,
                    unreadMsgCount: state.unreadMessages.length,
                    profile: state.profile?.profile ? {
                        agent_name: state.profile.profile.agent_name,
                        email: state.profile.profile.email,
                        agent_id: state.profile.profile.agent_id
                    } : null,
                    stats: state.stats,
                    uptime: state.startTime ? `${Math.round((Date.now() - state.startTime) / 60000)} min` : 'N/A'
                });
            }

            default:
                return formatResult(false, `未知命令: ${command}。支持的命令: EFPublish, EFFeed, EFMessage, EFFriend, EFProfile, EFStatus`);
        }
    } catch (e) {
        state.stats.errorCount++;
        return formatResult(false, `执行出错: ${e.message}`);
    }
}

function formatResult(success, message, data = null) {
    const result = { status: success ? 'success' : 'error' };
    if (success) {
        result.result = data ? `${message}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`` : message;
    } else {
        result.error = message;
    }
    return result;
}

// ============================================================
// initialize — PluginManager 启动时调用
// ============================================================

function initialize(config) {
    console.log('[VCPEigenFlux] 初始化中...');

    // 从 config.env 加载
    loadConfigFromEnv();
    // 从 PluginManager 传入的环境变量覆盖
    loadConfigFromPluginEnv(config);

    loadData();
    state.startTime = Date.now();

    // 启动心跳
    startHeartbeat();

    console.log(`[VCPEigenFlux] 初始化完成 | Hub: ${efConfig.hubEndpoint} | Token: ${efConfig.accessToken ? 'configured' : 'MISSING'}`);
}

// ============================================================
// registerApiRoutes — PluginManager 注册 HTTP 路由
// 签名: (router, config, projectBasePath, webSocketServer)
// ============================================================

function registerApiRoutes(router, config, projectBasePath, wss) {
    if (wss) {
        state.webSocketServer = wss;
        console.log('[VCPEigenFlux] WebSocketServer 已注入');
    }

    // GET /eigenflux/status — 连接状态
    router.get('/status', (req, res) => {
        res.json({
            connected: state.connected,
            hubEndpoint: efConfig.hubEndpoint,
            hasToken: !!efConfig.accessToken,
            heartbeatRunning: !!state.heartbeatTimer,
            lastFeedPoll: state.lastFeedPoll,
            lastMsgCheck: state.lastMsgCheck,
            feedCacheCount: state.feedCache.length,
            unreadMsgCount: state.unreadMessages.length,
            stats: state.stats,
            uptime: state.startTime ? `${Math.round((Date.now() - state.startTime) / 60000)} min` : 'N/A'
        });
    });

    // GET /eigenflux/feed — Feed 缓存
    router.get('/feed', (req, res) => {
        const limit = parseInt(req.query.limit) || 20;
        res.json({
            items: state.feedCache.slice(0, limit),
            total: state.feedCache.length,
            lastPoll: state.lastFeedPoll
        });
    });

    // GET /eigenflux/messages — 未读消息
    router.get('/messages', (req, res) => {
        res.json({
            messages: state.unreadMessages,
            total: state.unreadMessages.length,
            lastCheck: state.lastMsgCheck
        });
    });

    // POST /eigenflux/heartbeat — 手动触发心跳
    router.post('/heartbeat', async (req, res) => {
        try {
            await runHeartbeat();
            res.json({ success: true, message: '心跳手动触发完成' });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    console.log('[VCPEigenFlux] API 路由已注册: /eigenflux/*');
}

// ============================================================
// module.exports — PluginManager 契约
// ============================================================

module.exports = {
    initialize,
    processToolCall,
    registerApiRoutes
};