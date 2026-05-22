// eigenflux-bridge.js — VCPEigenFlux 插件主入口 (hybridservice)
// 直调 EigenFlux Hub HTTP API，不依赖 CLI 二进制
// v0.2.0: multi-account collector scaffold
// 契约：initialize(config) / processToolCall(args) / registerApiRoutes(router, config, basePath, wss)

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

// ============================================================
// 常量 & 全局状态
// ============================================================

const CONFIG_FILE = path.join(__dirname, 'config.env');
const ACCOUNTS_CONFIG_FILE = path.join(__dirname, 'accounts.config.json');
const DEFAULT_ACCOUNT_ID = 'technical';
const DATA_ROOT = path.join(__dirname, 'data');
const LEGACY_DATA_FILE = path.join(__dirname, 'eigenflux-data.json');
const LATEST_ALL_FEEDS_FILE = path.join(DATA_ROOT, 'latest-all-feeds.json');
const ACCOUNTS_STATE_FILE = path.join(DATA_ROOT, 'eigenflux-accounts-state.json');

let efConfig = {
    hubEndpoint: 'https://www.eigenflux.ai',
    accessToken: '',
    heartbeatIntervalMin: 30,
    autoPublish: false,
    feedLimit: 20,
    proxy: 'http://127.0.0.1:10808'
};

let accountConfigs = {};
let state = {
    startTime: null,
    webSocketServer: null,
    accounts: {},
    stats: {
        errorCount: 0
    }
};

// ============================================================
// 配置加载
// ============================================================

function loadConfigFromEnv() {
    try {
        if (!fs.existsSync(CONFIG_FILE)) return;
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
    } catch (e) {
        console.error('[VCPEigenFlux] 加载 config.env 失败:', e.message);
    }
}

function loadConfigFromPluginEnv(pluginEnv) {
    if (!pluginEnv) return;
    if (pluginEnv.EF_HUB_ENDPOINT) efConfig.hubEndpoint = pluginEnv.EF_HUB_ENDPOINT;
    if (pluginEnv.EF_ACCESS_TOKEN) efConfig.accessToken = pluginEnv.EF_ACCESS_TOKEN;
    if (pluginEnv.EF_HEARTBEAT_INTERVAL_MIN) efConfig.heartbeatIntervalMin = parseInt(pluginEnv.EF_HEARTBEAT_INTERVAL_MIN) || 30;
    if (pluginEnv.EF_AUTO_PUBLISH) efConfig.autoPublish = pluginEnv.EF_AUTO_PUBLISH === 'true';
    if (pluginEnv.EF_FEED_LIMIT) efConfig.feedLimit = parseInt(pluginEnv.EF_FEED_LIMIT) || 20;
    if (pluginEnv.EF_PROXY) efConfig.proxy = pluginEnv.EF_PROXY;
}

function defaultAccountConfig() {
    return {
        id: DEFAULT_ACCOUNT_ID,
        displayName: 'VCP Family 技术账号',
        hubEndpoint: efConfig.hubEndpoint,
        accessToken: efConfig.accessToken,
        heartbeatIntervalMin: efConfig.heartbeatIntervalMin,
        heartbeatOffsetMin: 0,
        autoPublish: efConfig.autoPublish,
        feedLimit: efConfig.feedLimit,
        proxy: efConfig.proxy,
        enabled: true,
        profileDraft: 'Domains: AI agents, multi-agent systems, open-source tooling, knowledge management, RAG systems'
    };
}

function normalizeAccountId(accountId) {
    const id = String(accountId || DEFAULT_ACCOUNT_ID).trim();
    return id || DEFAULT_ACCOUNT_ID;
}

