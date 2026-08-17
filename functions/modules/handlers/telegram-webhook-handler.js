/**
 * Telegram Bot Webhook 处理模块 v2
 * 用于接收和处理用户通过 Telegram 推送的节点
 * 
 * 支持的命令：
 * /start - 欢迎信息
 * /help - 帮助信息
 * /menu - 快捷菜单
 * /list - 节点列表（带分页）
 * /stats - 统计信息
 * /search - 搜索节点
 * /delete - 删除节点
 * /enable - 启用节点
 * /disable - 禁用节点
 * /rename - 重命名节点
 * /sub - 获取订阅链接
 * /info - 节点详情
 * /copy - 复制节点链接
 * /sort - 节点排序
 * /dup - 去重检测
 * /bind - 绑定订阅组
 * /unbind - 解除绑定
 */

import { StorageFactory } from '../../storage-adapter.js';
import { clearAllNodeCaches } from '../../services/node-cache-service.js';
import { createJsonResponse, createTimeoutFetch, escapeHtml, JSON_BODY_LIMITS, readJsonWithLimit } from '../utils.js';
import { KV_KEY_SUBS, KV_KEY_PROFILES, KV_KEY_SETTINGS } from '../config.js';
import { assertPublicNetworkUrl, redactUrl } from '../security-utils.js';
import { extractValidNodes, parseNodeList } from '../utils/node-parser.js';
import { getRegionEmoji } from '../utils/geo-utils.js';
import { buildSubscriptionNodeCacheKey, isInlineSubscription, isRealProxyNode, isRemoteSubscription, isSubscriptionEntry, parseSubscriptionUserInfoFromContent, parseSubscriptionUserInfoHeader } from '../../services/subscription-service.js';
import { generateClashConfig, urlToClashProxy } from '../../utils/url-to-clash.js';
import { extractClashSourceConfig, normalizeClashSourceConfig } from '../subscription/clash-source-config.js';
const TELEGRAM_SUBSCRIPTION_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TELEGRAM_SUBSCRIPTION_FALLBACK_USER_AGENT = 'clash-verge/v2.4.3';
const TELEGRAM_SUBSCRIPTION_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TELEGRAM_PREVIEW_SESSION_PREFIX = 'tg_subscription_preview:';
const TELEGRAM_PREVIEW_NODE_LIMIT = 50;
const TELEGRAM_SUBSCRIPTION_DETAIL_NODE_LIMIT = 50;
const TELEGRAM_PREVIEW_URL_DISPLAY_LIMIT = 240;
const TELEGRAM_PREVIEW_MESSAGE_LIMIT = 3900;
const TELEGRAM_SUBSCRIPTION_TIMEOUT_MS = 18000;
const TELEGRAM_SUBSCRIPTION_LIST_PAGE_SIZE = 10;
const TELEGRAM_SUBSCRIPTION_EXPIRING_DAYS = 30;
const TELEGRAM_BATCH_SUBSCRIPTION_THRESHOLD = 5;
const TELEGRAM_BATCH_SUBSCRIPTION_CONCURRENCY = 4;
const TELEGRAM_IMPORT_FILE_EXTENSIONS = new Set(['.txt', '.yaml', '.yml', '.conf', '.json']);
const TELEGRAM_COMMAND_MENU = [
    { command: 'start', description: '开始使用 MiSub' },
    { command: 'help', description: '查看帮助' },
    { command: 'list', description: '查看节点和订阅列表' }
];
const telegramCommandMenuState = {
    botToken: null,
    defaultConfigurationPromise: null
};
const TELEGRAM_EXTENSIONLESS_FILE_MIME_TYPES = new Set([
    'text/plain',
    'text/html',
    'text/json',
    'text/yaml',
    'text/x-yaml',
    'application/octet-stream',
    'application/json',
    'application/yaml',
    'application/x-yaml'
]);

// ==================== 存储与配置 ====================

/**
 * 获取存储适配器实例
 */
async function getStorageAdapter(env) {
    const storageType = await StorageFactory.getStorageType(env);
    return StorageFactory.createAdapter(env, storageType);
}

function createRequestCache() {
    return {
        storageAdapter: null,
        settings: undefined,
        subscriptions: undefined,
        profiles: undefined,
        telegramPushConfig: undefined,
        telegramCommandMenuConfigured: false
    };
}

async function getCachedStorageAdapter(env, cache) {
    if (!cache.storageAdapter) {
        cache.storageAdapter = await getStorageAdapter(env);
    }
    return cache.storageAdapter;
}

async function getCachedSettings(env, cache) {
    if (cache.settings !== undefined) return cache.settings;
    const storageAdapter = await getCachedStorageAdapter(env, cache);
    cache.settings = await storageAdapter.get(KV_KEY_SETTINGS) || {};
    return cache.settings;
}

async function getCachedSubscriptions(env, cache) {
    if (cache.subscriptions !== undefined) return cache.subscriptions;
    const storageAdapter = await getCachedStorageAdapter(env, cache);
    cache.subscriptions = await storageAdapter.getAllSubscriptions();
    return cache.subscriptions;
}

async function getCachedProfiles(env, cache) {
    if (cache.profiles !== undefined) return cache.profiles;
    const storageAdapter = await getCachedStorageAdapter(env, cache);
    cache.profiles = await storageAdapter.getAllProfiles();
    return cache.profiles;
}

async function persistCachedSubscriptions(env, cache) {
    if (cache.subscriptions === undefined) return;
    const storageAdapter = await getCachedStorageAdapter(env, cache);
    await storageAdapter.putAllSubscriptions(cache.subscriptions);
}

async function persistCachedProfiles(env, cache) {
    if (cache.profiles === undefined) return;
    const storageAdapter = await getCachedStorageAdapter(env, cache);
    await storageAdapter.putAllProfiles(cache.profiles);
}

async function persistCachedSettings(env, cache) {
    if (cache.settings === undefined) return;
    const storageAdapter = await getCachedStorageAdapter(env, cache);
    await storageAdapter.put(KV_KEY_SETTINGS, cache.settings);
}

/**
 * 获取 Telegram Bot 推送配置
 */
async function getTelegramPushConfig(env, cache = null) {
    let settings;
    if (cache) {
        settings = await getCachedSettings(env, cache);
    } else {
        const storageAdapter = await getStorageAdapter(env);
        settings = await storageAdapter.get(KV_KEY_SETTINGS) || {};
    }
    const config = settings.telegram_push_config || {};
    const allowedUserIds = Array.isArray(config.allowed_user_ids)
        ? config.allowed_user_ids
        : (env.TELEGRAM_PUSH_ALLOWED_USERS?.split(',') || []);

    return {
        enabled: config.enabled ?? true,
        bot_token: config.bot_token || env.TELEGRAM_PUSH_BOT_TOKEN,
        webhook_secret: config.webhook_secret || env.TELEGRAM_PUSH_WEBHOOK_SECRET,
        allowed_user_ids: allowedUserIds
            .map(id => id?.toString().trim())
            .filter(Boolean),
        allow_all_users: config.allow_all_users === true,
        rate_limit: config.rate_limit || {
            max_per_minute: 1000,
            max_per_day: 10000
        },
        default_profile_id: config.default_profile_id || '',
        auto_bind: config.auto_bind ?? true,
        user_bindings: (config.user_bindings && typeof config.user_bindings === 'object')
            ? config.user_bindings
            : {}
    };
}

// ==================== 工具函数 ====================

/**
 * 生成随机ID
 */
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

/**
 * 从节点URL提取名称
 */
function extractNodeName(url) {
    try {
        const hashIndex = url.indexOf('#');
        if (hashIndex !== -1) {
            const encoded = url.substring(hashIndex + 1);
            try {
                return decodeURIComponent(encoded);
            } catch {
                return encoded;
            }
        }
        try {
            const parsedUrl = new URL(url);
            for (const key of ['remarks', 'name', 'ps', 'tag']) {
                const name = parsedUrl.searchParams.get(key)?.trim();
                if (name) return name;
            }
        } catch {}
        const protocol = url.split('://')[0].toUpperCase();
        return `${protocol} 节点`;
    } catch {
        return '未命名节点';
    }
}

/**
 * 提取节点链接（支持多种协议）
 */
function extractNodeUrls(text) {
    const protocols = [
        'ss://', 'ssr://', 'vmess://', 'vless://', 'trojan://',
        'hysteria://', 'hysteria2://', 'hy2://', 'tuic://', 'snell://',
        'anytls://', 'wireguard://', 'socks5://', 'socks5-tls://'
    ];
    const protocolPattern = protocols.map(protocol => protocol.replace('://', ':\\/\\/')).join('|');
    const matches = String(text || '').match(new RegExp(`(?:${protocolPattern})[^\\s<>"']+`, 'gi')) || [];
    const urls = [];

    for (const match of matches) {
        const candidate = match.replace(/[),\]}>，。！？；：]+$/g, '');
        if (!urls.includes(candidate)) urls.push(candidate);
    }

    return urls;
}

/**
 * 提取消息中的 HTTP/HTTPS 链接，允许链接前后带说明文字。
 */
function extractHttpUrls(text) {
    const matches = String(text || '').match(/https?:\/\/[^\s<>"']+/gi) || [];
    const urls = [];

    for (const match of matches) {
        const candidate = match.replace(/[),\]}>，。！？；：]+$/g, '');
        try {
            new URL(candidate);
            if (!urls.includes(candidate)) urls.push(candidate);
        } catch {
            // 忽略无效 URL
        }
    }

    return urls;
}

/**
 * 从 Base64 或明文内容中提取节点链接。
 */
function decodeNodeText(input) {
    const parsedNodes = extractValidNodes(String(input || ''));
    return parsedNodes.length > 0 ? parsedNodes : extractNodeUrls(input);
}

