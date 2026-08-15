import { CLASH_REFERENCE_RULES } from './clash-reference-rules.js';
import { normalizeClashSourceConfig } from './clash-source-config.js';

export const CLASH_REFERENCE_GROUP_NAMES = Object.freeze({
    select: '\u{1F680} \u8282\u70B9\u9009\u62E9',
    automatic: '\u26A1 \u81EA\u52A8\u9009\u62E9',
    private: '\u{1F3E0} \u79C1\u6709\u7F51\u7EDC',
    domestic: '\u{1F512} \u56FD\u5185\u670D\u52A1',
    nonChina: '\u{1F310} \u975E\u4E2D\u56FD',
    fallback: '\u{1F41F} \u6F0F\u7F51\u4E4B\u9C7C'
});

const REFERENCE_GROUP_NAME_SET = new Set([
    ...Object.values(CLASH_REFERENCE_GROUP_NAMES),
    '\u{1F530} \u9009\u62E9\u8282\u70B9',
    '\u{1F30F} \u7231\u5947\u827A&\u54D4\u54E9\u54D4\u54E9',
    '\u{1F4FA} \u52A8\u753B\u75AF',
    '\u{1F3AE} Steam \u767B\u5F55/\u4E0B\u8F7D',
    '\u{1F3AE} Steam \u5546\u5E97/\u793E\u533A',
    '\u{1F329}\uFE0F Cloudflare',
    '\u2601\uFE0F OneDrive',
    '\u{1F393}\u5B66\u672F\u7F51\u7AD9',
    '\u{1F1E8}\u{1F1F3} \u56FD\u5185\u7F51\u7AD9',
    '\u{1F6D1} \u62E6\u622A\u5E7F\u544A'
]);
function unique(items) {
    return [...new Set(items.filter(Boolean))];
}

const CLASH_BUILTIN_PROXY_NAMES = new Set([
    'DIRECT',
    'REJECT',
    'REJECT-DROP',
    'PASS',
    'COMPATIBLE',
    'GLOBAL'
]);

function adaptSourceProxyGroups(groups, proxies) {
    const sourceGroups = Array.isArray(groups) ? groups : [];
    const proxyNames = unique(proxies.map(proxy => proxy?.name));
    const groupNames = new Set(sourceGroups.map(group => group?.name).filter(Boolean));

    return sourceGroups.map(group => {
        const members = Array.isArray(group.proxies) ? group.proxies : null;
        if (!members) return { ...group };

        let insertedCurrentProxies = false;
        const nextMembers = [];
        for (const member of members) {
            if (groupNames.has(member) || CLASH_BUILTIN_PROXY_NAMES.has(member)) {
                nextMembers.push(member);
                continue;
            }
            if (!insertedCurrentProxies) {
                nextMembers.push(...proxyNames);
                insertedCurrentProxies = true;
            }
        }

        return {
            ...group,
            proxies: unique(nextMembers)
        };
    });
}

function createGeoxUrls() {
    return {
        geoip: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat',
        geosite: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat',
        mmdb: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country.mmdb',
        asn: 'https://github.com/xishang0128/geoip/releases/download/latest/GeoLite2-ASN.mmdb'
    };
}

function createRuleProviders() {
    const baseUrl = 'https://gh-proxy.com/https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/';
    return {
        'geolocation-cn': {
            type: 'http',
            format: 'mrs',
            behavior: 'domain',
            url: baseUrl + 'geosite/geolocation-cn.mrs',
            path: './ruleset/geolocation-cn.mrs',
            interval: 86400
        },
        cn: {
            type: 'http',
            format: 'mrs',
            behavior: 'domain',
            url: baseUrl + 'geosite/cn.mrs',
            path: './ruleset/cn.mrs',
            interval: 86400
        },
        'geolocation-!cn': {
            type: 'http',
            format: 'mrs',
            behavior: 'domain',
            url: baseUrl + 'geosite/geolocation-!cn.mrs',
            path: './ruleset/geolocation-!cn.mrs',
            interval: 86400
        },
        'private-ip': {
            type: 'http',
            format: 'mrs',
            behavior: 'ipcidr',
            url: baseUrl + 'geoip/private.mrs',
            path: './ruleset/private-ip.mrs',
            interval: 86400
        },
        'cn-ip': {
            type: 'http',
            format: 'mrs',
            behavior: 'ipcidr',
            url: baseUrl + 'geoip/cn.mrs',
            path: './ruleset/cn-ip.mrs',
            interval: 86400
        }
    };
}