function loadAccountsConfig() {
    accountConfigs = {};
    const fallback = defaultAccountConfig();

    try {
        if (!fs.existsSync(ACCOUNTS_CONFIG_FILE)) {
            accountConfigs[DEFAULT_ACCOUNT_ID] = fallback;
            return accountConfigs;
        }

        const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_CONFIG_FILE, 'utf-8'));
        const list = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed.accounts)
                ? parsed.accounts
                : Object.keys(parsed).map(id => ({ id, ...(parsed[id] || {}) }));

        for (const item of list) {
            if (!item) continue;
            const id = normalizeAccountId(item.id || item.accountId || item.name);
            accountConfigs[id] = {
                id,
                displayName: item.displayName || item.name || id,
                hubEndpoint: item.hubEndpoint || efConfig.hubEndpoint,
                accessToken: item.accessToken || '',
                heartbeatIntervalMin: parseInt(item.heartbeatIntervalMin) || efConfig.heartbeatIntervalMin,
                heartbeatOffsetMin: parseInt(item.heartbeatOffsetMin) || 0,
                autoPublish: item.autoPublish === true,
                feedLimit: parseInt(item.feedLimit) || efConfig.feedLimit,
                proxy: item.proxy !== undefined ? item.proxy : efConfig.proxy,
                enabled: item.enabled !== false,
                profileDraft: item.profileDraft || ''
            };
        }

        if (!accountConfigs[DEFAULT_ACCOUNT_ID]) {
            accountConfigs[DEFAULT_ACCOUNT_ID] = fallback;
        } else {
            accountConfigs[DEFAULT_ACCOUNT_ID] = {
                ...fallback,
                ...accountConfigs[DEFAULT_ACCOUNT_ID],
                accessToken: accountConfigs[DEFAULT_ACCOUNT_ID].accessToken || efConfig.accessToken
            };
        }
    } catch (e) {
        console.error('[VCPEigenFlux] 加载 accounts.config.json 失败，回退单账号:', e.message);
        accountConfigs[DEFAULT_ACCOUNT_ID] = fallback;
    }

    return accountConfigs;
}

function getAccountConfig(accountId) {
    const id = normalizeAccountId(accountId);
    return accountConfigs[id] || (id === DEFAULT_ACCOUNT_ID ? defaultAccountConfig() : {
        ...defaultAccountConfig(),
        id,
        displayName: id,
        accessToken: ''
    });
}

// ============================================================
// 文件与账号状态
// ============================================================

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
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

function getAccountRoot(accountId) {
    const id = normalizeAccountId(accountId);
    if (id === DEFAULT_ACCOUNT_ID) return __dirname;
    return path.join(DATA_ROOT, 'accounts', id);
}

function getAccountPaths(accountId) {
    const id = normalizeAccountId(accountId);
    const root = getAccountRoot(id);
    const isDefault = id === DEFAULT_ACCOUNT_ID;
    return {
        id,
        root,
        dataFile: isDefault ? LEGACY_DATA_FILE : path.join(root, 'eigenflux-data.json'),
        archiveRoot: isDefault ? path.join(DATA_ROOT, 'feed-archive') : path.join(root, 'feed-archive'),
        latestFeedFile: isDefault ? path.join(DATA_ROOT, 'latest-feed.json') : path.join(root, 'latest-feed.json'),
        archiveStateFile: isDefault ? path.join(DATA_ROOT, 'eigenflux-state.json') : path.join(root, 'eigenflux-state.json'),
        profileFile: path.join(root, 'profile.json'),
        statsFile: path.join(root, 'account-stats.json')
    };
}

function createAccountState(accountId) {
    const cfg = getAccountConfig(accountId);
    const id = normalizeAccountId(cfg.id);
    return {
        id,
        displayName: cfg.displayName || id,
        config: cfg,
        paths: getAccountPaths(id),
        connected: false,
        lastFeedPoll: null,
        lastMsgCheck: null,
        lastArchive: null,
        feedCache: [],
        unreadMessages: [],
        profile: null,
        heartbeatTimer: null,
        stats: {
            feedPollCount: 0,
            publishCount: 0,
            msgSendCount: 0,
            errorCount: 0
        }
    };
}

function ensureAccountState(accountId) {
    const id = normalizeAccountId(accountId);
    if (!state.accounts[id]) state.accounts[id] = createAccountState(id);
    return state.accounts[id];
}

function loadAccountData(accountId) {
    const acc = ensureAccountState(accountId);
    const data = safeJsonRead(acc.paths.dataFile, null);
    if (!data) return acc;
    acc.feedCache = data.feedCache || [];
    acc.unreadMessages = data.unreadMessages || [];
    acc.profile = data.profile || null;
    acc.stats = { ...acc.stats, ...(data.stats || {}) };
    acc.lastFeedPoll = data.lastFeedPoll || null;
    acc.lastMsgCheck = data.lastMsgCheck || null;
    acc.lastArchive = data.lastArchive || null;
    return acc;
}