function describeNodeInputFailure(input) {
    const content = String(input || '');
    const trimmed = content.trim();
    if (!trimmed) return '输入内容为空，没有可解析的数据';

    const isStructuredConfig = /(?:^|[\s{,])["']?(?:proxies|proxy|outbounds|servers)["']?\s*:/i.test(trimmed)
        || /^\s*\[(?:Proxy|Server Local|Server Remote)\]\s*$/im.test(trimmed);
    if (isStructuredConfig) {
        return '检测到结构化配置，但 proxies、outbounds 或服务器列表中没有可转换的有效节点';
    }

    const protocolMatches = [...trimmed.matchAll(/\b([a-z][a-z0-9+.-]*):\/\//gi)]
        .map(match => match[1].toLowerCase());
    if (protocolMatches.length > 0) {
        const protocols = [...new Set(protocolMatches)];
        return `检测到 ${protocols.join('、')} 链接，但节点格式校验未通过，可能是 UUID、Base64 编码、端口或协议参数无效`;
    }

    const compact = trimmed.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (compact.length > 20 && /^[A-Za-z0-9+/=]+$/.test(compact)) {
        try {
            let normalized = compact;
            while (normalized.length % 4) normalized += '=';
            const decoded = atob(normalized);
            if (!decoded.trim()) return 'Base64 解码成功，但解码后的内容为空';
            return '内容看起来是 Base64，但解码后没有发现支持的节点链接或配置';
        } catch {
            return '内容看起来是 Base64，但编码不完整或无效';
        }
    }

    return '内容不是受支持的节点链接、Base64 订阅、Clash YAML/JSON 或 sing-box 配置';
}

function formatTelegramFailureReason(error, maxLength = 1200) {
    const rawReason = error?.message || String(error || '未知错误');
    const safeReason = String(rawReason).replace(/https?:\/\/[^\s<>"'）)；;，,]+/gi, value => redactUrl(value));
    return truncateTelegramText(safeReason, maxLength);
}

function buildTelegramParseFailureMessage(title, error) {
    if (error?.code === 'SUBSCRIPTION_HTML_CONTENT') {
        return '❌ 无法解析订阅内容：\n\n' +
            '⚠️ 该链接返回的是网页内容（HTML），不是订阅数据。' +
            '请确认订阅链接是否完整（通常包含 /api/ 或 token= 等参数）。';
    }

    const reason = formatTelegramFailureReason(error);
    return `❌ <b>${escapeHtml(title)}</b>\n\n<b>失败原因:</b> ${escapeHtml(reason)}`;
}

function getBatchSubscriptionStatus(preview) {
    const info = preview?.userInfo || {};
    const expiry = getSubscriptionExpirySummary(info.expire);
    if (expiry.expired) return '过期';

    const total = normalizeTrafficBytes(info.total);
    const used = normalizeTrafficBytes(info.upload) + normalizeTrafficBytes(info.download);
    if (total > 0 && Math.max(0, total - used) <= 0) return '耗尽';
    return '有效';
}

function summarizeBatchSubscriptionResults(results) {
    return results.reduce((summary, result) => {
        summary[result.status] = (summary[result.status] || 0) + 1;
        return summary;
    }, { 有效: 0, 耗尽: 0, 过期: 0, 失效: 0 });
}

async function fetchBatchSubscriptionPreviews(urls) {
    const results = new Array(urls.length);
    let nextIndex = 0;

    const worker = async () => {
        while (true) {
            const index = nextIndex++;
            if (index >= urls.length) return;
            const url = urls[index];
            try {
                const preview = await fetchSubscriptionPreview(url);
                const nodes = parseNodeList((preview.nodeUrls || []).join('\n'));
                if (nodes.length === 0) throw new Error('内容解析阶段失败：未识别到可用节点');
                results[index] = { url, preview, nodes, status: getBatchSubscriptionStatus(preview) };
            } catch (error) {
                results[index] = { url, error, status: '失效' };
            }
        }
    };

    const workerCount = Math.min(TELEGRAM_BATCH_SUBSCRIPTION_CONCURRENCY, urls.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
}

function buildBatchSubscriptionReport(results) {
    const stats = summarizeBatchSubscriptionResults(results);

    const lines = [
        'MiSub 订阅解析结果',
        `链接总数: ${results.length}`,
        `查询统计: 有效: ${stats.有效} | 耗尽: ${stats.耗尽} | 过期: ${stats.过期} | 失效: ${stats.失效}`,
        ''
    ];

    results.forEach((result, index) => {
        lines.push(`========== 第 ${index + 1} 条订阅 ==========`);
        lines.push(`状态: ${result.status}`);
        lines.push(`订阅链接: ${result.url}`);

        if (result.preview) {
            const preview = result.preview;
            const info = preview.userInfo || {};
            const nodes = result.nodes || [];
            const details = getSubscriptionInfoDisplay(info, formatTrafficBytes);

            lines.push(`机场名称: ${preview.name || '未命名订阅'}`);
            lines.push(`节点总数: ${nodes.length}`);
            lines.push(`流量详情: ${details.trafficText}`);
            lines.push(`使用进度: ${details.usagePercent === null ? '未知' : `${details.usagePercent.toFixed(1)}%`}`);
            lines.push(`剩余可用: ${details.remainingText}`);
            lines.push(`过期时间: ${details.expiryText}`);
            lines.push(`剩余时间: ${details.remainingTimeText}`);
            if (Number(info.resetRemainingSeconds || 0) > 0) {
                lines.push(`下次重置: ${formatResetRemainingTime(info.resetRemainingSeconds)}`);
            }
            lines.push('节点列表:');
            if (nodes.length === 0) {
                lines.push('暂无节点');
            } else {
                nodes.forEach((node, nodeIndex) => {
                    lines.push(`${nodeIndex + 1}. ${node.name || extractNodeName(node.url)} | ${node.url}`);
                });
            }
        } else {
            lines.push(`失败原因: ${formatTelegramFailureReason(result.error)}`);
        }

        lines.push('');
    });

    return lines.join('\n');
}

/**
 * 获取并解析远程订阅内容。
 */
function parseAttachmentFilename(headerValue, sourceUrl) {
    const match = String(headerValue || '').match(/filename\*?=(?:UTF-8''|["']?)([^"';]+)/i);
    let filename = match?.[1] || '';
    try { filename = decodeURIComponent(filename); } catch {}
    if (!filename) {
        try { filename = new URL(sourceUrl).hostname; } catch { filename = 'subscription'; }
    }
    return filename.trim();
}

function getSubscriptionDisplayName(filename, sourceUrl) {
    const withoutExtension = String(filename || '').replace(/\.(ya?ml|txt|conf|json)$/i, '').trim();
    if (withoutExtension) return withoutExtension;
    try { return new URL(sourceUrl).hostname; } catch { return '未命名订阅'; }
}

function getInlineSubscriptionName(filename) {
    const name = getSubscriptionDisplayName(filename, '');
    return name === '未命名订阅' ? 'Telegram 多节点订阅' : name;
}

function getSubscriptionUrlHostname(url) {
    try { return new URL(url).hostname.trim(); } catch { return ''; }
}

function shouldUpdateStoredSubscriptionName(subscription) {
    const name = String(subscription?.name || '').trim();
    if (!name || ['未命名订阅', 'subscription'].includes(name.toLowerCase())) return true;

    const hostname = getSubscriptionUrlHostname(subscription?.url);
    if (!hostname) return false;
    return name.toLowerCase() === hostname.toLowerCase()
        || name.toLowerCase() === `订阅源 ${hostname}`.toLowerCase();
}

function updateStoredSubscriptionName(subscription, parsedName) {
    const name = String(parsedName || '').trim();
    if (!name || !shouldUpdateStoredSubscriptionName(subscription)) return false;
    if (String(subscription.name || '').trim() === name) return false;
    subscription.name = name;
    return true;
}

function decodeTextBytes(bytes) {
    const content = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) {
        return new TextDecoder('utf-16le').decode(content);
    }
    if (content.length >= 2 && content[0] === 0xfe && content[1] === 0xff) {
        return new TextDecoder('utf-16be').decode(content);
    }
    return new TextDecoder('utf-8').decode(content);
}

async function readSubscriptionResponseText(response, contentLabel = '订阅内容') {
    const maxBytes = JSON_BODY_LIMITS.large;
    const contentLength = Number(response.headers.get('Content-Length') || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new Error(`${contentLabel}超过 5 MB 限制`);
    }

    if (!response.body?.getReader) {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > maxBytes) throw new Error(`${contentLabel}超过 5 MB 限制`);
        return decodeTextBytes(buffer);
    }

    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new Error(`${contentLabel}超过 5 MB 限制`);
        }
        chunks.push(value);
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return decodeTextBytes(bytes);
}

function validateTelegramImportDocument(document) {
    const filename = String(document?.file_name || '').trim();
    const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')).toLowerCase() : '';
    const mimeType = String(document?.mime_type || '').split(';')[0].trim().toLowerCase();
    const isSupportedExtensionlessFile = !extension && TELEGRAM_EXTENSIONLESS_FILE_MIME_TYPES.has(mimeType);
    if (!TELEGRAM_IMPORT_FILE_EXTENSIONS.has(extension) && !isSupportedExtensionlessFile) {
        throw new Error('仅支持 TXT、YAML、YML、CONF、JSON 或无扩展名的订阅文件');
    }

    const fileSize = Number(document?.file_size || 0);
    if (Number.isFinite(fileSize) && fileSize > JSON_BODY_LIMITS.large) {
        throw new Error('文件超过 5 MB 限制');
    }
    if (!document?.file_id) throw new Error('文件标识无效');
    return filename;
}

function prepareTelegramDocumentInput(text) {
    const content = String(text || '');
    const parsedNodes = extractValidNodes(content);
    const embeddedNodeUrls = extractNodeUrls(content);
    const isStructuredConfig = /(?:^|[\s{,])["']?(?:proxies|proxy|outbounds|proxy-groups|proxy-providers|rule-providers|rules|route|dns|inbounds|log|experimental)["']?\s*:/i.test(content)
        || /^\s*\[(?:Proxy|Proxy Group|General|Server Local|Server Remote|Filter Remote|Rewrite Remote|DNS)\]\s*$/im.test(content)
        || parsedNodes.some(nodeUrl => !embeddedNodeUrls.includes(nodeUrl));

    return isStructuredConfig ? parsedNodes.join('\n') : content;
}

function normalizeTelegramFilePath(value) {
    const filePath = String(value || '').trim();
    const segments = filePath.split('/');
    if (
        !filePath ||
        filePath.length > 1024 ||
        segments.some(segment => !segment || segment === '.' || segment === '..' || !/^[a-zA-Z0-9_.-]+$/.test(segment))
    ) {
        throw new Error('Telegram 文件路径无效');
    }
    return segments.map(encodeURIComponent).join('/');
}

async function fetchTelegramDocumentText(document, env, requestCache = null) {
    validateTelegramImportDocument(document);
    const config = await getTelegramPushConfig(env, requestCache);
    if (!config.bot_token) throw new Error('Bot token 未配置');

    const fileInfoResponse = await createTimeoutFetch(
        `https://api.telegram.org/bot${config.bot_token}/getFile`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_id: document.file_id })
        },
        TELEGRAM_SUBSCRIPTION_TIMEOUT_MS
    );
    if (!fileInfoResponse.ok) throw new Error(`无法获取 Telegram 文件信息: HTTP ${fileInfoResponse.status}`);

    let fileInfo;
    try {
        fileInfo = await fileInfoResponse.json();
    } catch {
        throw new Error('Telegram 文件信息响应无效');
    }
    if (!fileInfo?.ok) throw new Error('无法获取 Telegram 文件信息');
    const remoteFileSize = Number(fileInfo?.result?.file_size || 0);
    if (Number.isFinite(remoteFileSize) && remoteFileSize > JSON_BODY_LIMITS.large) {
        throw new Error('文件超过 5 MB 限制');
    }

    const encodedPath = normalizeTelegramFilePath(fileInfo?.result?.file_path);
    const fileResponse = await createTimeoutFetch(
        `https://api.telegram.org/file/bot${config.bot_token}/${encodedPath}`,
        { method: 'GET' },
        TELEGRAM_SUBSCRIPTION_TIMEOUT_MS
    );
    if (!fileResponse.ok) throw new Error(`Telegram 文件下载失败: HTTP ${fileResponse.status}`);
    return readSubscriptionResponseText(fileResponse, '文件');
}

function getUrlHostname(url) {
    try { return new URL(url).hostname || '上游服务器'; } catch { return '上游服务器'; }
}

function createSubscriptionHttpError(response, url) {
    const statusText = String(response?.statusText || '').trim();
    const suffix = statusText ? ` ${statusText}` : '';
    return new Error(`下载阶段失败：${getUrlHostname(url)} 返回 HTTP ${response?.status}${suffix}`);
}

function createSubscriptionContentError(content, response, url) {
    const text = String(content || '');
    if (!text.trim()) {
        return new Error(`内容解析阶段失败：${getUrlHostname(url)} 返回了空订阅内容`);
    }
    const contentTypeHeader = String(response?.headers?.get('Content-Type') || '');
    const contentType = contentTypeHeader.split(';')[0].trim() || '未知';
    const looksLikeHtml = /^(?:text\/html|application\/xhtml\+xml)$/i.test(contentType)
        || /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(text);
    if (looksLikeHtml) {
        const error = new Error('该链接返回的是网页内容（HTML），不是订阅数据');
        error.code = 'SUBSCRIPTION_HTML_CONTENT';
        return error;
    }

    return new Error(
        `内容解析阶段失败：下载成功，但未识别到支持的节点格式` +
        `（Content-Type: ${contentType}，内容长度: ${text.length} 字符）`
    );
}

function extractEmbeddedSubscriptionUrl(converterUrl) {
    const parsed = new URL(converterUrl);
    const embedded = String(parsed.searchParams.get('url') || '').trim();
    if (!/^https?:\/\//i.test(embedded)) return '';
    const validated = assertPublicNetworkUrl(embedded).toString();
    return validated === parsed.toString() ? '' : validated;
}

async function cancelResponseBody(response) {
    try {
        await response?.body?.cancel();
    } catch {}
}

async function fetchSubscriptionPreview(url, options = {}) {
    const maxRedirects = 3;
    const sourceUrl = options.sourceUrl || url;
    const allowEmbeddedFallback = options.allowEmbeddedFallback !== false;
    const redirectHistory = [];
    let currentUrl;
    try {
        currentUrl = assertPublicNetworkUrl(url).toString();
    } catch (error) {
        throw new Error(`地址校验阶段失败：订阅地址无效或不安全（${error.message}）`);
    }
    let userAgent = String(options.userAgent || '').trim() || TELEGRAM_SUBSCRIPTION_USER_AGENT;
    const fallbackUserAgent = userAgent.toLowerCase() === TELEGRAM_SUBSCRIPTION_FALLBACK_USER_AGENT
        ? ''
        : TELEGRAM_SUBSCRIPTION_FALLBACK_USER_AGENT;
    let usedFallbackUserAgent = false;

    const tryEmbeddedFallback = async primaryError => {
        if (!allowEmbeddedFallback) throw primaryError;

        let fallbackUrl = '';
        for (let index = redirectHistory.length - 1; index >= 0; index--) {
            try {
                fallbackUrl = extractEmbeddedSubscriptionUrl(redirectHistory[index]);
            } catch (error) {
                throw new Error(`${primaryError.message}；原始订阅回退被拒绝：${error.message}`);
            }
            if (fallbackUrl) break;
        }
        if (!fallbackUrl) throw primaryError;

        try {
            const fallbackPreview = await fetchSubscriptionPreview(fallbackUrl, {
                userAgent,
                sourceUrl,
                allowEmbeddedFallback: false
            });
            return {
                ...fallbackPreview,
                sourceUrl
            };
        } catch (error) {
            throw new Error(`${primaryError.message}；原始订阅回退失败：${error.message}`);
        }
    };

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
        redirectHistory.push(currentUrl);
        let response;
        try {
            response = await createTimeoutFetch(currentUrl, {
                method: 'GET',
                redirect: 'manual',
                headers: {
                    'User-Agent': userAgent,
                    'Accept': '*/*'
                }
            }, TELEGRAM_SUBSCRIPTION_TIMEOUT_MS);
        } catch (error) {
            const reason = error?.name === 'AbortError'
                ? `下载阶段失败：连接 ${getUrlHostname(currentUrl)} 超时`
                : `下载阶段失败：无法连接 ${getUrlHostname(currentUrl)}（${error?.message || '网络错误'}）`;
            return await tryEmbeddedFallback(new Error(reason));
        }

        if (
            ([401, 403].includes(response.status) || TELEGRAM_SUBSCRIPTION_REDIRECT_STATUSES.has(response.status))
            && fallbackUserAgent
            && userAgent.toLowerCase() !== fallbackUserAgent
        ) {
            try {
                const fallbackResponse = await createTimeoutFetch(currentUrl, {
                    method: 'GET',
                    redirect: 'manual',
                    headers: {
                        'User-Agent': fallbackUserAgent,
                        'Accept': '*/*'
                    }
                }, TELEGRAM_SUBSCRIPTION_TIMEOUT_MS);
                if (fallbackResponse.ok || TELEGRAM_SUBSCRIPTION_REDIRECT_STATUSES.has(fallbackResponse.status)) {
                    await cancelResponseBody(response);
                    response = fallbackResponse;
                    userAgent = fallbackUserAgent;
                    usedFallbackUserAgent = true;
                } else {
                    await cancelResponseBody(fallbackResponse);
                }
            } catch (error) {
                if (error?.name === 'AbortError') {
                    return await tryEmbeddedFallback(
                        new Error(`下载阶段失败：连接 ${getUrlHostname(currentUrl)} 超时`)
                    );
                }
            }
        }

        if (TELEGRAM_SUBSCRIPTION_REDIRECT_STATUSES.has(response.status)) {
            const location = response.headers.get('Location');
            if (!location) {
                await cancelResponseBody(response);
                throw new Error(`跳转阶段失败：HTTP ${response.status} 响应缺少 Location`);
            }
            if (redirectCount >= maxRedirects) {
                await cancelResponseBody(response);
                throw new Error('跳转阶段失败：订阅重定向次数超过 3 次');
            }
            try {
                currentUrl = assertPublicNetworkUrl(new URL(location, currentUrl).toString()).toString();
            } catch (error) {
                await cancelResponseBody(response);
                throw new Error(`跳转阶段失败：重定向地址无效或不安全（${error.message}）`);
            }
            await cancelResponseBody(response);
            continue;
        }

        if (!response.ok) {
            const httpError = createSubscriptionHttpError(response, currentUrl);
            await cancelResponseBody(response);
            return await tryEmbeddedFallback(httpError);
        }

        let content;
        try {
            content = await readSubscriptionResponseText(response);
        } catch (error) {
            return await tryEmbeddedFallback(
                new Error(`内容读取阶段失败：${getUrlHostname(currentUrl)}（${error.message}）`)
            );
        }

        const nodeUrls = decodeNodeText(content);
        if (nodeUrls.length === 0) {
            return await tryEmbeddedFallback(createSubscriptionContentError(content, response, currentUrl));
        }
        const filename = parseAttachmentFilename(response.headers.get('Content-Disposition'), currentUrl);
        return {
            sourceUrl,
            finalUrl: currentUrl,
            filename,
            name: getSubscriptionDisplayName(filename, currentUrl),
            nodeUrls,
            sourceClashConfig: extractClashSourceConfig(content),
            userInfo: parseSubscriptionUserInfoHeader(response.headers.get('subscription-userinfo'))
                || parseSubscriptionUserInfoFromContent(content),
            userAgent,
            usedFallbackUserAgent,
            fetchedAt: Date.now()
        };
    }

    throw new Error('跳转阶段失败：订阅重定向次数超过 3 次');
}

async function fetchSubscriptionNodeUrls(url) {
    return (await fetchSubscriptionPreview(url)).nodeUrls;
}
/**
 * 统一解析 Telegram 普通消息和 /import 输入。
 */
async function resolveTelegramNodeInput(text) {
    const directNodeUrls = extractNodeUrls(text);
    const httpUrls = extractHttpUrls(text);

    if (httpUrls.length === 0) {
        return directNodeUrls.length > 0 ? directNodeUrls : decodeNodeText(text);
    }

    const nodeUrls = [...directNodeUrls];
    for (const url of httpUrls) {
        nodeUrls.push(...await fetchSubscriptionNodeUrls(url));
    }

    return nodeUrls;
}

function formatTrafficBytes(value) {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes < 0) return '未知';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    const digits = unitIndex >= 3 ? 2 : (unitIndex === 0 ? 0 : 1);
    return `${Number(size.toFixed(digits))}${units[unitIndex]}`;
}

function normalizeTrafficBytes(value) {
    const bytes = Number(value || 0);
    return Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
}

function buildUsageProgress(percent) {
    const clamped = Math.max(0, Math.min(100, Number(percent || 0)));
    const filled = Math.round(clamped / 10);
    return `${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}`;
}

function truncateTelegramText(value, maxLength = 80) {
    const text = String(value || '');
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
function formatExpiryDate(expireSeconds) {
    const timestamp = Number(expireSeconds || 0) * 1000;
    const date = new Date(timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0 || !Number.isFinite(date.getTime())) return '未知';
    return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date).replace(/\//g, '-');
}

function formatRemainingTime(expireSeconds) {
    const expire = Number(expireSeconds || 0);
    if (!Number.isFinite(expire) || expire <= 0) return '未知';
    const remainingMs = expire * 1000 - Date.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return '已到期';
    const totalHours = Math.floor(remainingMs / 3600000);
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    const minutes = Math.floor((remainingMs % 3600000) / 60000);
    return `${days}天${hours}小时${minutes}分钟`;
}

function formatResetRemainingTime(seconds) {
    const totalMinutes = Math.floor(Number(seconds || 0) / 60);
    if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return '未知';
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0 && hours === 0 && minutes === 0) return `${days}天`;
    if (days > 0) return `${days}天${hours}小时${minutes}分钟`;
    if (hours > 0 && minutes === 0) return `${hours}小时`;
    if (hours > 0) return `${hours}小时${minutes}分钟`;
    return `${minutes}分钟`;
}

function hasSubscriptionInfo(info) {
    return normalizeTrafficBytes(info?.total) > 0
        || Number(info?.expire || 0) > 0
        || Number(info?.resetRemainingSeconds || 0) > 0
        || info?.source === 'content';
}

function getSubscriptionTrafficDisplay(info, format = formatTrafficBytes) {
    const upload = normalizeTrafficBytes(info?.upload);
    const download = normalizeTrafficBytes(info?.download);
    const total = normalizeTrafficBytes(info?.total);
    const used = upload + download;
    const remaining = Math.max(0, total - used);
    const remainingOnly = info?.trafficIsRemaining === true;

    return {
        total,
        used,
        remaining,
        usagePercent: total > 0 && !remainingOnly ? Math.min(100, (used / total) * 100) : null,
        trafficText: remainingOnly
            ? `剩余 ${format(remaining)}`
            : `${format(used)} / ${format(total)}`,
        remainingText: format(remaining)
    };
}

function getSubscriptionInfoDisplay(info, format = formatTrafficBytes) {
    const traffic = getSubscriptionTrafficDisplay(info, format);
    const hasTraffic = normalizeTrafficBytes(info?.upload) > 0
        || normalizeTrafficBytes(info?.download) > 0
        || normalizeTrafficBytes(info?.total) > 0
        || info?.trafficIsRemaining === true;
    const expire = Number(info?.expire || 0);
    const hasExpiry = Number.isFinite(expire) && expire > 0;

    return {
        hasTraffic,
        trafficText: hasTraffic ? traffic.trafficText : '未知',
        usagePercent: hasTraffic ? traffic.usagePercent : null,
        remainingText: hasTraffic ? traffic.remainingText : '未知',
        expiryText: hasExpiry ? formatExpiryDate(expire) : '长期有效',
        remainingTimeText: hasExpiry ? formatRemainingTime(expire) : '长期有效'
    };
}

function formatSubscriptionListTraffic(value) {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    return unitIndex === 0 ? `${Math.round(size)} B` : `${size.toFixed(2)} ${units[unitIndex]}`;
}

function getSubscriptionExpirySummary(expireSeconds) {
    const expire = Number(expireSeconds || 0);
    if (!Number.isFinite(expire) || expire <= 0) return { text: '长期有效', expiring: false, expired: false };

    const expireDate = new Date(expire * 1000);
    if (!Number.isFinite(expireDate.getTime())) return { text: '长期有效', expiring: false, expired: false };
    if (expireDate.getUTCFullYear() >= 2099) return { text: '长期有效', expiring: false, expired: false };

    const remainingMs = expire * 1000 - Date.now();
    if (remainingMs <= 0) return { text: '已到期', expiring: false, expired: true };

    const days = Math.ceil(remainingMs / 86400000);
    return {
        text: `${days}天`,
        expiring: days <= TELEGRAM_SUBSCRIPTION_EXPIRING_DAYS,
        expired: false
    };
}

function getSubscriptionListSummary(subscription) {
    const info = subscription?.userInfo || {};
    const total = normalizeTrafficBytes(info.total);
    const used = normalizeTrafficBytes(info.upload) + normalizeTrafficBytes(info.download);
    const remaining = Math.max(0, total - used);
    const expiry = getSubscriptionExpirySummary(info.expire);
    const depleted = total > 0 && remaining <= 0;

    let status = '🟢';
    if (subscription?.enabled === false) status = '🟠';
    else if (expiry.expired) status = '🔴';
    else if (expiry.expiring || depleted) status = '🟠';

    return {
        status,
        traffic: formatSubscriptionListTraffic(remaining),
        expiry: expiry.text,
        expiring: expiry.expiring
    };
}

function getPreviewSessionKey(sessionId) {
    return `${TELEGRAM_PREVIEW_SESSION_PREFIX}${sessionId}`;
}

async function persistPreviewSession(env, storageAdapter, session) {
    const serialized = JSON.stringify(session);
    if (env?.MISUB_KV?.put) {
        await env.MISUB_KV.put(getPreviewSessionKey(session.id), serialized);
        return;
    }
    await storageAdapter.put(getPreviewSessionKey(session.id), session);
}

async function readPreviewSession(env, storageAdapter, sessionId, userId) {
    let session;
    if (env?.MISUB_KV?.get) {
        const raw = await env.MISUB_KV.get(getPreviewSessionKey(sessionId));
        session = raw ? JSON.parse(raw) : null;
    } else {
        session = await storageAdapter.get(getPreviewSessionKey(sessionId));
    }
    if (!session || String(session.userId) !== String(userId)) return null;
    return session;
}

function createPreviewSession(preview, userId, sessionId = generateId()) {
    const nodes = parseNodeList(preview.nodeUrls.join('\n'));
    return {
        id: sessionId,
        userId,
        sourceUrl: preview.sourceUrl,
        finalUrl: preview.finalUrl,
        filename: preview.filename,
        name: preview.name,
        nodeUrls: nodes.map(node => node.url),
        sourceClashConfig: normalizeClashSourceConfig(preview.sourceClashConfig),
        userInfo: preview.userInfo || null,
        userAgent: preview.userAgent || TELEGRAM_SUBSCRIPTION_USER_AGENT,
        usedFallbackUserAgent: preview.usedFallbackUserAgent === true,
        fetchedAt: preview.fetchedAt,
        savedSubscriptionId: null
    };
}

function createInlinePreviewSession(subscription, userId, filename = '') {
    return {
        id: generateId(),
        userId,
        sourceType: 'inline',
        sourceUrl: subscription.url,
        filename: String(filename || '').trim() || `${subscription.name}.txt`,
        name: subscription.name,
        nodeUrls: normalizeStoredNodeUrls(subscription.nodeUrls),
        sourceClashConfig: normalizeClashSourceConfig(subscription.sourceClashConfig),
        userInfo: subscription.userInfo || null,
        fetchedAt: Date.parse(subscription.lastUpdate || '') || Date.now(),
        savedSubscriptionId: subscription.id
    };
}

function createNodePreviewSession(nodeUrl, userId, savedNode = null, sessionId = generateId()) {
    const node = parseNodeList(String(nodeUrl || ''))[0];
    if (!node) throw new Error('未识别到有效的节点');
    return {
        id: sessionId,
        userId,
        sourceType: 'node',
        sourceUrl: node.url,
        filename: `${node.name || 'node'}.txt`,
        name: node.name || extractNodeName(node.url),
        nodeUrls: [node.url],
        userInfo: null,
        fetchedAt: Date.now(),
        savedSubscriptionId: savedNode?.id || null
    };
}

function getPreviewNodes(session) {
    return parseNodeList((session.nodeUrls || []).join('\n'));
}

function buildSubscriptionPreviewCard(session) {
    const nodes = getPreviewNodes(session);
    const protocols = [...new Set(nodes.map(node => node.protocol).filter(Boolean))];
    const regions = [...new Set(nodes.map(node => node.region).filter(region => region && region !== '其他'))];
    const info = session.userInfo || {};
    const details = getSubscriptionInfoDisplay(info);
    const expire = Number(info.expire || 0);
    const status = Number.isFinite(expire) && expire > 0 && expire * 1000 <= Date.now()
        ? '🔴 已到期'
        : '🟢 正常';
    const regionText = regions.slice(0, 10).map(region => `${getRegionEmoji(region)}${region}`).join(',') || '未识别';

    const displayName = truncateTelegramText(session.name, 100);
    const isInline = session.sourceType === 'inline' || String(session.sourceUrl || '').startsWith('inline:');
    const displayUrl = isInline
        ? `本地文件 · ${truncateTelegramText(session.filename || session.name, TELEGRAM_PREVIEW_URL_DISPLAY_LIMIT)}`
        : session.sourceUrl;
    const sourceLink = `<code>${escapeHtml(displayUrl)}</code>`;

    let message = `📋 机场名称: <code>${escapeHtml(displayName)}</code>\n`;
    message += `🔗 订阅链接: ${sourceLink}\n`;
    message += `<blockquote>📊 流量详情: ${escapeHtml(details.trafficText)}`;
    if (details.hasTraffic) {
        const progressText = details.usagePercent === null
            ? '未知'
            : `${buildUsageProgress(details.usagePercent)} ${details.usagePercent.toFixed(1)}%`;
        message += ` ${status}\n`;
        message += `📈 使用进度: ${progressText}\n`;
        message += `💵 剩余可用: ${escapeHtml(details.remainingText)}\n`;
        message += `🗓️ 过期时间: ${details.expiryText}\n`;
        message += `⌛ 剩余时间: ${details.remainingTimeText}`;
        if (Number(info.resetRemainingSeconds || 0) > 0) {
            message += `\n🔄 下次重置: ${formatResetRemainingTime(info.resetRemainingSeconds)}`;
        }
    } else {
        message += `\n🗓️ 过期时间: ${details.expiryText}`;
    }
    message += '</blockquote>\n';
    message += `<blockquote>🔌 协议类型: ${escapeHtml(protocols.join('、') || '未识别')}\n`;
    message += `📊 节点总数: ${nodes.length} | 国家/地区数: ${regions.length}\n`;
    message += `🏳️ 节点范围: ${escapeHtml(regionText)}</blockquote>\n`;

    const blockStart = `<blockquote expandable>📑 节点列表 (共 ${nodes.length} 个)\n`;
    const blockEnd = '</blockquote>';
    const nodeLines = [];
    for (const node of nodes.slice(0, TELEGRAM_PREVIEW_NODE_LIMIT)) {
        const flag = getRegionEmoji(node.region) || '🌐';
        const line = `- ${flag} ${escapeHtml(node.protocol || '未知')}: ${escapeHtml(truncateTelegramText(node.name || '未命名节点'))}`;
        const candidate = `${message}${blockStart}${[...nodeLines, line].join('\n')}${blockEnd}`;
        if (candidate.length > TELEGRAM_PREVIEW_MESSAGE_LIMIT) break;
        nodeLines.push(line);
    }

    if (nodes.length > nodeLines.length) {
        while (nodeLines.length > 0) {
            const hiddenCount = nodes.length - nodeLines.length;
            const summary = `- …等 (${hiddenCount} 个更多节点未显示)`;
            const candidate = `${message}${blockStart}${[...nodeLines, summary].join('\n')}${blockEnd}`;
            if (candidate.length <= TELEGRAM_PREVIEW_MESSAGE_LIMIT) {
                nodeLines.push(summary);
                break;
            }
            nodeLines.pop();
        }

        if (nodeLines.length === 0) {
            nodeLines.push(`- …等 (${nodes.length} 个更多节点未显示)`);
        }
    }
    if (nodeLines.length === 0) nodeLines.push('- 节点名称过长，请使用“显示全部节点”查看');

    message += `${blockStart}${nodeLines.join('\n')}${blockEnd}`;
    return message;
}

function formatNodePreviewValue(value) {
    if (Array.isArray(value)) return value.join(', ');
    if (value && typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function buildNodePreviewCard(session) {
    const node = getPreviewNodes(session)[0];
    const proxy = urlToClashProxy(node?.url || session.sourceUrl) || {};
    const fields = [
        ['name', proxy.name || node?.name || session.name],
        ['server', proxy.server || node?.server],
        ['port', proxy.port || node?.port],
        ['type', proxy.type || node?.protocol],
        ['uuid', proxy.uuid],
        ['password', proxy.password],
        ['cipher', proxy.cipher],
        ['alter-id', proxy.alterId ?? proxy['alter-id']],
        ['tls', proxy.tls],
        ['network', proxy.network || 'tcp']
    ].filter(([, value]) => value !== undefined && value !== null && value !== '');
    const detailLines = fields.map(([key, value], index) => {
        const prefix = index === 0 ? '- ' : '  ';
        return `${prefix}${key}: ${escapeHtml(truncateTelegramText(formatNodePreviewValue(value), 700))}`;
    });

    let message = `📋 <b>机场名称:</b> <code>${escapeHtml(truncateTelegramText(session.name || '未命名节点', 120))}</code>\n`;
    message += '🔗 <b>来源类型:</b> 节点链接\n';
    message += '<blockquote>📊 <b>流量详情:</b> 未知\n';
    message += '🗓️ <b>过期时间:</b> 长期有效</blockquote>\n';
    const visibleLines = [];
    for (const line of detailLines) {
        const candidate = `${message}<blockquote expandable>${[...visibleLines, line].join('\n')}</blockquote>`;
        if (candidate.length > TELEGRAM_PREVIEW_MESSAGE_LIMIT) break;
        visibleLines.push(line);
    }
    message += `<blockquote expandable>${visibleLines.join('\n')}</blockquote>`;
    return message;
}

function buildPreviewCard(session) {
    return session?.sourceType === 'node'
        ? buildNodePreviewCard(session)
        : buildSubscriptionPreviewCard(session);
}

function buildSubscriptionPreviewKeyboard(session) {
    const exportIcon = session?.sourceType === 'node' ? '📥' : '📤';
    return {
        inline_keyboard: [
            [
                { text: '🔄 刷新订阅信息', callback_data: `sp_refresh_${session.id}` },
                { text: '📄 显示全部节点', callback_data: `sp_all_${session.id}` }
            ],
            [
                { text: `${exportIcon} 导出Base64`, callback_data: `sp_b64_${session.id}` },
                { text: `${exportIcon} 导出YAML`, callback_data: `sp_yaml_${session.id}` }
            ],
            [
                { text: '🔗 生成短链', callback_data: `sp_link_${session.id}` },
                { text: session.savedSubscriptionId ? '✅ 已保存订阅' : '💾 保存订阅', callback_data: `sp_save_${session.id}` }
            ]
        ]
    };
}

function buildStoredSubscriptionDetailCard(session) {
    const nodes = getPreviewNodes(session);
    const nodeCount = Math.max(nodes.length, Number(session.storedNodeCount || 0));
    const info = session.userInfo || {};
    const details = getSubscriptionInfoDisplay(info, formatSubscriptionListTraffic);
    const sourceUrl = session.isRemote
        ? truncateTelegramText(session.sourceUrl, 360)
        : '本地内嵌订阅';
    const name = truncateTelegramText(session.name || '未命名订阅', 120);

    let message = `<b>编号:</b> #${Number(session.subscriptionIndex || 0) + 1}\n`;
    message += `<b>配置名称:</b> <code>${escapeHtml(name)}</code>\n`;
    message += `<b>订阅来源:</b>\n<code>${escapeHtml(sourceUrl)}</code>\n`;

    const progressText = details.usagePercent === null
        ? '未知'
        : `${buildUsageProgress(details.usagePercent)} ${details.usagePercent.toFixed(1)}%`;
    message += `<blockquote><b>流量详情:</b> ${escapeHtml(details.trafficText)}\n`;
    message += `<b>使用进度:</b> ${progressText}\n`;
    message += `<b>剩余可用:</b> ${escapeHtml(details.remainingText)}\n`;
    message += `<b>🗓️ 过期时间:</b> ${details.expiryText}\n`;
    message += `<b>剩余时间:</b> ${details.remainingTimeText}`;
    if (Number(info.resetRemainingSeconds || 0) > 0) {
        message += `\n<b>下次重置:</b> ${formatResetRemainingTime(info.resetRemainingSeconds)}`;
    }
    message += '</blockquote>\n';

    let nodeLines = nodes.slice(0, TELEGRAM_SUBSCRIPTION_DETAIL_NODE_LIMIT).map((node, index) => (
        `${index + 1}. [${escapeHtml(String(node.protocol || '未知').toUpperCase())}] ${escapeHtml(truncateTelegramText(node.name || '未命名节点', 100))}`
    ));

    if (nodeLines.length === 0) {
        const emptyText = nodeCount > 0
            ? '暂无已缓存节点明细，请点击“刷新订阅”更新'
            : '暂无已存储节点，请点击“刷新订阅”更新';
        return `${message}<blockquote expandable>🔌 节点列表（共${nodeCount}个）\n${emptyText}</blockquote>`;
    }

    while (nodeLines.length > 0) {
        const limited = nodeLines.length < nodeCount ? `，仅显示前${nodeLines.length}个` : '';
        const nodeBlock = `<blockquote expandable>🔌 节点列表（共${nodeCount}个${limited}）\n${nodeLines.join('\n')}</blockquote>`;
        if (`${message}${nodeBlock}`.length <= TELEGRAM_PREVIEW_MESSAGE_LIMIT) {
            return `${message}${nodeBlock}`;
        }
        nodeLines.pop();
    }

    return `${message}<blockquote expandable>🔌 节点列表（共${nodeCount}个）\n节点名称过长，请使用“导出节点”查看</blockquote>`;
}

function buildStoredSubscriptionDetailKeyboard(session) {
    const copyableName = truncateTelegramText(session.name || '未命名订阅', 120);
    const firstRow = session.isRemote
        ? [
            { text: '🔄 刷新订阅', callback_data: `sd_refresh_${session.id}` },
            { text: '🗑️ 删除订阅', callback_data: `sd_delete_${session.id}` }
        ]
        : [{ text: '🗑️ 删除订阅', callback_data: `sd_delete_${session.id}` }];
    return {
        inline_keyboard: [
            firstRow,
            [
                { text: '📋 复制配置名称', copy_text: { text: copyableName } }
            ],
            [
                { text: '📦 导出节点', callback_data: `sd_export_${session.id}` },
                { text: '🔗 生成短链', callback_data: `sd_link_${session.id}` }
            ],
            [
                { text: '⬅️ 返回列表', callback_data: `sd_back_${session.id}` },
                { text: '🏠 主菜单', callback_data: 'cmd_menu' }
            ]
        ]
    };
}

async function resolveTelegramSubscriptionSelection(userId, rawIndex, env, cache) {
    const subscriptions = await getCachedSubscriptions(env, cache);
    const config = await getTelegramPushConfig(env, cache);
    const permission = checkUserPermission(userId, config);
    const visibleItems = permission.allowed
        ? subscriptions
        : subscriptions.filter(item => item.source === 'telegram' && item.telegram_user_id === userId);
    const visibleSubscriptions = visibleItems.filter(isSubscriptionEntry);

    // Compatibility for list buttons emitted before the callback format was versioned.
    if (rawIndex >= 0 && rawIndex < visibleSubscriptions.length) {
        return { subscription: visibleSubscriptions[rawIndex], index: rawIndex };
    }

    const legacyItem = visibleItems[rawIndex];
    if (!legacyItem || !isSubscriptionEntry(legacyItem)) return null;
    const index = visibleSubscriptions.findIndex(item => (
        legacyItem.id ? item.id === legacyItem.id : item === legacyItem || item.url === legacyItem.url
    ));
    return index >= 0 ? { subscription: visibleSubscriptions[index], index } : null;
}

async function resolveTelegramSubscriptionListSelection(userId, rawIndex, env, cache) {
    const subscriptions = await getCachedSubscriptions(env, cache);
    const config = await getTelegramPushConfig(env, cache);
    const permission = checkUserPermission(userId, config);
    const visibleItems = permission.allowed
        ? subscriptions
        : subscriptions.filter(item => item.source === 'telegram' && item.telegram_user_id === userId);
    const visibleSubscriptions = visibleItems.filter(isSubscriptionEntry);
    if (rawIndex < 0 || rawIndex >= visibleSubscriptions.length) return null;
    return { subscription: visibleSubscriptions[rawIndex], index: rawIndex };
}

function normalizeStoredNodeUrls(value) {
    const candidates = Array.isArray(value)
        ? value
        : (typeof value === 'string' ? value.split(/\r?\n/) : []);
    return [...new Set(candidates.map(item => String(item || '').trim()).filter(isRealProxyNode))];
}

function createInlineSubscription(nodeUrls, name, userId, sourceClashConfig = null) {
    const nodes = normalizeStoredNodeUrls(nodeUrls);
    const id = generateId();
    const now = new Date().toISOString();
    return {
        id,
        type: 'inline',
        name: String(name || '').trim() || 'Telegram 多节点订阅',
        url: `inline:${id}`,
        nodeUrls: nodes,
        sourceClashConfig: normalizeClashSourceConfig(sourceClashConfig),
        nodeCount: nodes.length,
        enabled: true,
        source: 'telegram',
        telegram_user_id: userId,
        lastUpdate: now,
        created_at: now
    };
}

async function readStoredSubscriptionNodeUrls(storageAdapter, subscription) {
    const directNodes = normalizeStoredNodeUrls(subscription?.nodeUrls || subscription?.nodes);
    if (directNodes.length > 0) return directNodes;

    try {
        const cached = await storageAdapter.get(buildSubscriptionNodeCacheKey(subscription));
        return normalizeStoredNodeUrls(cached?.nodes);
    } catch (error) {
        console.warn('[Telegram Push] Failed to read stored subscription nodes:', error?.message || error);
        return [];
    }
}

async function persistStoredSubscriptionNodeUrls(storageAdapter, subscription, nodeUrls) {
    const nodes = normalizeStoredNodeUrls(nodeUrls);
    if (nodes.length === 0) return null;

    const cacheKey = buildSubscriptionNodeCacheKey(subscription);
    try {
        await storageAdapter.put(cacheKey, {
            nodes,
            nodeCount: nodes.length,
            updatedAt: new Date().toISOString(),
            sourceId: subscription?.id || null,
            sourceName: subscription?.name || '',
            sourceUrl: subscription?.url || ''
        });
        return cacheKey;
    } catch (error) {
        console.warn('[Telegram Push] Failed to persist stored subscription nodes:', error?.message || error);
        return null;
    }
}

async function renderStoredSubscriptionDetail(chatId, messageId, subscription, index, userId, env, cache, options = {}) {
    const storageAdapter = await getCachedStorageAdapter(env, cache);
    const nodeUrls = options.nodeUrls || await readStoredSubscriptionNodeUrls(storageAdapter, subscription);
    if (!subscription.id) {
        subscription.id = generateId();
        await persistCachedSubscriptions(env, cache);
        await persistStoredSubscriptionNodeUrls(storageAdapter, subscription, nodeUrls);
    }
    const session = {
        id: options.sessionId || generateId(),
        userId,
        sourceUrl: subscription.url,
        finalUrl: subscription.url,
        filename: subscription.name || 'subscription',
        name: subscription.name || '未命名订阅',
        nodeUrls,
        sourceClashConfig: normalizeClashSourceConfig(subscription.sourceClashConfig),
        storedNodeCount: Math.max(nodeUrls.length, Number(subscription.nodeCount || 0)),
        userInfo: subscription.userInfo || null,
        fetchedAt: Date.parse(subscription.lastUpdate || '') || Date.now(),
        savedSubscriptionId: subscription.id || null
    };
    session.isRemote = isRemoteSubscription(subscription);
    session.subscriptionIndex = index;
    session.listPage = options.listPage ?? Math.floor(index / TELEGRAM_SUBSCRIPTION_LIST_PAGE_SIZE);
    await persistPreviewSession(env, storageAdapter, session);

    await editTelegramMessage(chatId, messageId, buildStoredSubscriptionDetailCard(session), env, {
        requestCache: cache,
        disable_web_page_preview: true,
        reply_markup: buildStoredSubscriptionDetailKeyboard(session)
    });
    return session;
}

async function refreshStoredSubscriptionDetail(chatId, messageId, subscription, index, userId, env, cache, options = {}) {
    if (!isRemoteSubscription(subscription)) throw new Error('本地内嵌订阅无需刷新');
    const storageAdapter = await getCachedStorageAdapter(env, cache);
    const preview = await fetchSubscriptionPreview(subscription.url, {
        userAgent: subscription.customUserAgent || subscription.userAgent
    });
    const nodes = parseNodeList(preview.nodeUrls.join('\n')).map(node => node.url);
    if (nodes.length === 0) throw new Error('未识别到有效节点');

    if (!subscription.id) subscription.id = generateId();
    updateStoredSubscriptionName(subscription, preview.name);
    subscription.nodeUrls = nodes;
    subscription.nodeCount = nodes.length;
    subscription.userInfo = preview.userInfo || null;
    subscription.sourceClashConfig = normalizeClashSourceConfig(preview.sourceClashConfig);
    if (preview.userAgent && (!subscription.customUserAgent || preview.usedFallbackUserAgent)) {
        subscription.customUserAgent = preview.userAgent;
    }
    subscription.lastUpdate = new Date().toISOString();
    subscription.lastError = null;
    await persistCachedSubscriptions(env, cache);
    const cacheKey = await persistStoredSubscriptionNodeUrls(storageAdapter, subscription, nodes);

    const session = await renderStoredSubscriptionDetail(
        chatId,
        messageId,
        subscription,
        index,
        userId,
        env,
        cache,
        { ...options, nodeUrls: nodes }
    );
    return { session, cacheKey };
}

async function openStoredSubscriptionDetail(callbackQueryId, chatId, messageId, selected, userId, env, cache) {
    await answerCallbackQuery(callbackQueryId, '', env);
    try {
        await renderStoredSubscriptionDetail(
            chatId,
            messageId,
            selected.subscription,
            selected.index,
            userId,
            env,
            cache
        );
    } catch (error) {
        selected.subscription.lastError = error.message || '解析失败';
        await persistCachedSubscriptions(env, cache);
        await editTelegramMessage(
            chatId,
            messageId,
            buildTelegramParseFailureMessage('订阅解析失败', error),
            env,
            {
                requestCache: cache,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⬅️ 返回列表', callback_data: `list_page_sub_${Math.floor(selected.index / TELEGRAM_SUBSCRIPTION_LIST_PAGE_SIZE)}` }],
                        [{ text: '🏠 主菜单', callback_data: 'cmd_menu' }]
                    ]
                }
            }
        );
    }
}

async function deleteStoredSubscriptionDetail(session, env, cache) {
    const subscriptions = await getCachedSubscriptions(env, cache);
    const index = subscriptions.findIndex(item => item.id === session.savedSubscriptionId);
    if (index === -1) return null;

    const [deleted] = subscriptions.splice(index, 1);
    await persistCachedSubscriptions(env, cache);

    const profiles = await getCachedProfiles(env, cache);
    let profilesChanged = false;
    for (const profile of profiles) {
        if (!Array.isArray(profile.subscriptions)) continue;
        const next = profile.subscriptions.filter(id => id !== deleted.id);
        if (next.length !== profile.subscriptions.length) {
            profile.subscriptions = next;
            profilesChanged = true;
        }
    }
    if (profilesChanged) await persistCachedProfiles(env, cache);

    const storageAdapter = await getCachedStorageAdapter(env, cache);
    await clearAllNodeCaches(storageAdapter).catch(() => {});
    return deleted;
}

async function showSubscriptionPreview(chatId, sourceUrl, userId, env, requestCache = null, options = {}) {
    const cache = requestCache || createRequestCache();
    const storageAdapter = await getCachedStorageAdapter(env, cache);
    const preview = await fetchSubscriptionPreview(sourceUrl, { userAgent: options.userAgent });
    if (preview.nodeUrls.length === 0) throw new Error('未识别到有效的节点');

    const session = createPreviewSession(preview, userId, options.sessionId);
    if (session.nodeUrls.length === 0) throw new Error('未识别到有效的节点');
    if (options.savedSubscriptionId) session.savedSubscriptionId = options.savedSubscriptionId;
    await persistPreviewSession(env, storageAdapter, session);
    const message = buildSubscriptionPreviewCard(session);
    const reply_markup = buildSubscriptionPreviewKeyboard(session);

    if (options.messageId) {
        await editTelegramMessage(chatId, options.messageId, message, env, { reply_markup, requestCache: cache });
    } else {
        await sendTelegramMessage(chatId, message, env, { reply_markup, requestCache: cache, disable_web_page_preview: true });
    }
    return session;
}

async function showNodePreview(chatId, nodeUrl, userId, env, requestCache = null, options = {}) {
    const cache = requestCache || createRequestCache();
    const storageAdapter = await getCachedStorageAdapter(env, cache);
    const subscriptions = await getCachedSubscriptions(env, cache);
    const parsedNode = parseNodeList(String(nodeUrl || ''))[0];
    if (!parsedNode) throw new Error('未识别到有效的节点');
    const savedNode = subscriptions.find(item => (
        !isSubscriptionEntry(item) && item.url === parsedNode.url
    ));
    const session = createNodePreviewSession(parsedNode.url, userId, savedNode, options.sessionId);
    if (options.filename) session.filename = String(options.filename).trim() || session.filename;
    session.sourceClashConfig = normalizeClashSourceConfig(options.sourceClashConfig);
    await persistPreviewSession(env, storageAdapter, session);

    const message = buildNodePreviewCard(session);
    const reply_markup = buildSubscriptionPreviewKeyboard(session);
    if (options.messageId) {
        await editTelegramMessage(chatId, options.messageId, message, env, {
            reply_markup,
            requestCache: cache,
            disable_web_page_preview: true
        });
    } else {
        await sendTelegramMessage(chatId, message, env, {
            reply_markup,
            requestCache: cache,
            disable_web_page_preview: true
        });
    }
    return session;
}

async function savePreviewSubscription(session, userId, env, cache) {
    const storageAdapter = await getCachedStorageAdapter(env, cache);
    const subscriptions = await getCachedSubscriptions(env, cache);
    const isInline = session.sourceType === 'inline' || String(session.sourceUrl || '').startsWith('inline:');
    const isNode = session.sourceType === 'node';
    const nodeUrl = normalizeStoredNodeUrls(session.nodeUrls)[0] || session.sourceUrl;
    let subscription = subscriptions.find(item => item.id === session.savedSubscriptionId)
        || subscriptions.find(item => item.url === (isNode ? nodeUrl : session.sourceUrl));

    const now = new Date().toISOString();
    if (!subscription) {
        subscription = isNode
            ? {
                id: generateId(),
                name: session.name || extractNodeName(nodeUrl),
                url: nodeUrl,
                enabled: true,
                source: 'telegram',
                telegram_user_id: userId,
                created_at: now
            }
            : isInline
            ? createInlineSubscription(session.nodeUrls, session.name, userId, session.sourceClashConfig)
            : {
                id: generateId(),
                name: session.name,
                url: session.sourceUrl,
                enabled: true,
                source: 'telegram',
                telegram_user_id: userId,
                customUserAgent: session.userAgent || TELEGRAM_SUBSCRIPTION_USER_AGENT,
                nodeUrls: normalizeStoredNodeUrls(session.nodeUrls),
                sourceClashConfig: normalizeClashSourceConfig(session.sourceClashConfig),
                nodeCount: session.nodeUrls.length,
                userInfo: session.userInfo || null,
                lastUpdate: now,
                created_at: now
            };
        subscriptions.unshift(subscription);
    } else {
        if (!subscription.id) subscription.id = generateId();
        if (isNode) {
            subscription.url = nodeUrl;
            if (!String(subscription.name || '').trim()) subscription.name = session.name || extractNodeName(nodeUrl);
        } else {
            updateStoredSubscriptionName(subscription, session.name);
            subscription.nodeCount = session.nodeUrls.length;
            subscription.userInfo = session.userInfo || null;
            subscription.sourceClashConfig = normalizeClashSourceConfig(session.sourceClashConfig);
            subscription.lastUpdate = now;
            if (isInline) {
                subscription.type = 'inline';
                subscription.url = `inline:${subscription.id}`;
                subscription.nodeUrls = normalizeStoredNodeUrls(session.nodeUrls);
            } else {
                subscription.nodeUrls = normalizeStoredNodeUrls(session.nodeUrls);
                if (!subscription.customUserAgent || session.usedFallbackUserAgent) {
                    subscription.customUserAgent = session.userAgent || TELEGRAM_SUBSCRIPTION_USER_AGENT;
                }
            }
        }
    }

    await storageAdapter.putAllSubscriptions(subscriptions);

    session.savedSubscriptionId = subscription.id;
    await persistPreviewSession(env, storageAdapter, session);

    if (isNode) {
        const settings = await getCachedSettings(env, cache);
        const config = settings.telegram_push_config || {};
        const boundProfileId = getUserBoundProfileId(config, userId);
        if (boundProfileId) {
            const profiles = await getCachedProfiles(env, cache);
            const profile = profiles.find(item => item.id === boundProfileId);
            if (profile) {
                profile.manualNodes = Array.isArray(profile.manualNodes) ? profile.manualNodes : [];
                if (!profile.manualNodes.includes(subscription.id)) {
                    profile.manualNodes.push(subscription.id);
                    await persistCachedProfiles(env, cache);
                }
            }
        }
    }
    return subscription;
}

async function ensurePreviewProfile(session, subscription, env, cache) {
    const storageAdapter = await getCachedStorageAdapter(env, cache);
    const profiles = await getCachedProfiles(env, cache);
    const isNode = session.sourceType === 'node';
    let profile = profiles.find(item => item.telegramPreviewSubscriptionId === subscription.id);
    if (!profile) {
        profile = {
            id: generateId(),
            customId: `tg-${session.id}`,
            name: session.name,
            description: isNode ? '由 Telegram 节点解析卡片生成' : '由 Telegram 订阅解析卡片生成',
            enabled: true,
            isPublic: true,
            subscriptions: isNode ? [] : [subscription.id],
            manualNodes: isNode ? [subscription.id] : [],
            operators: [],
            telegramPreviewSubscriptionId: subscription.id,
            created_at: new Date().toISOString()
        };
        profiles.unshift(profile);
        await storageAdapter.putAllProfiles(profiles);
    } else {
        const targetKey = isNode ? 'manualNodes' : 'subscriptions';
        profile[targetKey] = Array.isArray(profile[targetKey]) ? profile[targetKey] : [];
        if (!profile[targetKey].includes(subscription.id)) {
            profile[targetKey].push(subscription.id);
            await storageAdapter.putAllProfiles(profiles);
        }
    }
    return profile;
}
/**
 * 解析目标参数（支持序号、ID、all）
 * @returns {Object} { type: 'index'|'id'|'all'|'range', values: [] }
 */
function parseTargetArgs(args) {
    if (!args || args.length === 0) {
        return { type: 'none', values: [] };
    }

    const arg = args.join(' ').trim().toLowerCase();

    if (arg === 'all' || arg === '全部') {
        return { type: 'all', values: [] };
    }

    // 支持逗号分隔的多个值
    const parts = arg.split(/[,，\s]+/).filter(p => p);
    const indices = [];
    const ids = [];

    for (const part of parts) {
        const num = parseInt(part);
        if (!isNaN(num) && num > 0) {
            indices.push(num - 1); // 转为0-indexed
        } else {
            ids.push(part);
        }
    }

    if (indices.length > 0 && ids.length === 0) {
        return { type: 'index', values: indices };
    } else if (ids.length > 0 && indices.length === 0) {
        return { type: 'id', values: ids };
    } else if (indices.length > 0 && ids.length > 0) {
        return { type: 'mixed', indices, ids };
    }

    return { type: 'none', values: [] };
}

// ==================== Telegram API ====================

/**
 * 配置 Telegram 左下角的命令菜单。
 *
 * 同时设置默认、所有私人聊天、当前聊天及当前语言的命令列表，避免历史
 * 聊天级或语言级配置覆盖新菜单。配置失败不应阻断命令的正常回复。
 */
async function ensureTelegramCommandMenu(chatId, env, requestCache = null, languageCode = '') {
    const cache = requestCache || createRequestCache();
    if (cache.telegramCommandMenuConfigured) return;
    cache.telegramCommandMenuConfigured = true;

    try {
        const config = await getTelegramPushConfig(env, cache);
        if (!config.bot_token) {
            console.error('[Telegram Push] Bot token not configured');
            return;
        }

        const apiBase = `https://api.telegram.org/bot${config.bot_token}`;
        if (telegramCommandMenuState.botToken !== config.bot_token) {
            telegramCommandMenuState.botToken = config.bot_token;
            telegramCommandMenuState.defaultConfigurationPromise = null;
        }

        if (!telegramCommandMenuState.defaultConfigurationPromise) {
            telegramCommandMenuState.defaultConfigurationPromise = (async () => {
                let configured = true;
                configured = await setTelegramCommands(
                    apiBase,
                    { type: 'default' },
                    '',
                    'default'
                ) && configured;
                configured = await setTelegramCommands(
                    apiBase,
                    { type: 'all_private_chats' },
                    '',
                    'private chats'
                ) && configured;

                const menuResponse = await fetch(`${apiBase}/setChatMenuButton`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        menu_button: { type: 'commands' }
                    })
                });
                if (!await isTelegramApiResponseSuccessful(menuResponse)) {
                    configured = false;
                    console.error('[Telegram Push] Failed to configure default menu button:', await readTelegramApiError(menuResponse));
                }

                return configured;
            })().catch(error => {
                console.error('[Telegram Push] Error configuring default command menu:', error);
                return false;
            });
        }

        const defaultConfigured = await telegramCommandMenuState.defaultConfigurationPromise;
        if (!defaultConfigured) {
            telegramCommandMenuState.defaultConfigurationPromise = null;
        }

        await setTelegramCommands(
            apiBase,
            { type: 'chat', chat_id: chatId },
            '',
            `chat ${chatId}`
        );

        const normalizedLanguageCode = normalizeTelegramCommandLanguageCode(languageCode);
        if (normalizedLanguageCode) {
            await setTelegramCommands(
                apiBase,
                { type: 'chat', chat_id: chatId },
                normalizedLanguageCode,
                `chat ${chatId} language ${normalizedLanguageCode}`
            );
        }

        const chatMenuResponse = await fetch(`${apiBase}/setChatMenuButton`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                menu_button: { type: 'commands' }
            })
        });
        if (!await isTelegramApiResponseSuccessful(chatMenuResponse)) {
            console.error('[Telegram Push] Failed to configure chat menu button:', await readTelegramApiError(chatMenuResponse));
        }
    } catch (error) {
        console.error('[Telegram Push] Error configuring command menu:', error);
    }
}

