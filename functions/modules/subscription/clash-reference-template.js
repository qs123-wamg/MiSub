import { CLASH_REFERENCE_RULES } from './clash-reference-rules.js';

export const CLASH_REFERENCE_GROUP_NAMES = Object.freeze({
    select: '\u{1F530} \u9009\u62E9\u8282\u70B9',
    bilibili: '\u{1F30F} \u7231\u5947\u827A&\u54D4\u54E9\u54D4\u54E9',
    bahamut: '\u{1F4FA} \u52A8\u753B\u75AF',
    steamDownload: '\u{1F3AE} Steam \u767B\u5F55/\u4E0B\u8F7D',
    steamStore: '\u{1F3AE} Steam \u5546\u5E97/\u793E\u533A',
    cloudflare: '\u{1F329}\uFE0F Cloudflare',
    onedrive: '\u2601\uFE0F OneDrive',
    academic: '\u{1F393}\u5B66\u672F\u7F51\u7AD9',
    domestic: '\u{1F1E8}\u{1F1F3} \u56FD\u5185\u7F51\u7AD9',
    rejectAds: '\u{1F6D1} \u62E6\u622A\u5E7F\u544A',
    fallback: '\u{1F41F} \u6F0F\u7F51\u4E4B\u9C7C'
});

const REFERENCE_GROUP_NAME_SET = new Set(Object.values(CLASH_REFERENCE_GROUP_NAMES));

function unique(items) {
    return [...new Set(items.filter(Boolean))];
}

function getSearchableProxyText(proxy) {
    const metadata = proxy?.metadata && typeof proxy.metadata === 'object'
        ? Object.values(proxy.metadata).join(' ')
        : '';
    return String(proxy?.name || '') + ' ' + metadata;
}

function selectProxyNames(proxies, patterns) {
    return proxies
        .filter(proxy => {
            const text = getSearchableProxyText(proxy);
            return patterns.some(pattern => pattern.test(text));
        })
        .map(proxy => proxy.name)
        .filter(Boolean);
}

export function createClashReferenceProxyGroups(proxies = [], fallbackTargets = []) {
    const safeProxies = Array.isArray(proxies) ? proxies : [];
    const allNames = unique(safeProxies.map(proxy => proxy?.name));
    const hkAndTwNames = selectProxyNames(safeProxies, [
        /\u9999\u6E2F|hong kong/i,
        /\u53F0\u6E7E|\u53F0\u7063|taiwan/i
    ]);
    const taiwanNames = selectProxyNames(safeProxies, [
        /\u53F0\u6E7E|\u53F0\u7063|taiwan/i
    ]);
    const steamRegionNames = selectProxyNames(safeProxies, [
        /\u963F\u6839\u5EF7|argentina/i,
        /\u4FC4\u7F57\u65AF|\u4FC4\u7F85\u65AF|russia/i,
        /\u571F\u8033\u5176|turkey|t\u00fcrkiye/i,
        /\u5370\u5EA6|india/i
    ]);
    const onedriveNames = selectProxyNames(safeProxies, [
        /\u65E5\u672C|japan/i,
        /\u65B0\u52A0\u5761|singapore/i,
        /\u53F0\u6E7E|\u53F0\u7063|taiwan/i,
        /\u7F8E\u56FD|\u7F8E\u570B|united states|usa/i,
        /\u82F1\u56FD|\u82F1\u570B|united kingdom|uk/i,
        /\u52A0\u62FF\u5927|canada/i,
        /\u6FB3\u5927\u5229\u4E9A|\u6FB3\u5927\u5229\u4E9E|\u6FB3\u6D32|australia/i,
        /\u6CD5\u56FD|\u6CD5\u570B|france/i,
        /\u4E4C\u514B\u5170|\u70CF\u514B\u862D|ukraine/i
    ]);
    const group = CLASH_REFERENCE_GROUP_NAMES;

    return [
        { name: group.select, type: 'select', proxies: unique([...allNames, 'DIRECT']) },
        { name: group.bilibili, type: 'select', proxies: unique(['DIRECT', ...hkAndTwNames, group.select]) },
        { name: group.bahamut, type: 'select', proxies: unique([group.select, ...taiwanNames, 'DIRECT']) },
        { name: group.steamDownload, type: 'select', proxies: unique(['DIRECT', group.select, ...steamRegionNames]) },
        { name: group.steamStore, type: 'select', proxies: unique([group.select, ...steamRegionNames, 'DIRECT']) },
        { name: group.cloudflare, type: 'select', proxies: [group.select, 'DIRECT'] },
        { name: group.onedrive, type: 'select', proxies: unique([group.select, 'DIRECT', ...onedriveNames]) },
        { name: group.academic, type: 'select', proxies: ['DIRECT', group.select] },
        { name: group.domestic, type: 'select', proxies: ['DIRECT', group.select] },
        { name: group.rejectAds, type: 'select', proxies: ['REJECT', 'DIRECT', group.select] },
        { name: group.fallback, type: 'select', proxies: unique([...fallbackTargets, group.select, 'DIRECT']) }
    ];
}

function isTerminalRule(rule) {
    return typeof rule === 'string' && /^(?:MATCH|FINAL),/i.test(rule.trim());
}

export function applyClashReferencePolicy(config = {}) {
    const proxies = Array.isArray(config.proxies) ? config.proxies : [];
    if (proxies.length === 0) return config;

    const existingGroups = Array.isArray(config['proxy-groups'])
        ? config['proxy-groups'].filter(group => !REFERENCE_GROUP_NAME_SET.has(group?.name))
        : [];
    const existingRules = Array.isArray(config.rules) ? config.rules : [];
    const existingNonTerminalRules = existingRules.filter(rule => !isTerminalRule(rule));
    const fallbackTargets = existingRules
        .filter(isTerminalRule)
        .map(rule => String(rule).split(',')[1]?.trim())
        .filter(Boolean);

    return {
        ...config,
        'proxy-groups': [
            ...existingGroups,
            ...createClashReferenceProxyGroups(proxies, fallbackTargets)
        ],
        rules: [
            ...existingNonTerminalRules,
            ...CLASH_REFERENCE_RULES
        ]
    };
}