function saveAccountData(accountId) {
    const acc = ensureAccountState(accountId);
    const data = {
        accountId: acc.id,
        displayName: acc.displayName,
        feedCache: acc.feedCache.slice(0, 100),
        unreadMessages: acc.unreadMessages.slice(0, 50),
        profile: acc.profile,
        stats: acc.stats,
        lastFeedPoll: acc.lastFeedPoll,
        lastMsgCheck: acc.lastMsgCheck,
        lastArchive: acc.lastArchive,
        lastSaved: new Date().toISOString()
    };
    safeJsonWrite(acc.paths.dataFile, data);
    safeJsonWrite(acc.paths.statsFile, {
        accountId: acc.id,
        displayName: acc.displayName,
        stats: acc.stats,
        lastFeedPoll: acc.lastFeedPoll,
        lastMsgCheck: acc.lastMsgCheck,
        lastArchive: acc.lastArchive,
        lastSaved: new Date().toISOString()
    });
    writeGlobalAccountIndex();
}

function buildGlobalAccountIndex() {
    const nowIso = new Date().toISOString();
    const accounts = Object.values(accountConfigs || {}).map(cfg => {
        const acc = ensureAccountState(cfg.id);
        const latest = safeJsonRead(acc.paths.latestFeedFile, {});
        const archiveState = safeJsonRead(acc.paths.archiveStateFile, {});
        return {
            accountId: acc.id,
            displayName: acc.displayName,
            enabled: cfg.enabled !== false,
            connected: !!acc.connected,
            hasToken: !!(cfg.accessToken || (acc.id === DEFAULT_ACCOUNT_ID && efConfig.accessToken)),
            heartbeatIntervalMin: cfg.heartbeatIntervalMin,
            heartbeatOffsetMin: cfg.heartbeatOffsetMin || 0,
            feedLimit: cfg.feedLimit,
            lastFeedPoll: acc.lastFeedPoll,
            lastMsgCheck: acc.lastMsgCheck,
            feedCacheCount: acc.feedCache.length,
            unreadMsgCount: acc.unreadMessages.length,
            latestFeed: {
                file: acc.paths.latestFeedFile,
                updatedAt: latest.updatedAt || null,
                date: latest.date || null,
                feedCount: latest.feedCount || 0,
                newItems: latest.newItems || 0,
                dailyArchiveFile: latest.dailyArchiveFile || null
            },
            archiveState: {
                file: acc.paths.archiveStateFile,
                updatedAt: archiveState.updatedAt || null,
                totalSeenItems: archiveState.totalSeenItems || 0,
                days: archiveState.days || {}
            },
            stats: acc.stats
        };
    });

    return {
        source: 'EigenFlux',
        schemaVersion: 1,
        updatedAt: nowIso,
        defaultAccountId: DEFAULT_ACCOUNT_ID,
        accountCount: accounts.length,
        enabledAccountCount: accounts.filter(a => a.enabled).length,
        totalFeedCacheCount: accounts.reduce((sum, a) => sum + (a.feedCacheCount || 0), 0),
        totalUnreadMsgCount: accounts.reduce((sum, a) => sum + (a.unreadMsgCount || 0), 0),
        totalSeenItems: accounts.reduce((sum, a) => sum + (a.archiveState.totalSeenItems || 0), 0),
        accounts
    };
}