async function setTelegramCommands(apiBase, scope, languageCode = '', label = scope.type) {
    const body = {
        commands: TELEGRAM_COMMAND_MENU,
        scope
    };
    if (languageCode) body.language_code = languageCode;

    const response = await fetch(`${apiBase}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (await isTelegramApiResponseSuccessful(response)) return true;

    console.error(
        `[Telegram Push] Failed to configure bot commands for ${label}:`,
        await readTelegramApiError(response)
    );
    return false;
}

function normalizeTelegramCommandLanguageCode(languageCode) {
    if (typeof languageCode !== 'string') return '';
    const match = languageCode.trim().toLowerCase().match(/^[a-z]{2}/);
    return match?.[0] || '';
}

async function isTelegramApiResponseSuccessful(response) {
    if (!response?.ok) return false;
    try {
        const result = await response.clone().json();
        return result?.ok !== false;
    } catch {
        return true;
    }
}

async function readTelegramApiError(response) {
    try {
        return await response.clone().text();
    } catch {
        return `HTTP ${response?.status || 'unknown'}`;
    }
}

/**
 * 发送 Telegram 消息
 */
async function sendTelegramMessage(chatId, text, env, options = {}) {
    try {
        const { requestCache = null, ...telegramOptions } = options;
        const config = await getTelegramPushConfig(env, requestCache);
        if (!config.bot_token) {
            console.error('[Telegram Push] Bot token not configured');
            return;
        }

        const body = {
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML',
            ...telegramOptions
        };

        const response = await fetch(`https://api.telegram.org/bot${config.bot_token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            console.error('[Telegram Push] Failed to send message:', await response.clone().text());
        }

        return response;
    } catch (error) {
        console.error('[Telegram Push] Error sending message:', error);
    }
}