function createDnsConfig() {
    const domesticNameservers = [
        'https://120.53.53.53/dns-query',
        'https://223.5.5.5/dns-query'
    ];
    return {
        enable: true,
        ipv6: true,
        'respect-rules': true,
        'enhanced-mode': 'fake-ip',
        nameserver: [...domesticNameservers],
        'proxy-server-nameserver': [...domesticNameservers],
        'nameserver-policy': {
            'geosite:cn,private': [...domesticNameservers],
            'geosite:geolocation-!cn': [
                'https://dns.cloudflare.com/dns-query',
                'https://dns.google/dns-query'
            ]
        }
    };
}

export function createClashReferenceProxyGroups(proxies = []) {
    const allNames = unique((Array.isArray(proxies) ? proxies : []).map(proxy => proxy?.name));
    const group = CLASH_REFERENCE_GROUP_NAMES;
    const selectable = [...allNames, 'DIRECT', 'REJECT'];

    return [
        {
            name: group.select,
            type: 'select',
            proxies: unique([group.automatic, ...selectable])
        },
        {
            name: group.automatic,
            type: 'url-test',
            proxies: allNames,
            url: 'https://www.gstatic.com/generate_204',
            interval: 300,
            lazy: false
        },
        {
            name: group.private,
            type: 'select',
            proxies: unique(['DIRECT', group.select, ...allNames, 'REJECT'])
        },
        {
            name: group.domestic,
            type: 'select',
            proxies: unique(['DIRECT', group.select, ...allNames, 'REJECT'])
        },
        {
            name: group.nonChina,
            type: 'select',
            proxies: unique([group.select, ...selectable])
        },
        {
            name: group.fallback,
            type: 'select',
            proxies: unique([group.select, ...selectable])
        }
    ];
}

export function applyClashReferencePolicy(config = {}, options = {}) {
    const proxies = Array.isArray(config.proxies) ? config.proxies : [];
    if (proxies.length === 0) return config;

    const sourceConfig = normalizeClashSourceConfig(options.sourceClashConfig);
    if (sourceConfig) {
        const sourceGroups = adaptSourceProxyGroups(sourceConfig['proxy-groups'], proxies);
        const existingGroups = Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : [];
        const sourceProviders = sourceConfig['rule-providers'];

        return {
            ...config,
            port: 7890,
            'socks-port': 7891,
            'allow-lan': false,
            mode: 'rule',
            'log-level': 'info',
            'geodata-mode': true,
            'geo-auto-update': true,
            'geodata-loader': 'standard',
            'geo-update-interval': 24,
            'geox-url': createGeoxUrls(),
            'rule-providers': Object.keys(sourceProviders).length > 0 ? sourceProviders : undefined,
            dns: createDnsConfig(),
            'proxy-groups': sourceGroups.length > 0 ? sourceGroups : existingGroups,
            rules: sourceConfig.rules
        };
    }

    const existingProviders = config['rule-providers'] && typeof config['rule-providers'] === 'object'
        && !Array.isArray(config['rule-providers'])
        ? config['rule-providers']
        : {};
    const existingGroups = Array.isArray(config['proxy-groups'])
        ? config['proxy-groups'].filter(group => !REFERENCE_GROUP_NAME_SET.has(group?.name))
        : [];
    const existingRules = Array.isArray(config.rules)
        ? config.rules.filter(rule => typeof rule !== 'string' || !/^(?:MATCH|FINAL),/i.test(rule.trim()))
        : [];

    return {
        ...config,
        port: 7890,
        'socks-port': 7891,
        'allow-lan': false,
        mode: 'rule',
        'log-level': 'info',
        'geodata-mode': true,
        'geo-auto-update': true,
        'geodata-loader': 'standard',
        'geo-update-interval': 24,
        'geox-url': createGeoxUrls(),
        'rule-providers': {
            ...existingProviders,
            ...createRuleProviders()
        },
        dns: createDnsConfig(),
        'proxy-groups': [
            ...existingGroups,
            ...createClashReferenceProxyGroups(proxies)
        ],
        rules: unique([
            ...existingRules,
            ...CLASH_REFERENCE_RULES
        ])
    };
}