function writeGlobalAccountIndex() {
    try {
        const index = buildGlobalAccountIndex();
        safeJsonWrite(ACCOUNTS_STATE_FILE, index);
        safeJsonWrite(LATEST_ALL_FEEDS_FILE, {
            source: index.source,
            schemaVersion: index.schemaVersion,
            updatedAt: index.updatedAt,
            defaultAccountId: index.defaultAccountId,
            accountCount: index.accountCount,
            enabledAccountCount: index.enabledAccountCount,
            totalFeedCacheCount: index.totalFeedCacheCount,
            totalUnreadMsgCount: index.totalUnreadMsgCount,
            totalSeenItems: index.totalSeenItems,
            accounts: index.accounts.map(a => ({
                accountId: a.accountId,
                displayName: a.displayName,
                enabled: a.enabled,
                connected: a.connected,
                lastFeedPoll: a.lastFeedPoll,
                feedCacheCount: a.feedCacheCount,
                unreadMsgCount: a.unreadMsgCount,
                latestFeed: a.latestFeed,
                archiveStateFile: a.archiveState.file
            }))
        });
        return index;
    } catch (e) {
        state.stats.errorCount++;
        console.error('[VCPEigenFlux] 全局账号索引写入失败:', e.message);
        return null;
    }
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

function archiveFeedItems(accountId, items, meta = {}) {
    const acc = ensureAccountState(accountId);
    try {
        if (!Array.isArray(items)) return { archived: false, newItems: 0, totalItems: 0 };

        const now = new Date();
        const nowIso = now.toISOString();
        const { year, month, dateKey } = getLocalDateParts(now);
        const dayDir = path.join(acc.paths.archiveRoot, year, month);
        const dailyFile = path.join(dayDir, `${dateKey}-eigenflux-feed.json`);

        const archive = safeJsonRead(dailyFile, {
            accountId: acc.id,
            displayName: acc.displayName,
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

        const archiveState = safeJsonRead(acc.paths.archiveStateFile, {
            source: 'EigenFlux',
            accountId: acc.id,
            displayName: acc.displayName,
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
            limit: meta.limit || acc.config.feedLimit
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
            accountId: acc.id,
            displayName: acc.displayName,
            updatedAt: nowIso,
            date: dateKey,
            feedCount: items.length,
            newItems: newCount,
            dailyArchiveFile: dailyFile,
            items
        };

        safeJsonWrite(dailyFile, archive);
        safeJsonWrite(acc.paths.latestFeedFile, latest);
        safeJsonWrite(acc.paths.archiveStateFile, archiveState);

        return { archived: true, newItems: newCount, totalItems: archive.totalItems, file: dailyFile };
    } catch (e) {
        acc.stats.errorCount++;
        state.stats.errorCount++;
        console.error(`[VCPEigenFlux] Feed归档失败 [${acc.id}]:`, e.message);
        return { archived: false, error: e.message, newItems: 0, totalItems: 0 };
    }
}// ============================================================
// HTTP 客户端（支持代理）
// ============================================================

function makeRequest(accountId, method, apiPath, body = null) {
    const acc = ensureAccountState(accountId);
    const cfg = acc.config;
    return new Promise((resolve, reject) => {
        const baseUrl = (cfg.hubEndpoint || efConfig.hubEndpoint).replace(/\/$/, '');
        const fullUrl = `${baseUrl}/api/v1${apiPath}`;
        const parsed = new URL(fullUrl);

        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'VCPEigenFlux/0.2.0'
        };
        if (cfg.accessToken) {
            headers['Authorization'] = `Bearer ${cfg.accessToken}`;
        }

        let bodyStr = null;
        if (body) {
            bodyStr = JSON.stringify(body);
            headers['Content-Length'] = Buffer.byteLength(bodyStr);
        }

        const useProxy = cfg.proxy && cfg.proxy.length > 0;
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
                acc.stats.errorCount++;
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
            const proxyUrl = new URL(cfg.proxy);
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
                acc.stats.errorCount++;
                reject(new Error(`代理连接失败: ${e.message}`));
            });

            connectReq.setTimeout(15000, () => {
                connectReq.destroy();
                reject(new Error('代理 CONNECT 超时 (15s)'));
            });

            connectReq.end();
        } else if (useProxy && !isHttps) {
            const proxyUrl = new URL(cfg.proxy);
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
                acc.stats.errorCount++;
                reject(e);
            });

            req.setTimeout(30000, () => {
                req.destroy();
                reject(new Error('请求超时 (30s)'));
            });

            if (bodyStr) req.write(bodyStr);
            req.end();
        } else {
            doRequest(null);
        }
    });
}

// ============================================================
// EigenFlux API 封装
// ============================================================

async function feedPoll(accountId, limit, action = 'refresh', cursor = '') {
    const acc = ensureAccountState(accountId);
    const params = new URLSearchParams();
    params.set('limit', String(limit || acc.config.feedLimit || efConfig.feedLimit));
    if (action) params.set('action', action);
    if (cursor) params.set('cursor', cursor);

    const resp = await makeRequest(accountId, 'GET', `/items/feed?${params.toString()}`);
    if (resp.status === 200 && resp.data && resp.data.code === 0) {
        acc.feedCache = resp.data.data?.items || [];
        acc.lastFeedPoll = new Date().toISOString();
        acc.connected = true;
        acc.stats.feedPollCount++;
        acc.lastArchive = archiveFeedItems(accountId, acc.feedCache, { limit, action, cursor });
        saveAccountData(accountId);
    }
    return resp;
}

async function publish(accountId, content, notes = {}) {
    const acc = ensureAccountState(accountId);
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
    const resp = await makeRequest(accountId, 'POST', '/items/publish', body);
    if (resp.status === 200) {
        acc.stats.publishCount++;
        saveAccountData(accountId);
    }
    return resp;
}

async function feedGet(accountId, itemId) {
    return await makeRequest(accountId, 'GET', `/items/${itemId}`);
}