async function sendTelegramDocument(chatId, filename, content, env, caption = '') {
    try {
        const config = await getTelegramPushConfig(env);
        if (!config.bot_token) return;
        const safeName = truncateTelegramText(
            String(filename || 'subscription.txt').replace(/[^a-zA-Z0-9._-]/g, '_'),
            120
        );
        const form = new FormData();
        form.append('chat_id', String(chatId));
        if (caption) form.append('caption', truncateTelegramText(caption, 1000));
        const document = typeof File === 'function'
            ? new File([content], safeName, { type: 'application/octet-stream' })
            : new Blob([content], { type: 'application/octet-stream' });
        form.append('document', document, safeName);
        const response = await fetch(`https://api.telegram.org/bot${config.bot_token}/sendDocument`, {
            method: 'POST',
            body: form
        });
        if (!response.ok) {
            console.error('[Telegram Push] Failed to send document:', await response.clone().text());
            await sendTelegramMessage(chatId, '❌ 导出文件发送失败，请稍后重试', env);
        }
        return response;
    } catch (error) {
        console.error('[Telegram Push] Error sending document:', error);
        await sendTelegramMessage(chatId, '❌ 导出文件发送失败，请稍后重试', env);
    }
}

async function sendAllPreviewNodes(chatId, session, env) {
    const nodes = getPreviewNodes(session);
    const lines = nodes.map((node, index) => {
        const flag = getRegionEmoji(node.region) || '🌐';
        return `${index + 1}. ${flag} ${escapeHtml(node.protocol || '未知')}: ${escapeHtml(truncateTelegramText(node.name || '未命名节点'))}`;
    });
    const chunks = [];
    let current = `📄 ${escapeHtml(truncateTelegramText(session.name, 100))} · 全部节点 (${nodes.length})\n\n`;
    for (const line of lines) {
        if ((current + line + '\n').length > 3800) {
            chunks.push(current);
            current = '';
        }
        current += `${line}\n`;
    }
    if (current) chunks.push(current);
    for (const chunk of chunks) await sendTelegramMessage(chatId, chunk, env);
}
/**
 * 编辑 Telegram 消息
 */
async function editTelegramMessage(chatId, messageId, text, env, options = {}) {
    try {
        const { requestCache = null, ...telegramOptions } = options;
        const config = await getTelegramPushConfig(env, requestCache);
        if (!config.bot_token) return;

        const body = {
            chat_id: chatId,
            message_id: messageId,
            text: text,
            parse_mode: 'HTML',
            ...telegramOptions
        };

        await fetch(`https://api.telegram.org/bot${config.bot_token}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    } catch (error) {
        console.error('[Telegram Push] Error editing message:', error);
    }
}

/**
 * 回答 Callback Query
 */
async function answerCallbackQuery(callbackQueryId, text, env, showAlert = false) {
    try {
        const config = await getTelegramPushConfig(env);
        if (!config.bot_token) return;

        await fetch(`https://api.telegram.org/bot${config.bot_token}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                callback_query_id: callbackQueryId,
                text: text,
                show_alert: showAlert
            })
        });
    } catch (error) {
        console.error('[Telegram Push] Error answering callback:', error);
    }
}

// ==================== 验证函数 ====================

/**
 * 验证 Telegram Webhook 请求
 */
function verifyTelegramRequest(request, config) {
    const secretToken = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    return secretToken === config.webhook_secret;
}

function getUserBindingKey(userId) {
    return userId?.toString().trim();
}

function getUserBoundProfileId(config, userId) {
    const bindingKey = getUserBindingKey(userId);
    const bindings = config?.user_bindings || {};

    if (bindingKey && Object.prototype.hasOwnProperty.call(bindings, bindingKey)) {
        return bindings[bindingKey] || '';
    }

    if (config?.auto_bind && config?.default_profile_id) {
        return config.default_profile_id;
    }

    return '';
}

function setUserBoundProfileId(config, userId, profileId) {
    const bindingKey = getUserBindingKey(userId);
    const bindings = (config.user_bindings && typeof config.user_bindings === 'object')
        ? { ...config.user_bindings }
        : {};

    if (bindingKey) {
        bindings[bindingKey] = profileId || '';
    }

    config.user_bindings = bindings;
}

/**
 * 检查用户权限
 */
function checkUserPermission(userId, config) {
    if (!config.enabled) {
        return { allowed: false, reason: 'Bot 已被管理员禁用' };
    }

    if (config.allow_all_users) {
        return { allowed: true };
    }

    if (!config.allowed_user_ids || config.allowed_user_ids.length === 0) {
        return { allowed: false, reason: '未配置白名单，请先在设置中添加允许用户或显式开启公开访问' };
    }

    const userIdStr = userId.toString();
    if (!config.allowed_user_ids.some(id => id.toString().trim() === userIdStr)) {
        return { allowed: false, reason: '无权限使用此 Bot，请联系管理员添加白名单' };
    }

    return { allowed: true };
}

/**
 * 检查频率限制
 */
async function checkRateLimit(userId, env, config) {
    const minuteKey = `tg_push_rate:${userId}:min`;
    const dayKey = `tg_push_rate:${userId}:day`;

    const kv = env?.MISUB_KV || null;
    if (!kv) return { allowed: true }; // 无 KV 时不限流

    const minuteCount = parseInt(await kv.get(minuteKey) || '0');
    const dayCount = parseInt(await kv.get(dayKey) || '0');

    if (minuteCount >= config.rate_limit.max_per_minute) {
        return { allowed: false, reason: `操作过快，请1分钟后再试（${config.rate_limit.max_per_minute}/分钟）` };
    }

    if (dayCount >= config.rate_limit.max_per_day) {
        return { allowed: false, reason: `今日配额已用完（${config.rate_limit.max_per_day}/天）` };
    }

    await kv.put(minuteKey, (minuteCount + 1).toString(), { expirationTtl: 60 });
    await kv.put(dayKey, (dayCount + 1).toString(), { expirationTtl: 86400 });

    return { allowed: true };
}

// ==================== 获取用户节点 ====================

/**
 * 获取用户通过 Telegram 添加的节点
 */
async function getUserNodes(userId, env) {
    const storageAdapter = await getStorageAdapter(env);
    const allSubscriptions = await storageAdapter.getAllSubscriptions();

    // 检查用户是否在白名单中
    const config = await getTelegramPushConfig(env);
    const permission = checkUserPermission(userId, config);

    // 如果用户有权限（白名单用户），则显示所有节点（包括 Web 端添加的）
    if (permission.allowed) {
        return allSubscriptions;
    }

    // 否则仅返回该用户通过 Telegram 添加的节点（兜底逻辑）
    return allSubscriptions.filter(sub =>
        sub.source === 'telegram' && sub.telegram_user_id === userId
    );
}

/**
 * 获取所有节点和用户节点的索引映射
 */
async function getNodesWithMapping(userId, env) {
    const storageAdapter = await getStorageAdapter(env);
    const allSubscriptions = await storageAdapter.getAllSubscriptions();

    const config = await getTelegramPushConfig(env);
    const permission = checkUserPermission(userId, config);

    const userNodes = [];
    const indexMapping = []; // userIndex -> allIndex

    allSubscriptions.forEach((sub, allIndex) => {
        if (permission.allowed || (sub.source === 'telegram' && sub.telegram_user_id === userId)) {
            indexMapping.push(allIndex);
            userNodes.push(sub);
        }
    });

    return { allSubscriptions, userNodes, indexMapping, storageAdapter };
}

// ==================== 命令处理器 ====================

/**
 * 处理 /start 命令
 */
async function handleStartCommand(chatId, env) {
    const message =
        '👋 <b>欢迎使用 MiSub Telegram Bot！</b>\n\n' +
        '通过这个 Bot，你可以：\n' +
        '• 📤 快速添加代理节点\n' +
        '• 📋 管理你的节点列表\n' +
        '• 🔗 获取订阅链接\n\n' +
        '直接发送订阅链接、Base64 文本、节点链接或配置文件即可解析并添加。\n' +
        '支持 TXT、YAML、YML、CONF、JSON 文件（最大 5 MB）。\n\n' +
        '发送 /help 查看完整命令列表\n' +
        '发送 /menu 打开快捷菜单';

    await sendTelegramMessage(chatId, message, env);
}

/**
 * 处理 /help 命令
 */
async function handleHelpCommand(chatId, env) {
    const message =
        '📖 <b>MiSub Bot 命令帮助</b>\n\n' +
        '<b>📤 解析并添加</b>\n' +
        '直接发送订阅链接、Base64 文本或节点链接（支持批量）\n' +
        '也可发送 TXT、YAML、YML、CONF、JSON 文件（最大 5 MB）\n\n' +
        '<b>📋 查看</b>\n' +
        '/list - 选择节点列表 / 机场列表\n' +
        '/stats - 统计信息\n' +
        '/info [序号] - 节点详情\n' +
        '/search [词] - 搜索节点\n\n' +
        '<b>✏️ 编辑</b>\n' +
        '/enable [序号] - 启用\n' +
        '/disable [序号] - 禁用\n' +
        '/rename [序号] [名] - 重命名\n' +
        '/delete [序号] - 删除\n\n' +
        '<b>🔧 工具</b>\n' +
        '/bind - 绑定订阅组\n' +
        '/sort [类型] - 排序\n' +
        '/dup - 去重\n' +
        '/copy [序号] - 复制链接\n' +
        '/menu - 快捷菜单\n\n' +
        '💡 序号支持：1 | 1,3,5 | all';

    await sendTelegramMessage(chatId, message, env);
}

/**
 * 处理 /menu 命令 - 快捷菜单
 */
async function handleMenuCommand(chatId, env, messageId = null, requestCache = null) {
    const keyboard = {
        inline_keyboard: [
            [
                { text: '\uD83D\uDE80 节点列表', callback_data: 'cmd_list_node' }, // 🚀
                { text: '\uD83D\uDCE1 机场列表', callback_data: 'cmd_list_sub' },  // 📡
                { text: '\uD83D\uDCCA 统计', callback_data: 'cmd_stats' }      // 📊
            ],
            [
                { text: '\uD83D\uDD17 绑定', callback_data: 'cmd_bind' },      // 🔗
                { text: '\uD83D\uDD0D 搜索', callback_data: 'prompt_search' }, // 🔍
                { text: '\u2753 帮助', callback_data: 'cmd_help' }            // ❓
            ],
            [
                { text: '\u2705 全启用', callback_data: 'cmd_enable_all' },    // ✅
                { text: '\u26D4 全禁用', callback_data: 'cmd_disable_all' }    // ⛔
            ],
            [
                { text: '\uD83D\uDDD1\uFE0F 清空', callback_data: 'confirm_delete_all' } // 🗑️
            ]
        ]
    };

    if (messageId) {
        await editTelegramMessage(chatId, messageId, '📱 <b>快捷菜单</b>', env, {
            requestCache,
            reply_markup: keyboard
        });
    } else {
        await sendTelegramMessage(chatId, '📱 <b>快捷菜单</b>', env, {
            requestCache,
            reply_markup: keyboard
        });
    }
}

async function renderTelegramSubscriptionList(chatId, subscriptions, env, page = 0, messageId = null, requestCache = null) {
    const totalPages = Math.max(1, Math.ceil(subscriptions.length / TELEGRAM_SUBSCRIPTION_LIST_PAGE_SIZE));
    const currentPage = Math.min(Math.max(0, page), totalPages - 1);
    const startIdx = currentPage * TELEGRAM_SUBSCRIPTION_LIST_PAGE_SIZE;
    const endIdx = Math.min(startIdx + TELEGRAM_SUBSCRIPTION_LIST_PAGE_SIZE, subscriptions.length);
    const expiringCount = subscriptions.reduce((count, subscription) => (
        count + (getSubscriptionListSummary(subscription).expiring ? 1 : 0)
    ), 0);

    const message = `📂 订阅列表 共${subscriptions.length}个 | 🟠${expiringCount}个临期 | 第${currentPage + 1}/${totalPages}页`;
    const rows = [];

    for (let i = startIdx; i < endIdx; i++) {
        const subscription = subscriptions[i];
        const summary = getSubscriptionListSummary(subscription);
        const name = truncateTelegramText(subscription.name || '未命名订阅', 32);
        rows.push([{
            text: `${summary.status} #${i + 1} ${name} [${summary.traffic}] ${summary.expiry}`,
            callback_data: `sub_detail_${i}`
        }]);
    }

    const paginationRow = [];
    if (currentPage > 0) {
        paginationRow.push({ text: '⬅️', callback_data: `list_page_sub_${currentPage - 1}` });
    }
    paginationRow.push({ text: `📄 ${currentPage + 1}/${totalPages}`, callback_data: 'noop' });
    if (currentPage < totalPages - 1) {
        paginationRow.push({ text: '➡️', callback_data: `list_page_sub_${currentPage + 1}` });
    }
    rows.push(paginationRow);
    rows.push([
        { text: '🔢 跳转页码', callback_data: 'prompt_sub_page' },
        { text: '🔄 更新所有', callback_data: `refresh_all_subs_${currentPage}` }
    ]);
    rows.push([{ text: '🏠 主菜单', callback_data: 'cmd_menu' }]);

    const options = { requestCache, reply_markup: { inline_keyboard: rows } };
    if (messageId) {
        await editTelegramMessage(chatId, messageId, message, env, options);
    } else {
        await sendTelegramMessage(chatId, message, env, options);
    }
}

async function refreshTelegramSubscriptions(env, requestCache = null) {
    const cache = requestCache || createRequestCache();
    const subscriptions = await getCachedSubscriptions(env, cache);
    const storageAdapter = await getCachedStorageAdapter(env, cache);
    const targets = subscriptions.filter(subscription => (
        subscription?.enabled !== false && isRemoteSubscription(subscription)
    ));

    let cursor = 0;
    let success = 0;
    let failed = 0;
    const failures = [];
    const worker = async () => {
        while (cursor < targets.length) {
            const subscription = targets[cursor++];
            try {
                const preview = await fetchSubscriptionPreview(subscription.url, {
                    userAgent: subscription.customUserAgent || subscription.userAgent
                });
                const nodes = parseNodeList(preview.nodeUrls.join('\n'));
                if (nodes.length === 0) throw new Error('未识别到有效节点');
                const nodeUrls = nodes.map(node => node.url);
                if (!subscription.id) subscription.id = generateId();
                updateStoredSubscriptionName(subscription, preview.name);
                subscription.nodeUrls = nodeUrls;
                subscription.nodeCount = nodes.length;
                subscription.userInfo = preview.userInfo || null;
                if (preview.userAgent && (!subscription.customUserAgent || preview.usedFallbackUserAgent)) {
                    subscription.customUserAgent = preview.userAgent;
                }
                subscription.lastUpdate = new Date().toISOString();
                subscription.lastError = null;
                await persistStoredSubscriptionNodeUrls(
                    storageAdapter,
                    subscription,
                    nodeUrls
                );
                success++;
            } catch (error) {
                subscription.lastError = error.message || '更新失败';
                failures.push({
                    name: subscription.name || getSubscriptionUrlHostname(subscription.url) || '未命名订阅',
                    error: subscription.lastError
                });
                failed++;
            }
        }
    };

    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, () => worker()));
    cache.subscriptions = subscriptions;
    await persistCachedSubscriptions(env, cache);
    return { total: targets.length, success, failed, failures };
}

/**
 * 处理 /list 命令 - 节点列表（带分页和操作按钮）
 */
async function handleListCommand(chatId, userId, env, page = 0, type = 'all', messageId = null, requestCache = null) {
    try {
        const cache = requestCache || createRequestCache();
        const allNodes = await getUserNodes(userId, env);
        const profiles = await getCachedProfiles(env, cache);
        const settings = await getCachedSettings(env, cache);
        const config = settings.telegram_push_config || {};

        // 过滤节点
        let userNodes = allNodes;
        let title = '列表';
        if (type === 'node') {
            userNodes = allNodes.filter(n => !isSubscriptionEntry(n));
            title = '\uD83D\uDE80 节点列表'; // 🚀
        } else if (type === 'sub') {
            userNodes = allNodes.filter(isSubscriptionEntry);
            title = '\uD83D\uDCE1 机场列表'; // 📡
        }

        // 获取当前绑定的订阅组
        const boundProfileId = getUserBoundProfileId(config, userId);
        const boundProfile = boundProfileId
            ? profiles.find(p => p.id === boundProfileId)
            : null;
        const boundNodeIds = new Set(boundProfile?.manualNodes || []);

        if (userNodes.length === 0) {
            let emptyMsg = `\uD83D\uDCCB <b>暂无${type === 'sub' ? '机场订阅' : (type === 'node' ? '节点' : '资源')}</b>\n\n`; // 📋
            if (type === 'sub') emptyMsg += '发送包含 http/https 的链接即可添加机场订阅';
            else emptyMsg += '直接发送 ss/vless 等链接即可添加节点';

            if (messageId) {
                // Add back button even for empty list
                const keyboard = {
                    inline_keyboard: [[{ text: '🔙 返回菜单', callback_data: 'cmd_menu' }]]
                };
                await editTelegramMessage(chatId, messageId, emptyMsg, env, { reply_markup: keyboard });
            } else {
                await sendTelegramMessage(chatId, emptyMsg, env);
            }
            return;
        }

        if (type === 'sub') {
            await renderTelegramSubscriptionList(chatId, userNodes, env, page, messageId, cache);
            return;
        }

        const pageSize = 6; // 减少每页数量以容纳更多信息
        const totalPages = Math.ceil(userNodes.length / pageSize);
        const currentPage = Math.min(Math.max(0, page), totalPages - 1);
        const startIdx = currentPage * pageSize;
        const endIdx = Math.min(startIdx + pageSize, userNodes.length);

        let message = `\uD83D\uDCCB ${title} 共${userNodes.length}个 | 第${currentPage + 1}/${totalPages}页`; // 📋
        if (boundProfile) {
            message += ` | 绑定: ${escapeHtml(boundProfile.name)}`;
        }

        // 与机场列表一致，每个节点使用一整行可点击按钮。
        const nodeRows = [];
        for (let i = startIdx; i < endIdx; i++) {
            const node = userNodes[i];
            const isSub = isSubscriptionEntry(node);
            const nodeUrl = node.url || '';
            const protocol = isSub
                ? '订阅'
                : (nodeUrl.includes('://') ? nodeUrl.split('://')[0].toUpperCase() : '未知');
            const actionPrefix = (type === 'sub' || (type === 'all' && isSub))
                ? 'node_action_sub_'
                : 'node_action_node_';
            const status = node.enabled ? '\u2705' : '\u26D4'; // ✅ ⛔
            const inProfile = boundNodeIds.has(node.id) ? ' \uD83D\uDD17' : ''; // 🔗
            const name = truncateTelegramText(node.name || '未命名', 32);

            nodeRows.push([{
                text: `${status}${inProfile} #${i + 1} ${name} [${protocol}]`,
                callback_data: `${actionPrefix}${i}`
            }]);
        }

        // 分页按钮
        const navButtons = [];
        const typePrefix = type !== 'all' ? `${type}_` : '';

        if (currentPage > 0) {
            navButtons.push({ text: '\u2B05\uFE0F', callback_data: `list_page_${typePrefix}${currentPage - 1}` }); // ⬅️
        }

        // Add Back button in the middle or separate row?
        // Let's put pagination < > on one row, and Back on another or same?
        // Standard: <  Page  >
        // Row 2: Back

        navButtons.push({ text: `${currentPage + 1}/${totalPages}`, callback_data: 'noop' });

        if (currentPage < totalPages - 1) {
            navButtons.push({ text: '\u27A1\uFE0F', callback_data: `list_page_${typePrefix}${currentPage + 1}` }); // ➡️
        }

        const backButtonRow = [
            { text: '🔙 返回菜单', callback_data: 'cmd_menu' }
        ];

        const keyboard = {
            inline_keyboard: [
                ...nodeRows,
                navButtons,
                backButtonRow
            ]
        };

        if (messageId) {
            await editTelegramMessage(chatId, messageId, message, env, { reply_markup: keyboard });
        } else {
            await sendTelegramMessage(chatId, message, env, { reply_markup: keyboard });
        }

    } catch (error) {
        console.error('[Telegram Push] List command failed:', error);
        await sendTelegramMessage(chatId, `\u274C 获取列表失败: ${error.message}`, env); // ❌
    }
}