async function feedback(accountId, items) {
    return await makeRequest(accountId, 'POST', '/items/feedback', { items });
}

async function msgSend(accountId, content, opts = {}) {
    const acc = ensureAccountState(accountId);
    const body = { content };
    if (opts.item_id) body.item_id = opts.item_id;
    if (opts.conv_id) body.conv_id = opts.conv_id;
    if (opts.receiver_id) body.receiver_id = opts.receiver_id;
    const resp = await makeRequest(accountId, 'POST', '/pm/send', body);
    if (resp.status === 200) {
        acc.stats.msgSendCount++;
        saveAccountData(accountId);
    }
    return resp;
}

async function msgFetch(accountId, limit = 20) {
    const acc = ensureAccountState(accountId);
    const resp = await makeRequest(accountId, 'GET', `/pm/fetch?limit=${limit}`);
    if (resp.status === 200 && resp.data && resp.data.code === 0) {
        acc.unreadMessages = resp.data.data?.messages || [];
        acc.lastMsgCheck = new Date().toISOString();
        saveAccountData(accountId);
    }
    return resp;
}

async function msgHistory(accountId, convId, limit = 50) {
    return await makeRequest(accountId, 'GET', `/pm/history?conv_id=${convId}&limit=${limit}`);
}

async function msgClose(accountId, convId) {
    return await makeRequest(accountId, 'POST', '/pm/close', { conv_id: convId });
}

async function profileShow(accountId) {
    const acc = ensureAccountState(accountId);
    const resp = await makeRequest(accountId, 'GET', '/agents/me');
    if (resp.status === 200 && resp.data && resp.data.code === 0) {
        acc.profile = resp.data.data;
        acc.connected = true;
        saveAccountData(accountId);
    }
    return resp;
}

async function profileUpdate(accountId, bio) {
    return await makeRequest(accountId, 'PUT', '/agents/profile', { bio });
}

async function relationApply(accountId, email, greeting = '', remark = '') {
    return await makeRequest(accountId, 'POST', '/relations/apply', { to_email: email, greeting, remark });
}

async function relationHandle(accountId, requestId, action, remark = '') {
    return await makeRequest(accountId, 'POST', '/relations/handle', { request_id: requestId, action, remark });
}

async function relationFriends(accountId, limit = 20) {
    return await makeRequest(accountId, 'GET', `/relations/friends?limit=${limit}`);
}

// ============================================================
// 心跳定时器
// ============================================================

function clearAccountHeartbeat(accountId) {
    const acc = ensureAccountState(accountId);
    if (acc.heartbeatTimer) {
        clearInterval(acc.heartbeatTimer);
        acc.heartbeatTimer = null;
    }
}

function startHeartbeatForAccount(accountId) {
    const acc = ensureAccountState(accountId);
    clearAccountHeartbeat(accountId);

    const intervalMin = Math.max(acc.config.heartbeatIntervalMin || efConfig.heartbeatIntervalMin, 5);
    const intervalMs = intervalMin * 60 * 1000;
    const offsetMs = Math.max(parseInt(acc.config.heartbeatOffsetMin) || 0, 0) * 60 * 1000;

    console.log(`[VCPEigenFlux] 心跳启动 [${acc.id}]，间隔 ${intervalMin} 分钟，偏移 ${Math.round(offsetMs / 60000)} 分钟`);

    setTimeout(async () => {
        const token = acc.config.accessToken || (acc.id === DEFAULT_ACCOUNT_ID ? efConfig.accessToken : '');
        if (token) {
            try {
                await profileShow(accountId);
                await runHeartbeat(accountId);
                acc.connected = true;
                console.log(`[VCPEigenFlux] 初始连接成功 [${acc.id}]，Profile: ${acc.profile?.profile?.agent_name || acc.displayName || 'unknown'}`);
            } catch (e) {
                console.error(`[VCPEigenFlux] 初始连接失败 [${acc.id}]:`, e.message);
            }
            // 在初始偏移触发后，再建立持久心跳定时器，实现真正的错峰
            acc.heartbeatTimer = setInterval(async () => {
                await runHeartbeat(accountId);
            }, intervalMs);
        } else {
            console.warn(`[VCPEigenFlux] 账号 ${acc.id} 未配置 accessToken，心跳未激活`);
        }
    }, 5000 + offsetMs);
}

async function runHeartbeat(accountId = DEFAULT_ACCOUNT_ID) {
    const acc = ensureAccountState(accountId);
    try {
        await feedPoll(accountId, acc.config.feedLimit);
        await msgFetch(accountId, 20);
        console.log(`[VCPEigenFlux] 心跳完成 [${acc.id}]: Feed ${acc.feedCache.length} 条, 未读 ${acc.unreadMessages.length} 条`);

        if (state.webSocketServer && (acc.feedCache.length > 0 || acc.unreadMessages.length > 0)) {
            try {
                state.webSocketServer.broadcast(JSON.stringify({
                    type: 'eigenflux_notification',
                    data: {
                        accountId: acc.id,
                        displayName: acc.displayName,
                        feedCount: acc.feedCache.length,
                        unreadCount: acc.unreadMessages.length,
                        timestamp: new Date().toISOString()
                    }
                }));
            } catch (wsErr) {}
        }
    } catch (e) {
        console.error(`[VCPEigenFlux] 心跳错误 [${acc.id}]:`, e.message);
        acc.stats.errorCount++;
        state.stats.errorCount++;
    }
}

function startHeartbeat() {
    const list = Object.values(accountConfigs || {});
    for (const account of list) {
        if (account.enabled !== false) {
            startHeartbeatForAccount(account.id);
        }
    }
}

function stopHeartbeat() {
    for (const acc of Object.values(state.accounts || {})) {
        if (acc && acc.heartbeatTimer) {
            clearInterval(acc.heartbeatTimer);
            acc.heartbeatTimer = null;
        }
    }
    console.log('[VCPEigenFlux] 所有账号心跳已停止');
}

// ============================================================
// 格式化结果
// ============================================================

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
// processToolCall — PluginManager 调用入口
// ============================================================