async function handleListTypeSelector(chatId, env, messageId = null, requestCache = null) {
    const message = '📋 <b>请选择列表类型</b>\n\n' +
        '🚀 节点列表：手动添加的代理节点\n' +
        '📡 机场列表：HTTP/HTTPS 机场订阅源\n\n' +
        '节点和机场订阅分开管理，避免序号混淆。';
    const keyboard = {
        inline_keyboard: [
            [
                { text: '🚀 节点列表', callback_data: 'cmd_list_node' },
                { text: '📡 机场列表', callback_data: 'cmd_list_sub' }
            ],
            [{ text: '🔙 返回菜单', callback_data: 'cmd_menu' }]
        ]
    };

    if (messageId) {
        await editTelegramMessage(chatId, messageId, message, env, { requestCache, reply_markup: keyboard });
    } else {
        await sendTelegramMessage(chatId, message, env, { requestCache, reply_markup: keyboard });
    }
}

/**
 * 处理 /stats 命令
 */
async function handleStatsCommand(chatId, userId, env, requestCache = null) {
    try {
        const userNodes = await getUserNodes(userId, env);

        let subCount = 0;
        let nodeCount = 0;
        let enabledCount = 0;
        const protocolCounts = {};

        userNodes.forEach(node => {
            const isSub = isSubscriptionEntry(node);

            if (isSub) {
                subCount++;
            } else {
                nodeCount++;
                const protocol = node.url.split('://')[0].toUpperCase();
                protocolCounts[protocol] = (protocolCounts[protocol] || 0) + 1;
            }

            if (node.enabled) enabledCount++;
        });

        const disabledCount = userNodes.length - enabledCount;

        let message = `\uD83D\uDCCA <b>统计信息</b>\n\n`; // 📊
        message += `资源总数: <b>${userNodes.length}</b>\n`;
        message += `├─ 订阅源: <b>${subCount}</b>\n`;
        message += `└─ 手动节点: <b>${nodeCount}</b>\n\n`;

        message += `状态:\n`;
        message += `\u2705 已启用: <b>${enabledCount}</b>\n`; // ✅
        message += `\u26D4 已禁用: <b>${disabledCount}</b>\n\n`; // ⛔

        if (Object.keys(protocolCounts).length > 0) {
            message += `<b>节点协议分布：</b>\n`;
            Object.entries(protocolCounts)
                .sort((a, b) => b[1] - a[1])
                .forEach(([protocol, count]) => {
                    message += `• ${protocol}: ${count}\n`;
                });
        }

        await sendTelegramMessage(chatId, message, env, { requestCache });
    } catch (error) {
        console.error('[Telegram Push] Stats command failed:', error);
        await sendTelegramMessage(chatId, `\u274C 获取统计失败: ${error.message}`, env, { requestCache }); // ❌
    }
}

/**
 * 处理 /delete 命令
 */
async function handleDeleteCommand(chatId, userId, args, env) {
    try {
        const target = parseTargetArgs(args);

        if (target.type === 'none') {
            await sendTelegramMessage(chatId,
                '❌ <b>请指定要删除的节点</b>\n\n' +
                '用法：\n' +
                '/delete 1 - 删除第1个\n' +
                '/delete 1,3,5 - 删除多个\n' +
                '/delete all - 删除全部',
                env
            );
            return;
        }

        const { allSubscriptions, userNodes, indexMapping, storageAdapter } = await getNodesWithMapping(userId, env);

        if (userNodes.length === 0) {
            await sendTelegramMessage(chatId, '📋 暂无可删除的节点', env);
            return;
        }

        let indicesToDelete = [];

        if (target.type === 'all') {
            indicesToDelete = indexMapping;
        } else if (target.type === 'index') {
            for (const idx of target.values) {
                if (idx >= 0 && idx < userNodes.length) {
                    indicesToDelete.push(indexMapping[idx]);
                }
            }
        } else if (target.type === 'id') {
            for (const id of target.values) {
                const foundIdx = allSubscriptions.findIndex(s => s.id === id);
                if (foundIdx !== -1 && indexMapping.includes(foundIdx)) {
                    indicesToDelete.push(foundIdx);
                }
            }
        }

        if (indicesToDelete.length === 0) {
            await sendTelegramMessage(chatId, '❌ 未找到指定的节点', env);
            return;
        }

        // 收集要删除的 ID
        const deletedIds = [];
        for (const idx of indicesToDelete) {
            if (allSubscriptions[idx]) {
                deletedIds.push(allSubscriptions[idx].id);
            }
        }

        // 删除节点（从后往前删除以保持索引正确）
        indicesToDelete.sort((a, b) => b - a);
        const deletedNames = [];
        for (const idx of indicesToDelete) {
            deletedNames.push(allSubscriptions[idx].name);
            allSubscriptions.splice(idx, 1);
        }

        await storageAdapter.putAllSubscriptions(allSubscriptions);

        // 3. 清理订阅组中的引用
        try {
            const profiles = await storageAdapter.getAllProfiles();
            if (profiles.length > 0) {
                let profilesUpdated = false;
                const idsToRemove = new Set(deletedIds);

                profiles.forEach(profile => {
                    // 清理 manualNodes
                    if (Array.isArray(profile.manualNodes)) {
                        const prevLen = profile.manualNodes.length;
                        profile.manualNodes = profile.manualNodes.filter(id => !idsToRemove.has(id));
                        if (profile.manualNodes.length !== prevLen) profilesUpdated = true;
                    }
                    // 清理 subscriptions
                    if (Array.isArray(profile.subscriptions)) {
                        const prevLen = profile.subscriptions.length;
                        profile.subscriptions = profile.subscriptions.filter(id => !idsToRemove.has(id));
                        if (profile.subscriptions.length !== prevLen) profilesUpdated = true;
                    }
                });

                if (profilesUpdated) {
                    await storageAdapter.putAllProfiles(profiles);
                    console.info(`[Telegram Push] Cleaned up ${deletedIds.length} node references from profiles`);
                }
            }
        } catch (cleanupError) {
            console.error('[Telegram Push] Cleanup profiles error:', cleanupError);
        }

        let message = `✅ <b>已删除 ${deletedNames.length} 个节点</b>\n\n`;
        if (deletedNames.length <= 5) {
            deletedNames.reverse().forEach(name => {
                message += `• ${name}\n`;
            });
        }

        await sendTelegramMessage(chatId, message, env);
        console.info(`[Telegram Push] User ${userId} deleted ${deletedNames.length} nodes`);

    } catch (error) {
        console.error('[Telegram Push] Delete command failed:', error);
        await sendTelegramMessage(chatId, `❌ 删除失败: ${error.message}`, env);
    }
}

/**
 * 处理 /enable 命令
 */
async function handleEnableCommand(chatId, userId, args, env) {
    await handleToggleCommand(chatId, userId, args, env, true);
}

/**
 * 处理 /disable 命令
 */
async function handleDisableCommand(chatId, userId, args, env) {
    await handleToggleCommand(chatId, userId, args, env, false);
}

/**
 * 切换节点启用状态
 */
async function handleToggleCommand(chatId, userId, args, env, enable) {
    try {
        const target = parseTargetArgs(args);
        const action = enable ? '启用' : '禁用';
        const icon = enable ? '✅' : '⛔';

        if (target.type === 'none') {
            await sendTelegramMessage(chatId,
                `❌ <b>请指定要${action}的节点</b>\n\n` +
                `用法：\n` +
                `/${enable ? 'enable' : 'disable'} 1 - ${action}第1个\n` +
                `/${enable ? 'enable' : 'disable'} 1,3,5 - ${action}多个\n` +
                `/${enable ? 'enable' : 'disable'} all - ${action}全部`,
                env
            );
            return;
        }

        const { allSubscriptions, userNodes, indexMapping, storageAdapter } = await getNodesWithMapping(userId, env);

        if (userNodes.length === 0) {
            await sendTelegramMessage(chatId, `📋 暂无可${action}的节点`, env);
            return;
        }

        let indicesToToggle = [];

        if (target.type === 'all') {
            indicesToToggle = [...indexMapping];
        } else if (target.type === 'index') {
            for (const idx of target.values) {
                if (idx >= 0 && idx < userNodes.length) {
                    indicesToToggle.push(indexMapping[idx]);
                }
            }
        }

        if (indicesToToggle.length === 0) {
            await sendTelegramMessage(chatId, '❌ 未找到指定的节点', env);
            return;
        }

        const toggledNames = [];
        for (const idx of indicesToToggle) {
            allSubscriptions[idx].enabled = enable;
            toggledNames.push(allSubscriptions[idx].name);
        }

        await storageAdapter.putAllSubscriptions(allSubscriptions);

        let message = `${icon} <b>已${action} ${toggledNames.length} 个节点</b>\n\n`;
        if (toggledNames.length <= 5) {
            toggledNames.forEach(name => {
                message += `• ${name}\n`;
            });
        }

        await sendTelegramMessage(chatId, message, env);

    } catch (error) {
        console.error(`[Telegram Push] Toggle command failed:`, error);
        await sendTelegramMessage(chatId, `❌ ${enable ? '启用' : '禁用'}失败: ${error.message}`, env);
    }
}

/**
 * 处理 /search 命令
 */
async function handleSearchCommand(chatId, userId, args, env) {
    try {
        const keyword = args.join(' ').trim();

        if (!keyword) {
            await sendTelegramMessage(chatId,
                '🔍 <b>搜索节点</b>\n\n' +
                '用法：/search <关键词>\n\n' +
                '示例：\n' +
                '/search 香港\n' +
                '/search vmess\n' +
                '/search HK',
                env
            );
            return;
        }

        const userNodes = await getUserNodes(userId, env);
        const lowerKeyword = keyword.toLowerCase();

        const results = userNodes.filter((node, idx) => {
            const protocol = node.url.split('://')[0].toLowerCase();
            return node.name.toLowerCase().includes(lowerKeyword) ||
                protocol.includes(lowerKeyword);
        });

        if (results.length === 0) {
            await sendTelegramMessage(chatId, `🔍 未找到包含 "<b>${keyword}</b>" 的节点`, env);
            return;
        }

        let message = `🔍 <b>搜索结果</b>：${results.length} 个\n\n`;

        results.slice(0, 10).forEach((node, i) => {
            const protocol = node.url.split('://')[0].toUpperCase();
            const status = node.enabled ? '✅' : '⛔';
            const originalIdx = userNodes.indexOf(node) + 1;
            message += `<b>${originalIdx}.</b> ${status} ${node.name} (${protocol})\n`;
        });

        if (results.length > 10) {
            message += `\n... 还有 ${results.length - 10} 个结果`;
        }

        await sendTelegramMessage(chatId, message, env);

    } catch (error) {
        console.error('[Telegram Push] Search command failed:', error);
        await sendTelegramMessage(chatId, `❌ 搜索失败: ${error.message}`, env);
    }
}

/**
 * 处理 /sub 命令 - 获取订阅链接
 */
async function handleSubCommand(chatId, args, env, request, requestCache = null) {
    try {
        const cache = requestCache || createRequestCache();
        const profiles = await getCachedProfiles(env, cache);
        const settings = await getCachedSettings(env, cache);

        // 获取公开的订阅组
        const publicProfiles = profiles.filter(p => p.isPublic);

        if (publicProfiles.length === 0) {
            await sendTelegramMessage(chatId,
                '🔗 <b>暂无公开订阅组</b>\n\n' +
                '请在 Web 界面创建订阅组并设为公开',
                env
            );
            return;
        }

        // 获取基础 URL - 优先使用设置中的域名
        let baseUrl = settings.custom_domain || settings.publicDomain || '';
        if (!baseUrl && request?.url) {
            try {
                const url = new URL(request.url);
                baseUrl = `${url.protocol}//${url.host}`;
            } catch (e) {
                baseUrl = '';
            }
        }

        if (args.length > 0) {
            // 查找指定订阅组
            const targetName = args.join(' ').trim().toLowerCase();
            const profile = publicProfiles.find(p =>
                p.name.toLowerCase().includes(targetName) ||
                p.id.toLowerCase() === targetName
            );

            if (!profile) {
                await sendTelegramMessage(chatId, `❌ 未找到名为 "<b>${escapeHtml(args.join(' '))}</b>" 的订阅组`, env);
                return;
            }

            let message = `🔗 <b>${profile.name}</b>\n\n`;
            if (baseUrl) {
                message += `订阅链接：\n<code>${baseUrl}/sub/${profile.id}</code>\n\n`;
                message += `点击链接可复制`;
            } else {
                message += `订阅组 ID：<code>${profile.id}</code>\n\n`;
                message += `💡 请在设置中配置公开域名以获取完整链接`;
            }

            await sendTelegramMessage(chatId, message, env);

        } else {
            // 列出所有公开订阅组
            let message = `🔗 <b>订阅组列表</b>\n\n`;

            publicProfiles.forEach((profile, i) => {
                message += `<b>${i + 1}. ${profile.name}</b>\n`;
                if (baseUrl) {
                    message += `<code>${baseUrl}/sub/${profile.id}</code>\n\n`;
                } else {
                    message += `ID: <code>${profile.id}</code>\n\n`;
                }
            });

            if (!baseUrl) {
                message += `💡 请在设置中配置公开域名`;
            } else {
                message += `💡 使用 /sub <名称> 获取指定订阅`;
            }

            await sendTelegramMessage(chatId, message, env);
        }

    } catch (error) {
        console.error('[Telegram Push] Sub command failed:', error);
        await sendTelegramMessage(chatId, `❌ 获取订阅失败: ${escapeHtml(error.message)}`, env);
    }
}

/**
 * 处理订阅获取 - 简化版（用于快捷菜单，不需要 request）
 */
async function handleSubCommandSimple(chatId, env, requestCache = null) {
    try {
        const cache = requestCache || createRequestCache();
        const profiles = await getCachedProfiles(env, cache);
        const settings = await getCachedSettings(env, cache);

        // 获取公开的订阅组
        const publicProfiles = profiles.filter(p => p.isPublic);

        if (publicProfiles.length === 0) {
            await sendTelegramMessage(chatId,
                '🔗 <b>暂无公开订阅组</b>\n\n' +
                '请在 Web 界面创建订阅组并设为公开',
                env
            );
            return;
        }

        // 尝试从设置中获取域名
        const customDomain = settings.custom_domain || settings.publicDomain || '';

        let message = '🔗 <b>订阅组列表</b>\n\n';

        publicProfiles.forEach((profile, i) => {
            message += `<b>${i + 1}. ${profile.name}</b>\n`;
            message += `ID: <code>${profile.id}</code>\n`;
            if (customDomain) {
                message += `链接: <code>${customDomain}/sub/${profile.id}</code>\n`;
            }
            message += '\n';
        });

        if (!customDomain) {
            message += '💡 请使用 /sub 命令获取完整链接';
        }

        await sendTelegramMessage(chatId, message, env);

    } catch (error) {
        console.error('[Telegram Push] Sub command simple failed:', error);
        await sendTelegramMessage(chatId, `❌ 获取订阅失败: ${escapeHtml(error.message)}`, env);
    }
}

/**
 * 处理 /rename 命令
 */
async function handleRenameCommand(chatId, userId, args, env) {
    try {
        if (args.length < 2) {
            await sendTelegramMessage(chatId,
                '✏️ <b>重命名节点</b>\n\n' +
                '用法：/rename [序号] [新名称]\n\n' +
                '示例：/rename 1 香港节点01',
                env
            );
            return;
        }

        const idx = parseInt(args[0]) - 1;
        const newName = args.slice(1).join(' ').trim();

        if (isNaN(idx) || idx < 0) {
            await sendTelegramMessage(chatId, '❌ 请输入有效的序号', env);
            return;
        }

        if (!newName) {
            await sendTelegramMessage(chatId, '❌ 请输入新名称', env);
            return;
        }

        const { allSubscriptions, userNodes, indexMapping, storageAdapter } = await getNodesWithMapping(userId, env);

        if (idx >= userNodes.length) {
            await sendTelegramMessage(chatId, `❌ 序号超出范围（共 ${userNodes.length} 个节点）`, env);
            return;
        }

        const allIdx = indexMapping[idx];
        const oldName = allSubscriptions[allIdx].name;
        allSubscriptions[allIdx].name = newName;

        await storageAdapter.putAllSubscriptions(allSubscriptions);

        await sendTelegramMessage(chatId,
            `✅ <b>重命名成功</b>\n\n` +
            `原名称：${oldName}\n` +
            `新名称：${newName}`,
            env
        );

    } catch (error) {
        console.error('[Telegram Push] Rename command failed:', error);
        await sendTelegramMessage(chatId, `❌ 重命名失败: ${escapeHtml(error.message)}`, env);
    }
}

/**
 * 处理 /info 命令 - 节点详情
 */