async function processToolCall(args) {
    const command = args.command || '';
    const accountId = normalizeAccountId(args.account || args.account_id || DEFAULT_ACCOUNT_ID);
    const acc = ensureAccountState(accountId);

    try {
        switch (command) {
            case 'EFPublish': {
                if (!args.content) return formatResult(false, '缺少 content 参数');
                const domains = args.domains ? args.domains.split(',').map(d => d.trim()).filter(Boolean) : [];
                const resp = await publish(accountId, args.content, {
                    type: args.type || 'info',
                    domains,
                    summary: args.summary || '',
                    accept_reply: args.accept_reply !== 'false'
                });
                return formatResult(true, `账号[${accountId}]广播发布成功`, resp.data);
            }

            case 'EFFeed': {
                const resp = await feedPoll(
                    accountId,
                    parseInt(args.limit) || acc.config.feedLimit,
                    args.action || 'refresh',
                    args.cursor || ''
                );
                const items = resp.data?.data?.items || [];
                if (items.length === 0) {
                    return formatResult(true, `账号[${accountId}] Feed 当前为空，可能是尚未匹配到内容，或已全部消费完毕。`);
                }
                let feedText = `## EigenFlux Feed [${accountId}] (${items.length} 条)\n\n`;
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
                        const resp = await msgSend(accountId, args.content, {
                            item_id: args.item_id,
                            conv_id: args.conv_id,
                            receiver_id: args.receiver_id
                        });
                        return formatResult(true, '消息发送成功', resp.data);
                    }
                    case 'fetch': {
                        const resp = await msgFetch(accountId, parseInt(args.limit) || 20);
                        return formatResult(true, '未读消息获取成功', resp.data);
                    }
                    case 'history': {
                        if (!args.conv_id) return formatResult(false, '缺少 conv_id 参数');
                        const resp = await msgHistory(accountId, args.conv_id, parseInt(args.limit) || 50);
                        return formatResult(true, '对话历史获取成功', resp.data);
                    }
                    case 'close': {
                        if (!args.conv_id) return formatResult(false, '缺少 conv_id 参数');
                        const resp = await msgClose(accountId, args.conv_id);
                        return formatResult(true, '对话已关闭', resp.data);
                    }
                    default:
                        return formatResult(false, `未知 action: ${action}`);
                }
            }

            case 'EFFriend': {
                const action = args.action;
                if (!action) return formatResult(false, '缺少 action 参数 (apply/handle/list)');
                switch (action) {
                    case 'apply': {
                        if (!args.email) return formatResult(false, '缺少 email 参数');
                        const resp = await relationApply(accountId, args.email, args.greeting || '', args.remark || '');
                        return formatResult(true, '好友申请已发送', resp.data);
                    }
                    case 'handle': {
                        if (!args.request_id || !args.handle_action) return formatResult(false, '缺少 request_id 或 handle_action');
                        const resp = await relationHandle(accountId, args.request_id, args.handle_action, args.remark || '');
                        return formatResult(true, '好友请求已处理', resp.data);
                    }
                    case 'list': {
                        const resp = await relationFriends(accountId, parseInt(args.limit) || 20);
                        return formatResult(true, '好友列表获取成功', resp.data);
                    }
                    default:
                        return formatResult(false, `未知 action: ${action}`);
                }
            }

            case 'EFProfile': {
                if (args.bio) {
                    const resp = await profileUpdate(accountId, args.bio);
                    return formatResult(true, 'Profile 更新成功', resp.data);
                } else {
                    const resp = await profileShow(accountId);
                    return formatResult(true, 'Profile 信息', resp.data);
                }
            }

            case 'EFStatus': {
                if (args.account) {
                    return formatResult(true, `账号[${accountId}]连接状态`, {
                        accountId: acc.id,
                        displayName: acc.displayName,
                        connected: acc.connected,
                        heartbeatRunning: !!acc.heartbeatTimer,
                        lastFeedPoll: acc.lastFeedPoll,
                        lastMsgCheck: acc.lastMsgCheck,
                        feedCacheCount: acc.feedCache.length,
                        unreadMsgCount: acc.unreadMessages.length,
                        profile: acc.profile?.profile ? {
                            agent_name: acc.profile.profile.agent_name,
                            email: acc.profile.profile.email,
                            agent_id: acc.profile.profile.agent_id
                        } : null,
                        stats: acc.stats,
                        config: {
                            heartbeatIntervalMin: acc.config.heartbeatIntervalMin,
                            heartbeatOffsetMin: acc.config.heartbeatOffsetMin,
                            feedLimit: acc.config.feedLimit,
                            enabled: acc.config.enabled !== false
                        }
                    });
                }

                const summary = Object.values(state.accounts || {}).map(a => ({
                    accountId: a.id,
                    displayName: a.displayName,
                    connected: a.connected,
                    heartbeatRunning: !!a.heartbeatTimer,
                    lastFeedPoll: a.lastFeedPoll,
                    lastMsgCheck: a.lastMsgCheck,
                    feedCacheCount: a.feedCache.length,
                    unreadMsgCount: a.unreadMessages.length,
                    stats: a.stats,
                    enabled: a.config.enabled !== false
                }));

                return formatResult(true, 'EigenFlux 多账号状态', {
                    defaultAccountId: DEFAULT_ACCOUNT_ID,
                    accounts: summary,
                    globalStats: state.stats,
                    hasLegacyConfig: !!efConfig.accessToken
                });
            }

            case 'EFGlobalIndex': {
                const index = writeGlobalAccountIndex() || buildGlobalAccountIndex();
                return formatResult(true, 'EigenFlux 全局轻量索引', index);
            }

            case 'EFAccounts': {
                const list = Object.values(accountConfigs || {}).map(cfg => {
                    const a = ensureAccountState(cfg.id);
                    return {
                        accountId: a.id,
                        displayName: a.displayName,
                        enabled: cfg.enabled !== false,
                        hasToken: !!(cfg.accessToken || (a.id === DEFAULT_ACCOUNT_ID && efConfig.accessToken)),
                        heartbeatIntervalMin: cfg.heartbeatIntervalMin,
                        heartbeatOffsetMin: cfg.heartbeatOffsetMin || 0,
                        feedLimit: cfg.feedLimit,
                        latestFeedFile: a.paths.latestFeedFile,
                        archiveStateFile: a.paths.archiveStateFile
                    };
                });
                return formatResult(true, 'EigenFlux 账号清单', { accounts: list });
            }

            default:
                return formatResult(false, `未知命令: ${command}。支持的命令: EFPublish, EFFeed, EFMessage, EFFriend, EFProfile, EFStatus, EFAccounts`);
        }
    } catch (e) {
        acc.stats.errorCount++;
        state.stats.errorCount++;
        return formatResult(false, `执行出错: ${e.message}`);
    }
}

// ============================================================
// initialize — PluginManager 启动时调用
// ============================================================

function initialize(config) {
    console.log('[VCPEigenFlux] 初始化中...');

    loadConfigFromEnv();
    loadConfigFromPluginEnv(config);
    loadAccountsConfig();

    ensureAccountState(DEFAULT_ACCOUNT_ID);
    loadAccountData(DEFAULT_ACCOUNT_ID);

    for (const id of Object.keys(accountConfigs || {})) {
        ensureAccountState(id);
        if (id !== DEFAULT_ACCOUNT_ID) loadAccountData(id);
    }

    state.startTime = Date.now();
    startHeartbeat();

    writeGlobalAccountIndex();

    console.log(`[VCPEigenFlux] 初始化完成 | Default Hub: ${efConfig.hubEndpoint} | Accounts: ${Object.keys(accountConfigs || {}).length}`);
}

// ============================================================
// registerApiRoutes — PluginManager 注册 HTTP 路由
// ============================================================

function registerApiRoutes(router, config, projectBasePath, wss) {
    if (wss) {
        state.webSocketServer = wss;
        console.log('[VCPEigenFlux] WebSocketServer 已注入');
    }

    router.get('/status', (req, res) => {
        const accountId = normalizeAccountId(req.query.account || DEFAULT_ACCOUNT_ID);
        const acc = ensureAccountState(accountId);

        if (req.query.account) {
            res.json({
                accountId: acc.id,
                displayName: acc.displayName,
                connected: acc.connected,
                heartbeatRunning: !!acc.heartbeatTimer,
                lastFeedPoll: acc.lastFeedPoll,
                lastMsgCheck: acc.lastMsgCheck,
                feedCacheCount: acc.feedCache.length,
                unreadMsgCount: acc.unreadMessages.length,
                profile: acc.profile?.profile ? {
                    agent_name: acc.profile.profile.agent_name,
                    email: acc.profile.profile.email,
                    agent_id: acc.profile.profile.agent_id
                } : null,
                stats: acc.stats,
                config: acc.config
            });
            return;
        }

        res.json({
            defaultAccountId: DEFAULT_ACCOUNT_ID,
            accounts: Object.values(state.accounts || {}).map(a => ({
                accountId: a.id,
                displayName: a.displayName,
                connected: a.connected,
                heartbeatRunning: !!a.heartbeatTimer,
                lastFeedPoll: a.lastFeedPoll,
                lastMsgCheck: a.lastMsgCheck,
                feedCacheCount: a.feedCache.length,
                unreadMsgCount: a.unreadMessages.length,
                stats: a.stats
            })),
            globalStats: state.stats,
            uptime: state.startTime ? `${Math.round((Date.now() - state.startTime) / 60000)} min` : 'N/A'
        });
    });

    router.get('/feed', (req, res) => {
        const accountId = normalizeAccountId(req.query.account || DEFAULT_ACCOUNT_ID);
        const acc = ensureAccountState(accountId);
        const limit = parseInt(req.query.limit) || 20;
        res.json({
            accountId: acc.id,
            items: acc.feedCache.slice(0, limit),
            total: acc.feedCache.length,
            lastPoll: acc.lastFeedPoll
        });
    });

    router.get('/messages', (req, res) => {
        const accountId = normalizeAccountId(req.query.account || DEFAULT_ACCOUNT_ID);
        const acc = ensureAccountState(accountId);
        res.json({
            accountId: acc.id,
            messages: acc.unreadMessages,
            total: acc.unreadMessages.length,
            lastCheck: acc.lastMsgCheck
        });
    });

    router.post('/heartbeat', async (req, res) => {
        try {
            const accountId = normalizeAccountId(req.body?.account || req.query?.account || DEFAULT_ACCOUNT_ID);
            await runHeartbeat(accountId);
            res.json({ success: true, message: `账号[${accountId}]心跳手动触发完成` });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/global-index', (req, res) => {
        const index = writeGlobalAccountIndex() || buildGlobalAccountIndex();
        res.json(index);
    });

    router.get('/accounts', (req, res) => {
        res.json({
            defaultAccountId: DEFAULT_ACCOUNT_ID,
            accounts: Object.values(accountConfigs || {}).map(cfg => {
                const a = ensureAccountState(cfg.id);
                return {
                    accountId: a.id,
                    displayName: a.displayName,
                    enabled: cfg.enabled !== false,
                    hasToken: !!(cfg.accessToken || (a.id === DEFAULT_ACCOUNT_ID && efConfig.accessToken)),
                    heartbeatIntervalMin: cfg.heartbeatIntervalMin,
                    heartbeatOffsetMin: cfg.heartbeatOffsetMin || 0,
                    feedLimit: cfg.feedLimit,
                    latestFeedFile: a.paths.latestFeedFile,
                    archiveStateFile: a.paths.archiveStateFile
                };
            })
        });
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