async function handleInfoCommand(chatId, userId, args, env) {
    try {
        if (args.length === 0) {
            await sendTelegramMessage(chatId,
                '📄 <b>查看节点详情</b>\n\n' +
                '用法：/info <序号>\n' +
                '示例：/info 1',
                env
            );
            return;
        }

        const idx = parseInt(args[0]) - 1;
        if (isNaN(idx) || idx < 0) {
            await sendTelegramMessage(chatId, '❌ 请输入有效的序号', env);
            return;
        }

        const userNodes = await getUserNodes(userId, env);

        if (idx >= userNodes.length) {
            await sendTelegramMessage(chatId, `❌ 序号超出范围（共 ${userNodes.length} 个节点）`, env);
            return;
        }

        const node = userNodes[idx];
        const protocol = node.url.split('://')[0].toUpperCase();
        const status = node.enabled ? '✅ 启用' : '⛔ 禁用';
        const createdAt = node.created_at ? new Date(node.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未知';

        // 脱敏显示服务器地址
        let serverInfo = '未解析';
        try {
            const urlPart = node.url.split('://')[1]?.split('#')[0];
            if (urlPart) {
                // 简单脱敏
                serverInfo = urlPart.length > 20 ? urlPart.substring(0, 10) + '...' + urlPart.slice(-8) : urlPart;
            }
        } catch { }

        let message = `📄 <b>节点详情 #${idx + 1}</b>\n\n`;
        message += `<b>名称：</b>${node.name}\n`;
        message += `<b>协议：</b>${protocol}\n`;
        message += `<b>状态：</b>${status}\n`;
        message += `<b>ID：</b><code>${node.id}</code>\n`;
        message += `<b>添加：</b>${createdAt}\n`;

        // 操作按钮
        const keyboard = {
            inline_keyboard: [
                [
                    { text: '📋 复制链接', callback_data: `copy_node_${idx}` },
                    { text: node.enabled ? '⛔ 禁用' : '✅ 启用', callback_data: `toggle_node_${idx}` }
                ],
                [
                    { text: '✏️ 重命名', callback_data: `prompt_rename_${idx}` },
                    { text: '🗑️ 删除', callback_data: `confirm_delete_${idx}` }
                ]
            ]
        };

        await sendTelegramMessage(chatId, message, env, { reply_markup: keyboard });

    } catch (error) {
        console.error('[Telegram Push] Info command failed:', error);
        await sendTelegramMessage(chatId, `❌ 获取详情失败: ${escapeHtml(error.message)}`, env);
    }
}

/**
 * 处理 /copy 命令 - 复制节点链接
 */
async function handleCopyCommand(chatId, userId, args, env) {
    try {
        const target = parseTargetArgs(args);

        if (target.type === 'none') {
            await sendTelegramMessage(chatId,
                '📋 <b>复制节点链接</b>\n\n' +
                '用法：/copy <序号>\n' +
                '示例：/copy 1\n' +
                '示例：/copy 1,2,3',
                env
            );
            return;
        }

        const userNodes = await getUserNodes(userId, env);

        if (userNodes.length === 0) {
            await sendTelegramMessage(chatId, '📋 暂无节点', env);
            return;
        }

        let indicesToCopy = [];

        if (target.type === 'all') {
            indicesToCopy = userNodes.map((_, i) => i);
        } else if (target.type === 'index') {
            indicesToCopy = target.values.filter(idx => idx >= 0 && idx < userNodes.length);
        }

        if (indicesToCopy.length === 0) {
            await sendTelegramMessage(chatId, '❌ 未找到指定的节点', env);
            return;
        }

        // 生成链接文本
        const links = indicesToCopy.map(idx => userNodes[idx].url).join('\n');

        if (indicesToCopy.length === 1) {
            const node = userNodes[indicesToCopy[0]];
            await sendTelegramMessage(chatId,
                `📋 <b>${node.name}</b>\n\n<code>${node.url}</code>\n\n点击上方链接可复制`,
                env
            );
        } else {
            await sendTelegramMessage(chatId,
                `📋 <b>已复制 ${indicesToCopy.length} 个节点链接</b>\n\n<code>${links}</code>`,
                env
            );
        }

    } catch (error) {
        console.error('[Telegram Push] Copy command failed:', error);
        await sendTelegramMessage(chatId, `❌ 复制失败: ${escapeHtml(error.message)}`, env);
    }
}

/**
 * 处理 /export 命令 - 导出节点
 */
async function handleExportCommand(chatId, userId, args, env) {
    try {
        const userNodes = await getUserNodes(userId, env);

        if (userNodes.length === 0) {
            await sendTelegramMessage(chatId, '📦 暂无可导出的节点', env);
            return;
        }

        const format = args[0]?.toLowerCase() || 'base64';

        let content = '';
        let formatName = '';

        switch (format) {
            case 'url':
            case 'raw':
                // 原始链接格式
                content = userNodes.map(n => n.url).join('\n');
                formatName = '原始链接';
                break;

            case 'base64':
            default:
                // Base64 格式
                const urls = userNodes.map(n => n.url).join('\n');
                content = btoa(unescape(encodeURIComponent(urls)));
                formatName = 'Base64';
                break;
        }

        let message = `📦 <b>导出成功</b>\n\n`;
        message += `格式：${formatName}\n`;
        message += `节点：${userNodes.length} 个\n\n`;

        if (content.length > 3000) {
            // 内容太长，分块发送
            message += `内容较长，请分段复制：`;
            await sendTelegramMessage(chatId, message, env);

            // 分块发送
            const chunkSize = 3000;
            for (let i = 0; i < content.length; i += chunkSize) {
                const chunk = content.substring(i, i + chunkSize);
                await sendTelegramMessage(chatId, `<code>${chunk}</code>`, env);
            }
        } else {
            message += `<code>${content}</code>`;
            await sendTelegramMessage(chatId, message, env);
        }

        await sendTelegramMessage(chatId,
            '💡 <b>导出格式</b>\n' +
            '/export - Base64（默认）\n' +
            '/export url - 原始链接',
            env
        );

    } catch (error) {
        console.error('[Telegram Push] Export command failed:', error);
        await sendTelegramMessage(chatId, `❌ 导出失败: ${escapeHtml(error.message)}`, env);
    }
}

/**
 * 处理 /import 命令 - 导入节点
 */
async function handleImportCommand(chatId, userId, args, env) {
    try {
        if (args.length === 0) {
            await sendTelegramMessage(chatId,
                '📥 <b>导入节点</b>\n\n' +
                '用法：/import <Base64 或订阅链接>\n\n' +
                '支持：\n' +
                '• Base64 编码的节点\n' +
                '• 订阅链接（http/https）\n\n' +
                '示例：\n' +
                '/import c3M6Ly9...\n' +
                '/import https://example.com/sub',
                env
            );
            return;
        }

        return handleNodeInput(chatId, args.join(' ').trim(), userId, env);

    } catch (error) {
        console.error('[Telegram Push] Import command failed:', error);
        await sendTelegramMessage(chatId, `❌ 导入失败: ${escapeHtml(error.message)}`, env);
    }
}

/**
 * 处理 /sort 命令 - 节点排序
 */
async function handleSortCommand(chatId, userId, args, env) {
    try {
        const sortType = args[0]?.toLowerCase() || '';

        if (!sortType || !['name', 'protocol', 'time', 'status'].includes(sortType)) {
            await sendTelegramMessage(chatId,
                '🔄 <b>节点排序</b>\n\n' +
                '用法：/sort <类型>\n\n' +
                '类型：\n' +
                '• name - 按名称排序\n' +
                '• protocol - 按协议排序\n' +
                '• time - 按时间排序\n' +
                '• status - 按状态排序',
                env
            );
            return;
        }

        const { allSubscriptions, userNodes, indexMapping, storageAdapter } = await getNodesWithMapping(userId, env);

        if (userNodes.length === 0) {
            await sendTelegramMessage(chatId, '📋 暂无可排序的节点', env);
            return;
        }

        // 创建排序映射
        const sortedIndices = [...Array(userNodes.length).keys()];

        switch (sortType) {
            case 'name':
                sortedIndices.sort((a, b) => userNodes[a].name.localeCompare(userNodes[b].name, 'zh-CN'));
                break;
            case 'protocol':
                sortedIndices.sort((a, b) => {
                    const pa = userNodes[a].url.split('://')[0];
                    const pb = userNodes[b].url.split('://')[0];
                    return pa.localeCompare(pb);
                });
                break;
            case 'time':
                sortedIndices.sort((a, b) => {
                    const ta = new Date(userNodes[a].created_at || 0).getTime();
                    const tb = new Date(userNodes[b].created_at || 0).getTime();
                    return tb - ta; // 新的在前
                });
                break;
            case 'status':
                sortedIndices.sort((a, b) => {
                    return (userNodes[b].enabled ? 1 : 0) - (userNodes[a].enabled ? 1 : 0);
                });
                break;
        }

        // 重新排列节点
        const sortedNodes = sortedIndices.map(i => userNodes[i]);

        // 从 allSubscriptions 中移除用户节点
        const indicesToRemove = [...indexMapping].sort((a, b) => b - a);
        for (const idx of indicesToRemove) {
            allSubscriptions.splice(idx, 1);
        }

        // 将排序后的节点添加回去
        allSubscriptions.unshift(...sortedNodes);

        await storageAdapter.putAllSubscriptions(allSubscriptions);

        const sortNames = { name: '名称', protocol: '协议', time: '时间', status: '状态' };
        await sendTelegramMessage(chatId,
            `✅ <b>排序完成</b>\n\n已按${sortNames[sortType]}排序 ${userNodes.length} 个节点`,
            env
        );

    } catch (error) {
        console.error('[Telegram Push] Sort command failed:', error);
        await sendTelegramMessage(chatId, `❌ 排序失败: ${escapeHtml(error.message)}`, env);
    }
}

/**
 * 处理 /dup 命令 - 去重检测
 */
async function handleDupCommand(chatId, userId, args, env) {
    try {
        const action = args[0]?.toLowerCase() || '';

        const { allSubscriptions, userNodes, indexMapping, storageAdapter } = await getNodesWithMapping(userId, env);

        if (userNodes.length === 0) {
            await sendTelegramMessage(chatId, '📋 暂无节点', env);
            return;
        }

        // 检测重复（基于 URL）
        const urlMap = new Map();
        const duplicates = [];

        userNodes.forEach((node, idx) => {
            const url = node.url;
            if (urlMap.has(url)) {
                duplicates.push({ idx, node, originalIdx: urlMap.get(url) });
            } else {
                urlMap.set(url, idx);
            }
        });

        if (duplicates.length === 0) {
            await sendTelegramMessage(chatId, '✅ <b>未发现重复节点</b>\n\n所有节点链接都是唯一的', env);
            return;
        }

        if (action === 'clean' || action === 'remove') {
            // 自动清理重复
            const indicesToDelete = duplicates.map(d => indexMapping[d.idx]).sort((a, b) => b - a);

            for (const idx of indicesToDelete) {
                allSubscriptions.splice(idx, 1);
            }

            await storageAdapter.putAllSubscriptions(allSubscriptions);

            await sendTelegramMessage(chatId,
                `✅ <b>去重完成</b>\n\n已删除 ${duplicates.length} 个重复节点`,
                env
            );

        } else {
            // 显示重复信息
            let message = `🔍 <b>发现 ${duplicates.length} 个重复节点</b>\n\n`;

            duplicates.slice(0, 5).forEach(({ idx, node, originalIdx }) => {
                message += `• #${idx + 1} 与 #${originalIdx + 1} 重复\n`;
                message += `  ${node.name}\n`;
            });

            if (duplicates.length > 5) {
                message += `\n... 还有 ${duplicates.length - 5} 个重复`;
            }

            message += '\n\n发送 /dup clean 自动清理重复';

            const keyboard = {
                inline_keyboard: [
                    [{ text: '🗑️ 清理重复节点', callback_data: 'cmd_dup_clean' }]
                ]
            };

            await sendTelegramMessage(chatId, message, env, { reply_markup: keyboard });
        }

    } catch (error) {
        console.error('[Telegram Push] Dup command failed:', error);
        await sendTelegramMessage(chatId, `❌ 去重检测失败: ${escapeHtml(error.message)}`, env);
    }
}

/**
 * 处理 /bind 命令 - 绑定默认订阅组
 */
async function handleBindCommand(chatId, userId, args, env, requestCache = null) {
    try {
        const cache = requestCache || createRequestCache();
        const profiles = await getCachedProfiles(env, cache);
        const settings = await getCachedSettings(env, cache);
        const config = settings.telegram_push_config || {};

        // 没有参数时列出订阅组
        if (args.length === 0) {
            if (profiles.length === 0) {
                await sendTelegramMessage(chatId, '📋 暂无订阅组\n\n请在 Web 界面创建', env, { requestCache });
                return;
            }

            let message = '🔗 <b>绑定订阅组</b>\n\n';
            message += '当前绑定: ';

            const currentProfileId = getUserBoundProfileId(config, userId);
            if (currentProfileId) {
                const current = profiles.find(p => p.id === currentProfileId);
                message += current ? `<b>${current.name}</b>` : '(已失效)';
            } else {
                message += '无';
            }

            message += '\n\n可用订阅组:\n';
            profiles.forEach((p, i) => {
                const isCurrent = p.id === currentProfileId;
                message += `${isCurrent ? '✅' : ''} ${i + 1}. ${p.name}\n`;
            });
            message += '\n用法: /bind [序号]';

            // 生成快捷按钮
            const buttons = profiles.slice(0, 6).map((p, i) => ({
                text: `${i + 1}. ${p.name.substring(0, 8)}`,
                callback_data: `bind_profile_${p.id}`
            }));

            const keyboard = {
                inline_keyboard: [
                    buttons.slice(0, 3),
                    buttons.slice(3, 6),
                    [{ text: '❌ 解除绑定', callback_data: 'unbind_profile' }]
                ].filter(row => row.length > 0)
            };

            await sendTelegramMessage(chatId, message, env, { reply_markup: keyboard, requestCache });
            return;
        }

        // 绑定指定订阅组
        const idx = parseInt(args[0]) - 1;
        if (isNaN(idx) || idx < 0 || idx >= profiles.length) {
            await sendTelegramMessage(chatId, '❌ 无效的序号', env, { requestCache });
            return;
        }

        const targetProfile = profiles[idx];

        // 更新配置
        setUserBoundProfileId(config, userId, targetProfile.id);
        config.auto_bind = true;
        settings.telegram_push_config = config;
        cache.settings = settings;
        await persistCachedSettings(env, cache);

        await sendTelegramMessage(chatId,
            `✅ <b>绑定成功</b>\n\n` +
            `已绑定到: <b>${targetProfile.name}</b>\n\n` +
            `之后添加的节点将自动关联到此订阅组`,
            env,
            { requestCache }
        );

    } catch (error) {
        console.error('[Telegram Push] Bind command failed:', error);
        await sendTelegramMessage(chatId, `❌ 绑定失败: ${escapeHtml(error.message)}`, env, { requestCache });
    }
}

/**
 * 处理 /unbind 命令 - 解除绑定
 */
async function handleUnbindCommand(chatId, userId, env, requestCache = null) {
    try {
        const cache = requestCache || createRequestCache();
        const settings = await getCachedSettings(env, cache);
        const config = settings.telegram_push_config || {};

        if (!getUserBoundProfileId(config, userId)) {
            await sendTelegramMessage(chatId, '馃搵 褰撳墠鏈粦瀹氫换浣曡闃呯粍', env);
            return;
        }

        setUserBoundProfileId(config, userId, '');
        settings.telegram_push_config = config;
        cache.settings = settings;
        await persistCachedSettings(env, cache);

        await sendTelegramMessage(chatId,
            '✅ <b>解除绑定成功</b>\n\n' +
            '之后添加的节点将不再自动关联订阅组',
            env
        );

    } catch (error) {
        console.error('[Telegram Push] Unbind command failed:', error);
        await sendTelegramMessage(chatId, `❌ 解除绑定失败: ${escapeHtml(error.message)}`, env);
    }
}

/**
 * 处理节点输入（核心逻辑）
 */
async function handleNodeInput(chatId, text, userId, env, requestCache = null, options = {}) {
    try {
        const cache = requestCache || createRequestCache();
        const config = await getTelegramPushConfig(env, cache);

        // 检查频率限制
        if (!options.rateLimitChecked) {
            const rateLimitCheck = await checkRateLimit(userId, env, config);
            if (!rateLimitCheck.allowed) {
                await sendTelegramMessage(chatId, `❌ ${rateLimitCheck.reason}`, env);
                return createJsonResponse({ ok: true });
            }
        }

        // HTTP/HTTPS 订阅先展示解析卡片，由按钮决定是否保存。
        const httpUrls = extractHttpUrls(text);
        if (httpUrls.length > 0 && !options.skipSubscriptionPreview && !options.forceInline) {
            if (httpUrls.length > TELEGRAM_BATCH_SUBSCRIPTION_THRESHOLD) {
                await sendTelegramMessage(
                    chatId,
                    `检测到 ${httpUrls.length} 条链接，超过阈值，结果将以文件形式发送。`,
                    env,
                    { requestCache: cache }
                );

                const batchResults = await fetchBatchSubscriptionPreviews(httpUrls);
                const stats = summarizeBatchSubscriptionResults(batchResults);
                await sendTelegramMessage(
                    chatId,
                    `查询统计: 有效: ${stats.有效} | 耗尽: ${stats.耗尽} | 过期: ${stats.过期} | 失效: ${stats.失效}`,
                    env,
                    { requestCache: cache }
                );
                await sendTelegramDocument(
                    chatId,
                    'subscription-batch-results.txt',
                    buildBatchSubscriptionReport(batchResults),
                    env,
                    `${httpUrls.length} 条订阅解析结果`
                );
            } else {
                for (const url of httpUrls) {
                    try {
                        await showSubscriptionPreview(chatId, url, userId, env, cache);
                    } catch (error) {
                        await sendTelegramMessage(
                            chatId,
                            buildTelegramParseFailureMessage('订阅解析失败', error),
                            env,
                            { requestCache: cache }
                        );
                    }
                }
            }

            // 同一条消息可能还带有直连节点，订阅预览不应吞掉它们。
            const directNodeUrls = extractNodeUrls(text);
            if (directNodeUrls.length === 0) return createJsonResponse({ ok: true });
            text = directNodeUrls.join('\n');
        }
        // 1. 普通消息中的节点、Base64 和混合文本统一直接解析。
        let nodeUrls;
        try {
            nodeUrls = await resolveTelegramNodeInput(text);
        } catch (error) {
            await sendTelegramMessage(chatId, buildTelegramParseFailureMessage('订阅解析失败', error), env);
            return createJsonResponse({ ok: true });
        }

        if (nodeUrls.length === 0) {
            const diagnosticInput = options.failureDiagnosticInput ?? text;
            const reason = describeNodeInputFailure(diagnosticInput);
            await sendTelegramMessage(
                chatId,
                `❌ <b>内容解析失败</b>\n\n` +
                `<b>失败阶段:</b> 节点识别与格式校验\n` +
                `<b>失败原因:</b> ${escapeHtml(reason)}\n` +
                `<b>输入长度:</b> ${String(diagnosticInput || '').length} 字符`,
                env
            );
            return createJsonResponse({ ok: true });
        }

        if (nodeUrls.length === 1 && options.skipNodePreview !== true) {
            await showNodePreview(chatId, nodeUrls[0], userId, env, cache, {
                filename: options.inlineFilename,
                sourceClashConfig: options.sourceClashConfig
            });
            return createJsonResponse({ ok: true });
        }

        if (nodeUrls.length > 1 && !options.forceInline && options.skipNodePreview !== true) {
            const storageAdapter = await getCachedStorageAdapter(env, cache);
            const previewSubscription = createInlineSubscription(
                nodeUrls,
                options.inlineName || extractNodeName(nodeUrls[0]),
                userId,
                options.sourceClashConfig
            );
            const session = createInlinePreviewSession(previewSubscription, userId, options.inlineFilename);
            session.savedSubscriptionId = null;
            await persistPreviewSession(env, storageAdapter, session);
            await sendTelegramMessage(chatId, buildSubscriptionPreviewCard(session), env, {
                reply_markup: buildSubscriptionPreviewKeyboard(session),
                requestCache: cache,
                disable_web_page_preview: true
            });
            return createJsonResponse({ ok: true });
        }

        const storageAdapter = await getCachedStorageAdapter(env, cache);
        const allSubscriptions = await getCachedSubscriptions(env, cache);
        const shouldShowSubscriptionPreviewCard = options.showSubscriptionPreviewCard === true || nodeUrls.length > 2;

        // 3. 批量处理与去重
        const addedNodes = [];
        const ignoredUrls = [];
        let existingInlineSubscription = null;

        if (options.forceInline || nodeUrls.length > 1) {
            const inlineSubscription = createInlineSubscription(
                nodeUrls,
                options.inlineName || extractNodeName(nodeUrls[0]),
                userId,
                options.sourceClashConfig
            );
            const signature = inlineSubscription.nodeUrls.join('\n');
            existingInlineSubscription = allSubscriptions.find(item => (
                item?.type === 'inline'
                && normalizeStoredNodeUrls(item.nodeUrls).join('\n') === signature
            ));
            if (existingInlineSubscription) {
                const sourceClashConfig = normalizeClashSourceConfig(options.sourceClashConfig);
                if (sourceClashConfig && !normalizeClashSourceConfig(existingInlineSubscription.sourceClashConfig)) {
                    existingInlineSubscription.sourceClashConfig = sourceClashConfig;
                    await storageAdapter.putAllSubscriptions(allSubscriptions);
                }
                ignoredUrls.push(...inlineSubscription.nodeUrls);
            } else {
                allSubscriptions.unshift(inlineSubscription);
                addedNodes.push(inlineSubscription);
            }
        } else {
            for (const url of nodeUrls) {
                const exists = allSubscriptions.some(sub => sub.url === url);
                if (exists) {
                    ignoredUrls.push(url);
                    continue;
                }

                const node = {
                    id: generateId(),
                    name: extractNodeName(url),
                    url,
                    enabled: true,
                    source: 'telegram',
                    telegram_user_id: userId,
                    created_at: new Date().toISOString()
                };

                allSubscriptions.unshift(node);
                addedNodes.push(node);
            }
        }

        if (addedNodes.length === 0) {
            if (shouldShowSubscriptionPreviewCard && existingInlineSubscription) {
                const session = createInlinePreviewSession(existingInlineSubscription, userId, options.inlineFilename);
                await persistPreviewSession(env, storageAdapter, session);
                await sendTelegramMessage(chatId, buildSubscriptionPreviewCard(session), env, {
                    reply_markup: buildSubscriptionPreviewKeyboard(session),
                    requestCache: cache,
                    disable_web_page_preview: true
                });
                return createJsonResponse({ ok: true });
            }
            await sendTelegramMessage(chatId,
                `⚠️ <b>未添加任何节点</b>\n\n` +
                `检测到 ${ignoredUrls.length} 个重复链接，已自动忽略。`,
                env
            );
            return createJsonResponse({ ok: true });
        }

        await storageAdapter.putAllSubscriptions(allSubscriptions);

        // [Verification] Read-Your-Writes Check
        try {
            const verifySubs = await storageAdapter.getAllSubscriptions();
            const isVerified = addedNodes.every(added => verifySubs.some(s => s.id === added.id));
            if (!isVerified) {
                console.warn('[Telegram Push] KV Verification failed');
                throw new Error('KV Write Verification Failed. Please try again.');
            }
        } catch (verifyError) {
            console.error('[Telegram Push] KV Verification error:', verifyError);
            if (verifyError.message.includes('Verification Failed')) throw verifyError;
        }

        // 4. 自动关联到订阅组 (分类处理)
        let boundProfileName = '';
        const boundProfileId = getUserBoundProfileId(config, userId);
        if (boundProfileId) {
            const profiles = await storageAdapter.getAllProfiles();
            const targetProfile = profiles.find(p => p.id === boundProfileId);

            if (targetProfile) {
                // 分类 ID
                const subIds = addedNodes.filter(isSubscriptionEntry).map(n => n.id);
                const nodeIds = addedNodes.filter(n => !isSubscriptionEntry(n)).map(n => n.id);

                let updated = false;

                if (nodeIds.length > 0) {
                    targetProfile.manualNodes = targetProfile.manualNodes || [];
                    targetProfile.manualNodes.push(...nodeIds);
                    updated = true;
                }

                if (subIds.length > 0) {
                    targetProfile.subscriptions = targetProfile.subscriptions || [];
                    targetProfile.subscriptions.push(...subIds);
                    updated = true;
                }

                if (updated) {
                    await storageAdapter.putAllProfiles(profiles);
                    boundProfileName = targetProfile.name;
                }
            }
        }

        // 5. 清除节点缓存，确保 Bot 新增/关联的节点能立即出现在实际订阅输出中
        try {
            const cacheResult = await clearAllNodeCaches(storageAdapter);
            console.info(`[Telegram Push] Cleared ${cacheResult?.cleared ?? 0} node caches after node import`);
        } catch (cacheError) {
            console.warn('[Telegram Push] Failed to clear node caches after node import:', cacheError?.message || cacheError);
        }

        if (shouldShowSubscriptionPreviewCard && addedNodes.length === 1 && isInlineSubscription(addedNodes[0])) {
            const session = createInlinePreviewSession(addedNodes[0], userId, options.inlineFilename);
            await persistPreviewSession(env, storageAdapter, session);
            await sendTelegramMessage(chatId, buildSubscriptionPreviewCard(session), env, {
                reply_markup: buildSubscriptionPreviewKeyboard(session),
                requestCache: cache,
                disable_web_page_preview: true
            });
            return createJsonResponse({ ok: true });
        }

        // 6. 发送反馈消息
        let message;
        const totalIgnored = ignoredUrls.length;
        const ignoreMsg = totalIgnored > 0 ? `\n⚠️ 已跳过 ${totalIgnored} 个重复链接` : '';

        if (addedNodes.length === 1) {
            const node = addedNodes[0];
            const isSub = isSubscriptionEntry(node);
            const typeLabel = isSub ? '📡 订阅源' : '🚀 节点';

            message = `✅ <b>${typeLabel}添加成功！</b>\n\n` +
                `📋 信息：\n` +
                `• 名称: ${escapeHtml(node.name)}\n` +
                // 对于订阅源显示域名，对于节点显示协议
                `• 类型: ${isSub ? (isRemoteSubscription(node) ? new URL(node.url).hostname : `内嵌订阅 · ${node.nodeCount} 节点`) : node.url.split('://')[0].toUpperCase()}`;

            if (boundProfileName) {
                message += `\n• 已关联: ${escapeHtml(boundProfileName)}`;
            }
            message += ignoreMsg;
            message += `\n\n💡 发送 /list 查看列表`;
        } else {
            message = `✅ <b>成功添加 ${addedNodes.length} 个项目</b>${ignoreMsg}\n\n`;
            addedNodes.slice(0, 5).forEach((node, index) => {
                const isSub = isSubscriptionEntry(node);
                const label = isSub ? '[订阅]' : `[${node.url.split('://')[0].toUpperCase()}]`;
                message += `${index + 1}. ${escapeHtml(node.name)} ${label}\n`;
            });
            if (addedNodes.length > 5) {
                message += `... 等 ${addedNodes.length} 个\n`;
            }
            if (boundProfileName) {
                message += `\n🔗 已关联到: ${escapeHtml(boundProfileName)}`;
            }
            message += `\n📋 发送 /list 查看完整列表`;
        }

        await sendTelegramMessage(chatId, message, env);
        console.info(`[Telegram Push] User ${userId} added ${addedNodes.length} items (Ignored ${totalIgnored})`);

        return createJsonResponse({ ok: true });

    } catch (error) {
        console.error('[Telegram Push] Node addition failed:', error);
        await sendTelegramMessage(chatId, `❌ <b>添加失败</b>\n\n错误: ${escapeHtml(error.message)}`, env);
        return createJsonResponse({ ok: true });
    }
}

async function handleTelegramDocumentInput(chatId, document, userId, env, requestCache = null) {
    const cache = requestCache || createRequestCache();
    try {
        const filename = validateTelegramImportDocument(document);
        const config = await getTelegramPushConfig(env, cache);
        const rateLimitCheck = await checkRateLimit(userId, env, config);
        if (!rateLimitCheck.allowed) {
            await sendTelegramMessage(chatId, `❌ ${rateLimitCheck.reason}`, env, { requestCache: cache });
            return createJsonResponse({ ok: true });
        }

        await sendTelegramMessage(
            chatId,
            `⏳ 正在解析文件：<b>${escapeHtml(truncateTelegramText(filename, 120))}</b>`,
            env,
            { requestCache: cache }
        );
        const text = await fetchTelegramDocumentText(document, env, cache);
        const sourceClashConfig = extractClashSourceConfig(text);
        const input = prepareTelegramDocumentInput(text);
        return handleNodeInput(chatId, input, userId, env, cache, {
            rateLimitChecked: true,
            forceInline: true,
            skipSubscriptionPreview: true,
            failureDiagnosticInput: text,
            inlineName: getInlineSubscriptionName(filename),
            inlineFilename: filename,
            sourceClashConfig,
            showSubscriptionPreviewCard: true
        });
    } catch (error) {
        console.error('[Telegram Push] Document import failed:', error);
        await sendTelegramMessage(
            chatId,
            buildTelegramParseFailureMessage('文件解析失败', error),
            env,
            { requestCache: cache }
        );
        return createJsonResponse({ ok: true });
    }
}

// ==================== 命令路由 ====================

/**
 * 处理命令
 */
async function handleCommand(chatId, text, userId, env, request, requestCache = null, languageCode = '') {
    const parts = text.split(/\s+/);
    const command = parts[0].toLowerCase().split('@')[0]; // 移除 @botname
    const args = parts.slice(1);

    if (['/start', '/help', '/list'].includes(command)) {
        await ensureTelegramCommandMenu(chatId, env, requestCache, languageCode);
    }

    switch (command) {
        case '/start':
            await handleStartCommand(chatId, env);
            break;

        case '/help':
            await handleHelpCommand(chatId, env);
            break;

        case '/menu':
            await handleMenuCommand(chatId, env, null, requestCache);
            break;

        case '/list':
            if (args[0]?.toLowerCase() === 'node' || args[0] === '节点') {
                const page = Math.max(0, Number.parseInt(args[1], 10) - 1 || 0);
                await handleListCommand(chatId, userId, env, page, 'node', null, requestCache);
            } else if (['sub', 'airport', 'subscription', '订阅', '机场'].includes(args[0]?.toLowerCase())) {
                const page = Math.max(0, Number.parseInt(args[1], 10) - 1 || 0);
                await handleListCommand(chatId, userId, env, page, 'sub', null, requestCache);
            } else {
                await handleListTypeSelector(chatId, env, null, requestCache);
            }
            break;

        case '/stats':
            await handleStatsCommand(chatId, userId, env, requestCache);
            break;

        case '/delete':
        case '/del':
        case '/rm':
            await handleDeleteCommand(chatId, userId, args, env);
            break;

        case '/enable':
        case '/on':
            await handleEnableCommand(chatId, userId, args, env);
            break;

        case '/disable':
        case '/off':
            await handleDisableCommand(chatId, userId, args, env);
            break;

        case '/search':
        case '/find':
            await handleSearchCommand(chatId, userId, args, env);
            break;

        case '/sub':
        case '/subscription':
            await handleSubCommand(chatId, args, env, request, requestCache);
            break;

        case '/rename':
            await handleRenameCommand(chatId, userId, args, env);
            break;

        case '/info':
        case '/detail':
            await handleInfoCommand(chatId, userId, args, env);
            break;

        case '/copy':
        case '/cp':
            await handleCopyCommand(chatId, userId, args, env);
            break;

        case '/export':
        case '/backup':
            await handleExportCommand(chatId, userId, args, env);
            break;

        case '/import':
            await handleImportCommand(chatId, userId, args, env);
            break;

        case '/sort':
            await handleSortCommand(chatId, userId, args, env);
            break;

        case '/dup':
        case '/dedup':
            await handleDupCommand(chatId, userId, args, env);
            break;

        case '/bind':
            await handleBindCommand(chatId, userId, args, env, requestCache);
            break;

        case '/unbind':
            await handleUnbindCommand(chatId, userId, env, requestCache);
            break;

        default:
            await sendTelegramMessage(chatId,
                '❌ 未知命令\n\n发送 /help 查看可用命令\n发送 /menu 打开快捷菜单',
                env
            );
    }

    return createJsonResponse({ ok: true });
}

// ==================== Callback Query 处理 ====================

/**
 * 处理 Callback Query（按钮回调）
 */
async function handleCallbackQuery(callbackQuery, env, request, requestCache = null) {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;

    try {
        if (data.startsWith('sd_')) {
            const match = data.match(/^sd_(refresh|delete|confirm|cancel|export|link|back)_(.+)$/);
            if (!match) {
                await answerCallbackQuery(callbackQuery.id, '无效操作', env, true);
                return createJsonResponse({ ok: true });
            }

            const [, action, sessionId] = match;
            const cache = requestCache || createRequestCache();
            const storageAdapter = await getCachedStorageAdapter(env, cache);
            const session = await readPreviewSession(env, storageAdapter, sessionId, userId);
            if (!session) {
                await answerCallbackQuery(callbackQuery.id, '订阅详情已过期，请返回列表重新打开', env, true);
                return createJsonResponse({ ok: true });
            }

            if (action === 'back') {
                await answerCallbackQuery(callbackQuery.id, '', env);
                await handleListCommand(chatId, userId, env, session.listPage || 0, 'sub', messageId, cache);
            } else if (action === 'refresh') {
                await answerCallbackQuery(callbackQuery.id, '正在刷新订阅...', env);
                const subscriptions = await getCachedSubscriptions(env, cache);
                const subscription = subscriptions.find(item => item.id === session.savedSubscriptionId);
                if (!subscription) {
                    await sendTelegramMessage(chatId, '❌ 订阅不存在或已删除', env, { requestCache: cache });
                } else {
                    try {
                        await refreshStoredSubscriptionDetail(
                            chatId,
                            messageId,
                            subscription,
                            session.subscriptionIndex,
                            userId,
                            env,
                            cache,
                            { sessionId: session.id, listPage: session.listPage }
                        );
                    } catch (error) {
                        subscription.lastError = error.message || '更新失败';
                        await persistCachedSubscriptions(env, cache);
                        await sendTelegramMessage(
                            chatId,
                            buildTelegramParseFailureMessage('刷新订阅失败', error),
                            env,
                            { requestCache: cache }
                        );
                    }
                }
            } else if (action === 'delete') {
                await answerCallbackQuery(callbackQuery.id, '', env);
                await editTelegramMessage(
                    chatId,
                    messageId,
                    `⚠️ <b>确认删除订阅？</b>\n\n${escapeHtml(session.name || '未命名订阅')}\n此操作无法撤销。`,
                    env,
                    {
                        requestCache: cache,
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '⚠️ 确认删除', callback_data: `sd_confirm_${session.id}` },
                                { text: '❌ 取消', callback_data: `sd_cancel_${session.id}` }
                            ]]
                        }
                    }
                );
            } else if (action === 'cancel') {
                await answerCallbackQuery(callbackQuery.id, '已取消', env);
                await editTelegramMessage(chatId, messageId, buildStoredSubscriptionDetailCard(session), env, {
                    requestCache: cache,
                    disable_web_page_preview: true,
                    reply_markup: buildStoredSubscriptionDetailKeyboard(session)
                });
            } else if (action === 'confirm') {
                const deleted = await deleteStoredSubscriptionDetail(session, env, cache);
                if (!deleted) {
                    await answerCallbackQuery(callbackQuery.id, '订阅不存在或已删除', env, true);
                } else {
                    await answerCallbackQuery(callbackQuery.id, '已删除', env);
                    await handleListCommand(chatId, userId, env, session.listPage || 0, 'sub', messageId, cache);
                }
            } else if (action === 'export') {
                if (!Array.isArray(session.nodeUrls) || session.nodeUrls.length === 0) {
                    await answerCallbackQuery(callbackQuery.id, '暂无已缓存节点，请先刷新订阅', env, true);
                    return createJsonResponse({ ok: true });
                }
                await answerCallbackQuery(callbackQuery.id, '正在导出节点...', env);
                await sendTelegramDocument(
                    chatId,
                    `${session.name || 'subscription'}.txt`,
                    session.nodeUrls.join('\n'),
                    env,
                    `${session.name || '订阅'} · ${session.nodeUrls.length} 个节点`
                );
            } else if (action === 'link') {
                await answerCallbackQuery(callbackQuery.id, '正在生成短链...', env);
                const subscriptions = await getCachedSubscriptions(env, cache);
                const subscription = subscriptions.find(item => item.id === session.savedSubscriptionId);
                if (!subscription) {
                    await sendTelegramMessage(chatId, '❌ 订阅不存在或已删除', env, { requestCache: cache });
                } else {
                    const profile = await ensurePreviewProfile(session, subscription, env, cache);
                    const settings = await getCachedSettings(env, cache);
                    const profileToken = settings.profileToken || 'profiles';
                    const origin = new URL(request.url).origin;
                    const link = `${origin}/${encodeURIComponent(profileToken)}/${encodeURIComponent(profile.customId || profile.id)}`;
                    await sendTelegramMessage(chatId, `🔗 <b>MiSub 订阅链接</b>\n\n<code>${escapeHtml(link)}</code>`, env, { requestCache: cache });
                }
            }

            return createJsonResponse({ ok: true });
        }

        if (data.startsWith('sp_')) {
            const match = data.match(/^sp_(refresh|all|b64|yaml|link|save)_(.+)$/);
            if (!match) {
                await answerCallbackQuery(callbackQuery.id, '无效操作', env, true);
                return createJsonResponse({ ok: true });
            }

            const [, action, sessionId] = match;
            const cache = requestCache || createRequestCache();
            const storageAdapter = await getCachedStorageAdapter(env, cache);
            const session = await readPreviewSession(env, storageAdapter, sessionId, userId);
            if (!session) {
                await answerCallbackQuery(callbackQuery.id, '解析结果已过期，请重新发送订阅链接', env, true);
                return createJsonResponse({ ok: true });
            }

            if (action === 'refresh') {
                await answerCallbackQuery(callbackQuery.id, '正在刷新...', env);
                try {
                    if (session.sourceType === 'node') {
                        await showNodePreview(chatId, session.sourceUrl, userId, env, cache, {
                            sessionId: session.id,
                            messageId,
                            filename: session.filename,
                            sourceClashConfig: session.sourceClashConfig
                        });
                    } else if (session.sourceType === 'inline') {
                        if (session.savedSubscriptionId) {
                            const subscriptions = await getCachedSubscriptions(env, cache);
                            const subscription = subscriptions.find(item => item.id === session.savedSubscriptionId);
                            if (!isInlineSubscription(subscription)) throw new Error('本地文件订阅不存在或已删除');
                            session.name = subscription.name;
                            session.nodeUrls = normalizeStoredNodeUrls(subscription.nodeUrls);
                            session.userInfo = subscription.userInfo || null;
                            session.sourceClashConfig = normalizeClashSourceConfig(subscription.sourceClashConfig);
                        }
                        session.fetchedAt = Date.now();
                        await persistPreviewSession(env, storageAdapter, session);
                        await editTelegramMessage(chatId, messageId, buildPreviewCard(session), env, {
                            reply_markup: buildSubscriptionPreviewKeyboard(session),
                            requestCache: cache,
                            disable_web_page_preview: true
                        });
                    } else {
                        const refreshedSession = await showSubscriptionPreview(chatId, session.sourceUrl, userId, env, cache, {
                            sessionId: session.id,
                            messageId,
                            savedSubscriptionId: session.savedSubscriptionId,
                            userAgent: session.userAgent
                        });
                        if (refreshedSession.savedSubscriptionId) {
                            await savePreviewSubscription(refreshedSession, userId, env, cache);
                            await clearAllNodeCaches(storageAdapter, { preserveSubscriptionCaches: true }).catch(() => {});
                        }
                    }
                } catch (error) {
                    await sendTelegramMessage(
                        chatId,
                        buildTelegramParseFailureMessage('刷新订阅失败', error),
                        env,
                        { requestCache: cache }
                    );
                }
            } else if (action === 'all') {
                await answerCallbackQuery(callbackQuery.id, '正在发送全部节点...', env);
                await sendAllPreviewNodes(chatId, session, env);
            } else if (action === 'b64') {
                await answerCallbackQuery(callbackQuery.id, '正在导出 Base64...', env);
                const raw = session.nodeUrls.join('\n');
                const encoded = btoa(unescape(encodeURIComponent(raw)));
                await sendTelegramDocument(chatId, `${session.name}.txt`, encoded, env, `${session.name} · Base64`);
            } else if (action === 'yaml') {
                await answerCallbackQuery(callbackQuery.id, '正在导出 YAML...', env);
                const yaml = generateClashConfig(session.nodeUrls, {
                    addFlagEmoji: true,
                    sourceClashConfig: session.sourceClashConfig
                });
                await sendTelegramDocument(chatId, `${session.name}.yaml`, yaml, env, `${session.name} · Clash YAML`);
            } else if (action === 'save') {
                await answerCallbackQuery(callbackQuery.id, '正在保存订阅...', env);
                const subscription = await savePreviewSubscription(session, userId, env, cache);
                await clearAllNodeCaches(storageAdapter, { preserveSubscriptionCaches: true }).catch(() => {});
                await editTelegramMessage(chatId, messageId, buildPreviewCard(session), env, {
                    reply_markup: buildSubscriptionPreviewKeyboard(session),
                    requestCache: cache,
                    disable_web_page_preview: true
                });
                const savedType = session.sourceType === 'node' ? '节点' : '订阅';
                await sendTelegramMessage(chatId, `✅ 已保存${savedType}：<b>${escapeHtml(subscription.name)}</b>`, env, { requestCache: cache });
            } else if (action === 'link') {
                await answerCallbackQuery(callbackQuery.id, '正在生成短链...', env);
                const subscription = await savePreviewSubscription(session, userId, env, cache);
                const profile = await ensurePreviewProfile(session, subscription, env, cache);
                await clearAllNodeCaches(storageAdapter, { preserveSubscriptionCaches: true }).catch(() => {});
                const settings = await getCachedSettings(env, cache);
                const profileToken = settings.profileToken || 'profiles';
                const origin = new URL(request.url).origin;
                const link = `${origin}/${encodeURIComponent(profileToken)}/${encodeURIComponent(profile.customId || profile.id)}`;
                await editTelegramMessage(chatId, messageId, buildPreviewCard(session), env, {
                    reply_markup: buildSubscriptionPreviewKeyboard(session),
                    requestCache: cache,
                    disable_web_page_preview: true
                });
                await sendTelegramMessage(chatId, `🔗 <b>MiSub 订阅链接</b>\n\n<code>${escapeHtml(link)}</code>`, env, { requestCache: cache });
            }

            return createJsonResponse({ ok: true });
        }

        // 分页命令
        // 分页命令 (格式: list_page_type_page 或 list_page_page 兼容旧版)
        if (data.startsWith('list_page_')) {
            const parts = data.replace('list_page_', '').split('_');
            let type = 'all';
            let page = 0;

            if (parts.length === 2 && isNaN(parseInt(parts[0]))) {
                type = parts[0];
                page = parseInt(parts[1]);
            } else {
                page = parseInt(parts[0]);
            }

            await answerCallbackQuery(callbackQuery.id, '', env);
            await handleListCommand(chatId, userId, env, page, type, messageId, requestCache);
            return createJsonResponse({ ok: true });
        }

        if (data === 'noop') {
            await answerCallbackQuery(callbackQuery.id, '', env);
            return createJsonResponse({ ok: true });
        }

        if (data === 'prompt_sub_page') {
            await answerCallbackQuery(callbackQuery.id, '请发送 /list sub 页码', env, true);
            return createJsonResponse({ ok: true });
        }

        if (data.startsWith('refresh_all_subs_')) {
            const page = Math.max(0, Number.parseInt(data.replace('refresh_all_subs_', ''), 10) || 0);
            await answerCallbackQuery(callbackQuery.id, '正在更新所有订阅...', env);
            try {
                const result = await refreshTelegramSubscriptions(env, requestCache);
                await handleListCommand(chatId, userId, env, page, 'sub', messageId, requestCache);
                const failureLines = result.failures.slice(0, 5).map(item => {
                    const safeName = escapeHtml(truncateTelegramText(item.name, 80));
                    const safeReason = escapeHtml(formatTelegramFailureReason(item.error, 500));
                    return `• <b>${safeName}</b>: ${safeReason}`;
                });
                const hiddenFailureCount = Math.max(0, result.failures.length - failureLines.length);
                let resultMessage = `🔄 更新完成：成功 ${result.success} 个，失败 ${result.failed} 个`;
                if (failureLines.length > 0) {
                    resultMessage += `\n\n<b>失败原因:</b>\n${failureLines.join('\n')}`;
                    if (hiddenFailureCount > 0) resultMessage += `\n• 另有 ${hiddenFailureCount} 个失败未展开`;
                }
                await sendTelegramMessage(
                    chatId,
                    resultMessage,
                    env,
                    { requestCache }
                );
            } catch (error) {
                await sendTelegramMessage(
                    chatId,
                    buildTelegramParseFailureMessage('更新订阅失败', error),
                    env,
                    { requestCache }
                );
            }
            return createJsonResponse({ ok: true });
        }

        // 快捷菜单命令
        switch (data) {
            case 'cmd_menu':
                await answerCallbackQuery(callbackQuery.id, '', env);
                await handleMenuCommand(chatId, env, messageId, requestCache);
                break;

            case 'cmd_list_node':
                await answerCallbackQuery(callbackQuery.id, '', env);
                await handleListCommand(chatId, userId, env, 0, 'node', messageId, requestCache);
                break;

            case 'cmd_list_sub':
                await answerCallbackQuery(callbackQuery.id, '', env);
                await handleListCommand(chatId, userId, env, 0, 'sub', messageId, requestCache);
                break;

            case 'cmd_stats':
                await answerCallbackQuery(callbackQuery.id, '', env);
                await handleStatsCommand(chatId, userId, env, requestCache);
                break;

            case 'cmd_sub':
                await answerCallbackQuery(callbackQuery.id, '', env);
                // 获取订阅 - 不需要 request，直接列出订阅组
                await handleSubCommandSimple(chatId, env, requestCache);
                break;

            case 'cmd_help':
                await answerCallbackQuery(callbackQuery.id, '', env);
                await handleHelpCommand(chatId, env);
                break;

            case 'cmd_export':
                await answerCallbackQuery(callbackQuery.id, '', env);
                await handleExportCommand(chatId, userId, [], env);
                break;

            case 'cmd_dup':
                await answerCallbackQuery(callbackQuery.id, '', env);
                await handleDupCommand(chatId, userId, [], env);
                break;

            case 'cmd_bind':
                await answerCallbackQuery(callbackQuery.id, '', env);
                await handleBindCommand(chatId, userId, [], env, requestCache);
                break;

            case 'prompt_import':
                await answerCallbackQuery(callbackQuery.id, '', env);
                await sendTelegramMessage(chatId,
                    '📥 <b>导入节点</b>\n\n请发送：\n/import <订阅链接>\n或\n/import <Base64>',
                    env
                );
                break;

            case 'prompt_sort':
                await answerCallbackQuery(callbackQuery.id, '', env);
                await sendTelegramMessage(chatId,
                    '🔄 <b>排序节点</b>\n\n/sort name - 按名称\n/sort protocol - 按协议\n/sort time - 按时间\n/sort status - 按状态',
                    env
                );
                break;

            case 'cmd_enable_all':
                await answerCallbackQuery(callbackQuery.id, '启用中...', env);
                await handleEnableCommand(chatId, userId, ['all'], env);
                break;

            case 'cmd_disable_all':
                await answerCallbackQuery(callbackQuery.id, '禁用中...', env);
                await handleDisableCommand(chatId, userId, ['all'], env);
                break;

            case 'confirm_delete_all':
                const confirmKeyboard = {
                    inline_keyboard: [
                        [
                            { text: '⚠️ 确认删除', callback_data: 'do_delete_all' },
                            { text: '❌ 取消', callback_data: 'cancel_action' }
                        ]
                    ]
                };
                await answerCallbackQuery(callbackQuery.id, '', env);
                await editTelegramMessage(chatId, messageId,
                    '⚠️ <b>确认删除全部？</b>',
                    env, { reply_markup: confirmKeyboard }
                );
                break;

            case 'do_delete_all':
                await answerCallbackQuery(callbackQuery.id, '删除中...', env);
                await handleDeleteCommand(chatId, userId, ['all'], env);
                break;

            case 'cancel_action':
                await answerCallbackQuery(callbackQuery.id, '已取消', env);
                await editTelegramMessage(chatId, messageId, '❌ 已取消', env);
                break;

            case 'prompt_search':
                await answerCallbackQuery(callbackQuery.id, '', env);
                await sendTelegramMessage(chatId,
                    '🔍 <b>搜索节点</b>\n\n请发送：/search <关键词>\n例：/search 香港',
                    env
                );
                break;

            case 'cmd_dup_clean':
                await answerCallbackQuery(callbackQuery.id, '清理中...', env);
                await handleDupCommand(chatId, userId, ['clean'], env);
                break;

            default:
                // 处理动态回调
                // 处理动态回调
                if (data.startsWith('node_action_')) {
                    // 节点/订阅 详情展示
                    // 格式: node_action_node_{idx} 或 node_action_sub_{idx}
                    // 兼容旧格式: node_action_{idx} (默认为node)

                    let type = 'node';
                    let idxStr = '';
                    if (data.startsWith('node_action_node_')) {
                        type = 'node';
                        idxStr = data.replace('node_action_node_', '');
                    } else if (data.startsWith('node_action_sub_')) {
                        type = 'sub';
                        idxStr = data.replace('node_action_sub_', '');
                    } else {
                        idxStr = data.replace('node_action_', '');
                    }

                    if (!/^\d+$/.test(idxStr)) {
                        await answerCallbackQuery(callbackQuery.id, '对象不存在', env, true);
                        return createJsonResponse({ ok: true });
                    }
                    const idx = Number(idxStr);

                    if (type === 'sub') {
                        const cache = requestCache || createRequestCache();
                        const selected = await resolveTelegramSubscriptionSelection(userId, idx, env, cache);
                        if (!selected) {
                            await answerCallbackQuery(callbackQuery.id, '对象不存在', env, true);
                            return createJsonResponse({ ok: true });
                        }

                        await openStoredSubscriptionDetail(
                            callbackQuery.id,
                            chatId,
                            messageId,
                            selected,
                            userId,
                            env,
                            cache
                        );
                        return createJsonResponse({ ok: true });
                    }

                    const storageAdapter = await getStorageAdapter(env);

                    // 获取对应列表
                    // 获取对应列表
                    let fullList = await getUserNodes(userId, env);
                    let targetList = [];

                    if (type === 'sub') {
                        // Must match handleListCommand's filtering logic for 'sub'
                        targetList = fullList.filter(isSubscriptionEntry);
                    } else {
                        // Must match handleListCommand's filtering logic for 'node'
                        targetList = fullList.filter(n => !isSubscriptionEntry(n));
                    }

                    let actionIdx = idx;
                    if ((idx < 0 || idx >= targetList.length) && fullList[idx]) {
                        const fallbackItem = fullList[idx];
                        const fallbackIsSub = isSubscriptionEntry(fallbackItem);
                        if ((type === 'sub' && fallbackIsSub) || (type === 'node' && !fallbackIsSub)) {
                            actionIdx = targetList.findIndex(item => (
                                fallbackItem.id
                                    ? item.id === fallbackItem.id
                                    : item === fallbackItem || item.url === fallbackItem.url
                            ));
                            targetList = fullList;
                        }
                    }

                    const profiles = await storageAdapter.getAllProfiles();
                    const settings = await storageAdapter.get(KV_KEY_SETTINGS) || {};
                    const config = settings.telegram_push_config || {};

                    if (idx < 0 || idx >= targetList.length) {
                        await answerCallbackQuery(callbackQuery.id, '对象不存在', env, true);
                        return createJsonResponse({ ok: true });
                    }

                    const node = targetList[idx];
                    const boundProfileId = getUserBoundProfileId(config, userId);
        const boundProfile = boundProfileId
            ? profiles.find(p => p.id === boundProfileId)
            : null;

                    // Note: Manual nodes use 'id', subscriptions might not have 'id' in the same way or logic might differ.
                    // Subscriptions usually have 'id' too.
                    let isInProfile = false;
                    if (boundProfile) {
                        if (type === 'sub') {
                            isInProfile = (boundProfile.subscriptions || []).includes(node.id);
                        } else {
                            isInProfile = (boundProfile.manualNodes || []).includes(node.id);
                        }
                    }

                    const protocol = (node.url || '').split('://')[0].toUpperCase();
                    const typeLabel = type === 'sub' ? '订阅' : '节点';

                    let message = `📋 <b>${typeLabel} #${idx + 1}</b>\n\n`;
                    message += `名称: ${escapeHtml(node.name || '未命名')}\n`;
                    message += `协议: ${protocol}\n`;
                    message += `状态: ${node.enabled ? '✅ 启用' : '⛔ 禁用'}\n`;

                    if (boundProfile) {
                        message += `订阅组: ${isInProfile ? '🔗 已关联' : '未关联'}\n`;
                    }

                    // 构建操作按钮
                    const buttons = [];

                    // 第一行：启用/禁用，复制
                    const toggleCmd = type === 'sub' ? `toggle_sub_${actionIdx}` : `toggle_node_${actionIdx}`;
                    const copyCmd = type === 'sub' ? `copy_sub_${actionIdx}` : `copy_node_${actionIdx}`;

                    buttons.push([
                        { text: node.enabled ? '⛔ 禁用' : '✅ 启用', callback_data: toggleCmd },
                        { text: '📋 复制', callback_data: copyCmd }
                    ]);

                    // 如果有绑定的订阅组，添加关联/取消关联按钮
                    if (boundProfile) {
                        const linkCmd = type === 'sub' ? `link_sub_${actionIdx}` : `link_node_${actionIdx}`;
                        const unlinkCmd = type === 'sub' ? `unlink_sub_${actionIdx}` : `unlink_node_${actionIdx}`;
                        buttons.push([{
                            text: isInProfile ? '➖ 从订阅组移除' : '➕ 添加到订阅组',
                            callback_data: isInProfile ? unlinkCmd : linkCmd
                        }]);
                    }

                    // 第二行：重命名，删除
                    const renameCmd = type === 'sub' ? `prompt_rename_sub_${actionIdx}` : `prompt_rename_node_${actionIdx}`;
                    const deleteCmd = type === 'sub' ? `confirm_delete_sub_${actionIdx}` : `confirm_delete_node_${actionIdx}`;

                    buttons.push([
                        { text: '✏️ 重命名', callback_data: renameCmd },
                        { text: '🗑️ 删除', callback_data: deleteCmd }
                    ]);

                    // 返回列表
                    const listCmd = type === 'sub' ? 'cmd_list_sub' : 'cmd_list_node';
                    buttons.push([{ text: '◀️ 返回列表', callback_data: listCmd }]);

                    await answerCallbackQuery(callbackQuery.id, '', env);
                    await editTelegramMessage(chatId, messageId, message, env, {
                        reply_markup: { inline_keyboard: buttons }
                    });

                } else if (data.startsWith('sub_detail_')) {
                    const idxStr = data.replace('sub_detail_', '');
                    if (!/^\d+$/.test(idxStr)) {
                        await answerCallbackQuery(callbackQuery.id, '对象不存在', env, true);
                        return createJsonResponse({ ok: true });
                    }

                    const cache = requestCache || createRequestCache();
                    const selected = await resolveTelegramSubscriptionListSelection(userId, Number(idxStr), env, cache);
                    if (!selected) {
                        await answerCallbackQuery(callbackQuery.id, '对象不存在', env, true);
                        return createJsonResponse({ ok: true });
                    }

                    await openStoredSubscriptionDetail(
                        callbackQuery.id,
                        chatId,
                        messageId,
                        selected,
                        userId,
                        env,
                        cache
                    );

                } else if (data.startsWith('link_node_')) {
                    // 添加节点到订阅组
                    const idx = parseInt(data.replace('link_node_', ''));
                    const storageAdapter = await getStorageAdapter(env);

                    // MUST Use filtered list to match index
                    const allNodes = await getUserNodes(userId, env);
                    const userNodes = allNodes.filter(n => !isSubscriptionEntry(n));

                    const profiles = await storageAdapter.getAllProfiles();
                    const settings = await storageAdapter.get(KV_KEY_SETTINGS) || {};
                    const config = settings.telegram_push_config || {};

                    const boundProfileId = getUserBoundProfileId(config, userId);
                    if (idx >= 0 && idx < userNodes.length && boundProfileId) {
                        const node = userNodes[idx];
                        const profile = profiles.find(p => p.id === boundProfileId);
                        if (profile) {
                            profile.manualNodes = profile.manualNodes || [];
                            if (!profile.manualNodes.includes(node.id)) {
                                profile.manualNodes.push(node.id);
                                await storageAdapter.putAllProfiles(profiles);
                            }
                            await answerCallbackQuery(callbackQuery.id, `已添加到 ${profile.name}`, env);
                            // 刷新操作面板
                            await editTelegramMessage(chatId, messageId,
                                `✅ 节点 #${idx + 1} 已添加到 <b>${profile.name}</b>`, env);
                        }
                    } else {
                        await answerCallbackQuery(callbackQuery.id, '操作失败', env, true);
                    }

                } else if (data.startsWith('unlink_node_')) {
                    // 从订阅组移除节点
                    const idx = parseInt(data.replace('unlink_node_', ''));
                    const storageAdapter = await getStorageAdapter(env);

                    // MUST Use filtered list to match index
                    const allNodes = await getUserNodes(userId, env);
                    const userNodes = allNodes.filter(n => !isSubscriptionEntry(n));

                    const profiles = await storageAdapter.getAllProfiles();
                    const settings = await storageAdapter.get(KV_KEY_SETTINGS) || {};
                    const config = settings.telegram_push_config || {};

                    const boundProfileId = getUserBoundProfileId(config, userId);
                    if (idx >= 0 && idx < userNodes.length && boundProfileId) {
                        const node = userNodes[idx];
                        const profile = profiles.find(p => p.id === boundProfileId);
                        if (profile && profile.manualNodes) {
                            profile.manualNodes = profile.manualNodes.filter(id => id !== node.id);
                            await storageAdapter.putAllProfiles(profiles);
                            await answerCallbackQuery(callbackQuery.id, `已从 ${profile.name} 移除`, env);
                            await editTelegramMessage(chatId, messageId,
                                `✅ 节点 #${idx + 1} 已从 <b>${profile.name}</b> 移除`, env);
                        }
                    } else {
                        await answerCallbackQuery(callbackQuery.id, '操作失败', env, true);
                    }

                } else if (data.startsWith('link_sub_')) {
                    // 添加订阅到订阅组
                    const idx = parseInt(data.replace('link_sub_', ''));
                    const storageAdapter = await getStorageAdapter(env);

                    // MUST Use filtered list
                    const allNodes = await getUserNodes(userId, env);
                    const subs = allNodes.filter(isSubscriptionEntry);

                    const profiles = await storageAdapter.getAllProfiles();
                    const settings = await storageAdapter.get(KV_KEY_SETTINGS) || {};
                    const config = settings.telegram_push_config || {};

                    const boundProfileId = getUserBoundProfileId(config, userId);
                    if (idx >= 0 && idx < subs.length && boundProfileId) {
                        const sub = subs[idx];
                        const profile = profiles.find(p => p.id === boundProfileId);
                        if (profile) {
                            profile.subscriptions = profile.subscriptions || [];
                            if (!profile.subscriptions.includes(sub.id)) {
                                profile.subscriptions.push(sub.id);
                                await storageAdapter.putAllProfiles(profiles);
                            }
                            await answerCallbackQuery(callbackQuery.id, `已添加到 ${profile.name}`, env);
                            await editTelegramMessage(chatId, messageId,
                                `✅ 订阅 #${idx + 1} 已添加到 <b>${profile.name}</b>`, env);
                        }
                    } else {
                        await answerCallbackQuery(callbackQuery.id, '操作失败', env, true);
                    }

                } else if (data.startsWith('unlink_sub_')) {
                    // 从订阅组移除订阅
                    const idx = parseInt(data.replace('unlink_sub_', ''));
                    const storageAdapter = await getStorageAdapter(env);

                    // MUST Use filtered list
                    const allNodes = await getUserNodes(userId, env);
                    const subs = allNodes.filter(isSubscriptionEntry);

                    const profiles = await storageAdapter.getAllProfiles();
                    const settings = await storageAdapter.get(KV_KEY_SETTINGS) || {};
                    const config = settings.telegram_push_config || {};

                    const boundProfileId = getUserBoundProfileId(config, userId);
                    if (idx >= 0 && idx < subs.length && boundProfileId) {
                        const sub = subs[idx];
                        const profile = profiles.find(p => p.id === boundProfileId);
                        if (profile && profile.subscriptions) {
                            profile.subscriptions = profile.subscriptions.filter(id => id !== sub.id);
                            await storageAdapter.putAllProfiles(profiles);
                            await answerCallbackQuery(callbackQuery.id, `已从 ${profile.name} 移除`, env);
                            await editTelegramMessage(chatId, messageId,
                                `✅ 订阅 #${idx + 1} 已从 <b>${profile.name}</b> 移除`, env);
                        }
                    } else {
                        await answerCallbackQuery(callbackQuery.id, '操作失败', env, true);
                    }

                } else if (data.startsWith('copy_sub_')) {
                    const idx = parseInt(data.replace('copy_sub_', ''));
                    // MUST Use filtered list
                    const allNodes = await getUserNodes(userId, env);
                    const subs = allNodes.filter(isSubscriptionEntry);

                    if (idx >= 0 && idx < subs.length) {
                        const subscription = subs[idx];
                        if (!isRemoteSubscription(subscription)) {
                            await answerCallbackQuery(callbackQuery.id, '本地内嵌订阅没有远程链接', env, true);
                        } else {
                            await answerCallbackQuery(callbackQuery.id, '已发送', env);
                            await sendTelegramMessage(chatId, `📋 <b>订阅链接</b>\n\n<code>${escapeHtml(subscription.url)}</code>`, env);
                        }
                    } else {
                        await answerCallbackQuery(callbackQuery.id, '对象不存在', env, true);
                    }

                } else if (data.startsWith('copy_node_')) {
                    const idx = parseInt(data.replace('copy_node_', ''));
                    await answerCallbackQuery(callbackQuery.id, '', env);
                    await handleCopyCommand(chatId, userId, [(idx + 1).toString()], env);

                } else if (data.startsWith('toggle_node_') || data.startsWith('toggle_sub_')) {
                    const isSub = data.startsWith('toggle_sub_');
                    const idx = parseInt(data.replace(isSub ? 'toggle_sub_' : 'toggle_node_', ''));
                    const storageAdapter = await getStorageAdapter(env);

                    let fullList = await getUserNodes(userId, env);
                    let targetList = [];
                    if (isSub) {
                        targetList = fullList.filter(isSubscriptionEntry);
                    } else {
                        targetList = fullList.filter(n => !isSubscriptionEntry(n));
                    }

                    if (idx >= 0 && idx < targetList.length) {
                        const targetItem = targetList[idx];
                        const isEnabled = targetItem.enabled;

                        await answerCallbackQuery(callbackQuery.id, isEnabled ? '已禁用' : '已启用', env);

                        if (isSub) {
                            // Find original index in KV_KEY_SUBS to update
                            // Since targetList is filtered, we need to find the item in the original storage
                            const originalSubs = await storageAdapter.getAllSubscriptions();
                            // Match by ID if possible, or some unique property. 
                            // Subscription objects usually have IDs.
                            const subToUpdate = originalSubs.find(s => s.id === targetItem.id);

                            if (subToUpdate) {
                                subToUpdate.enabled = !isEnabled;
                                await storageAdapter.putAllSubscriptions(originalSubs);
                                await handleListCommand(chatId, userId, env, 0, 'sub');
                            }
                        } else {
                            // Valid for manual nodes - use command which likely handles ID or index?
                            // handleDisableCommand takes index. Is it filtered index?
                            // Let's check handleDisableCommand.
                            // If handleDisableCommand expects ALL nodes index, we have a problem.
                            // But typically commands work on displayed lists?
                            // If user types /disable 1, what does it disable? 
                            // If it disables filtered list item, we are good.
                            // If it disables global list item, we are misaligned.

                            // If handleDisableCommand uses `getUserNodes` without filtering, we need to map `idx` back to `allNodes` index.
                            const allNodes = await getUserNodes(userId, env);
                            const realIdx = allNodes.findIndex(n => n.id === targetItem.id);

                            if (realIdx !== -1) {
                                if (isEnabled) {
                                    await handleDisableCommand(chatId, userId, [(realIdx + 1).toString()], env);
                                } else {
                                    await handleEnableCommand(chatId, userId, [(realIdx + 1).toString()], env);
                                }
                            }
                        }
                    } else {
                        await answerCallbackQuery(callbackQuery.id, '对象不存在', env, true);
                    }

                } else if (data.startsWith('confirm_delete_')) {
                    // Handles: confirm_delete_node_{idx}, confirm_delete_sub_{idx}, confirm_delete_{idx}
                    let type = 'node';
                    let idxStr = '';
                    if (data.startsWith('confirm_delete_sub_')) {
                        type = 'sub';
                        idxStr = data.replace('confirm_delete_sub_', '');
                    } else if (data.startsWith('confirm_delete_node_')) {
                        type = 'node';
                        idxStr = data.replace('confirm_delete_node_', '');
                    } else {
                        idxStr = data.replace('confirm_delete_', '');
                    }
                    const idx = parseInt(idxStr);

                    const confirmKeyboard = {
                        inline_keyboard: [
                            [
                                { text: '⚠️ 确认删除', callback_data: `do_delete_${type}_${idx}` },
                                { text: '❌ 取消', callback_data: 'cancel_action' }
                            ]
                        ]
                    };
                    await editTelegramMessage(chatId, messageId, '⚠️ <b>确认删除此对象吗？</b>\n此操作无法撤销。', env, {
                        reply_markup: confirmKeyboard
                    });

                } else if (data.startsWith('do_delete_')) {
                    // Handles: do_delete_node_{idx}, do_delete_sub_{idx}, do_delete_{idx}
                    let type = 'node';
                    let idxStr = '';
                    if (data.startsWith('do_delete_sub_')) {
                        type = 'sub';
                        idxStr = data.replace('do_delete_sub_', '');
                    } else if (data.startsWith('do_delete_node_')) {
                        type = 'node';
                        idxStr = data.replace('do_delete_node_', '');
                    } else {
                        idxStr = data.replace('do_delete_', '');
                    }
                    const idx = parseInt(idxStr);

                    // Need to map filtered index to real storage index/ID
                    const allNodes = await getUserNodes(userId, env);
                    let targetItem = null;

                    if (type === 'sub') {
                        const subs = allNodes.filter(isSubscriptionEntry);
                        if (idx >= 0 && idx < subs.length) targetItem = subs[idx];
                    } else {
                        const nodes = allNodes.filter(n => !isSubscriptionEntry(n));
                        if (idx >= 0 && idx < nodes.length) targetItem = nodes[idx];
                    }

                    if (targetItem) {
                        if (type === 'sub') {
                            // Create separate handleDeleteSub logic or direct DB manipulation safely
                            const storageAdapter = await getStorageAdapter(env);
                            const originalSubs = await storageAdapter.getAllSubscriptions();
                            const realIdx = originalSubs.findIndex(s => s.id === targetItem.id);

                            if (realIdx !== -1) {
                                const deletedName = originalSubs[realIdx].name;
                                originalSubs.splice(realIdx, 1);
                                await storageAdapter.putAllSubscriptions(originalSubs);
                                await answerCallbackQuery(callbackQuery.id, '已删除', env);
                                await sendTelegramMessage(chatId, `🗑️ 已删除订阅: <b>${escapeHtml(deletedName)}</b>`, env);
                                await handleListCommand(chatId, userId, env, 0, 'sub');
                            } else {
                                await answerCallbackQuery(callbackQuery.id, '对象不存在或已删除', env, true);
                            }
                        } else {
                            // For nodes, find real index in ALL nodes for command
                            const realIdx = allNodes.findIndex(n => n.id === targetItem.id);
                            if (realIdx !== -1) {
                                await answerCallbackQuery(callbackQuery.id, '正在删除...', env);
                                await handleDeleteCommand(chatId, userId, [(realIdx + 1).toString()], env);
                            }
                        }
                    } else {
                        await answerCallbackQuery(callbackQuery.id, '对象不存在', env, true);
                    }

                } else if (data.startsWith('prompt_rename_')) {
                    // Handles: prompt_rename_node_{idx}, prompt_rename_sub_{idx}, prompt_rename_{idx}
                    let type = 'node';
                    let idxStr = '';
                    if (data.startsWith('prompt_rename_sub_')) {
                        type = 'sub';
                        idxStr = data.replace('prompt_rename_sub_', '');
                    } else if (data.startsWith('prompt_rename_node_')) {
                        type = 'node';
                        idxStr = data.replace('prompt_rename_node_', '');
                    } else {
                        idxStr = data.replace('prompt_rename_', '');
                    }
                    const idx = parseInt(idxStr);

                    // Store state? Ideally use ForceReply.
                    // Simplified: Just tell user command
                    const cmdPrefix = type === 'sub' ? '/set_sub_name' : '/rename';
                    // Wait, do we have /set_sub_name? Probably not.
                    // If no command exists for renaming subs via bot, we might need to add one or just say "Not supported via bot yet".
                    // But for now, let's assume rename is only for nodes or implemented generically.
                    // Checking implementation: handleRenameCommand usually takes indices.

                    if (type === 'sub') {
                        await answerCallbackQuery(callbackQuery.id, '暂不支持在 Bot 中重命名订阅', env, true);
                    } else {
                        await answerCallbackQuery(callbackQuery.id, '请发送新名称', env);
                        await sendTelegramMessage(chatId, `请回复以下格式重命名:\n<code>/rename ${idx + 1} 新名称</code>`, env);
                    }
                } else if (data.startsWith('bind_profile_')) {
                    // 绑定订阅组
                    const profileId = data.replace('bind_profile_', '');
                    const cache = requestCache || createRequestCache();
                    const profiles = await getCachedProfiles(env, cache);
                    const settings = await getCachedSettings(env, cache);
                    const config = settings.telegram_push_config || {};

                    const targetProfile = profiles.find(p => p.id === profileId);
                    if (targetProfile) {
                        setUserBoundProfileId(config, userId, profileId);
                        config.auto_bind = true;
                        settings.telegram_push_config = config;
                        cache.settings = settings;
                        await persistCachedSettings(env, cache);

                        await answerCallbackQuery(callbackQuery.id, `已绑定: ${targetProfile.name}`, env);
                        await editTelegramMessage(chatId, messageId,
                            `✅ <b>绑定成功</b>\n\n已绑定到: <b>${targetProfile.name}</b>`,
                            env,
                            { requestCache }
                        );
                    } else {
                        await answerCallbackQuery(callbackQuery.id, '订阅组不存在', env, true);
                    }

                } else if (data === 'unbind_profile') {
                    // 解除绑定
                    const cache = requestCache || createRequestCache();
                    const settings = await getCachedSettings(env, cache);
                    const config = settings.telegram_push_config || {};

                    setUserBoundProfileId(config, userId, '');
                    settings.telegram_push_config = config;
                    cache.settings = settings;
                    await persistCachedSettings(env, cache);

                    await answerCallbackQuery(callbackQuery.id, '已解除绑定', env);
                    await editTelegramMessage(chatId, messageId, '✅ 已解除绑定', env, { requestCache });

                } else {
                    await answerCallbackQuery(callbackQuery.id, '未知操作', env);
                }
        }

    } catch (error) {
        console.error('[Telegram Push] Callback query failed:', error);
        await answerCallbackQuery(callbackQuery.id, '操作失败', env, true);
    }

    return createJsonResponse({ ok: true });
}

// ==================== 主 Webhook 处理 ====================

/**
 * 主 Webhook 处理函数
 */
export async function handleTelegramWebhook(request, env) {
    try {
        const requestCache = createRequestCache();
        // 获取配置
        const config = await getTelegramPushConfig(env, requestCache);

        if (!config.enabled) {
            return createJsonResponse({ error: 'Bot disabled' }, 403);
        }

        // 验证请求来源
        if (!config.webhook_secret) {
            console.error('[Telegram Push] Missing webhook secret');
            return createJsonResponse({ error: 'Webhook secret required' }, 503);
        }

        if (!verifyTelegramRequest(request, config)) {
            console.error('[Telegram Push] Invalid webhook secret');
            return createJsonResponse({ error: 'Unauthorized' }, 401);
        }

        // 解析 Telegram Update
        const update = await readJsonWithLimit(request, JSON_BODY_LIMITS.small);

        // 处理 Callback Query（按钮回调）
        if (update.callback_query) {
            const userId = update.callback_query.from.id;
            const permissionCheck = checkUserPermission(userId, config);
            if (!permissionCheck.allowed) {
                await answerCallbackQuery(update.callback_query.id, permissionCheck.reason, env, true);
                return createJsonResponse({ ok: true });
            }
            return await handleCallbackQuery(update.callback_query, env, request, requestCache);
        }

        // 处理普通消息
        if (update.message) {
            const message = update.message;
            const userId = message.from.id;
            const chatId = message.chat.id;
            const text = message.text || message.caption || '';

            // Telegram may deliver an existing private chat without a fresh command.
            // Refresh its command menu on any private-chat update so clients that
            // cached an older menu can receive the current commands and button.
            if (message.chat.type === 'private') {
                await ensureTelegramCommandMenu(
                    chatId,
                    env,
                    requestCache,
                    message.from.language_code
                );
            }

            // 检查用户权限
            const permissionCheck = checkUserPermission(userId, config);
            if (!permissionCheck.allowed) {
                await sendTelegramMessage(chatId, `❌ ${permissionCheck.reason}`, env);
                return createJsonResponse({ ok: true });
            }

            if (message.document) {
                return await handleTelegramDocumentInput(chatId, message.document, userId, env, requestCache);
            }

            if (!text) return createJsonResponse({ ok: true });

            // 处理命令或节点输入
            if (text.startsWith('/')) {
                return await handleCommand(
                    chatId,
                    text,
                    userId,
                    env,
                    request,
                    requestCache,
                    message.from.language_code
                );
            } else {
                return await handleNodeInput(chatId, text, userId, env, requestCache);
            }
        }

        // 忽略其他类型的更新
        return createJsonResponse({ ok: true });

    } catch (error) {
        console.error('[Telegram Push] Webhook handler error:', error);
        return createJsonResponse({ error: error.status === 413 ? error.message : 'Internal server error' }, error.status || 500);
    }
}
