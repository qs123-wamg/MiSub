import yaml from 'js-yaml';

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function decodeBase64Text(value) {
    const compact = String(value || '').replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (compact.length <= 20 || !/^[A-Za-z0-9+/=]+$/.test(compact)) return '';

    try {
        const padded = compact + '='.repeat((4 - compact.length % 4) % 4);
        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        return new TextDecoder('utf-8').decode(bytes);
    } catch {
        return '';
    }
}

export function normalizeClashSourceConfig(value) {
    if (!isPlainObject(value)) return null;

    const rules = Array.isArray(value.rules)
        ? value.rules.filter(rule => typeof rule === 'string' && rule.trim())
        : [];
    if (rules.length === 0) return null;

    const ruleProviders = isPlainObject(value['rule-providers'])
        ? value['rule-providers']
        : (isPlainObject(value.ruleProviders) ? value.ruleProviders : {});
    const proxyGroups = Array.isArray(value['proxy-groups'])
        ? value['proxy-groups'].filter(isPlainObject)
        : (Array.isArray(value.proxyGroups) ? value.proxyGroups.filter(isPlainObject) : []);

    return {
        rules,
        'rule-providers': ruleProviders,
        'proxy-groups': proxyGroups
    };
}

export function mergeClashSourceConfigs(configs = []) {
    const normalized = configs.map(normalizeClashSourceConfig).filter(Boolean);
    if (normalized.length === 0) return null;

    const providers = {};
    const groups = [];
    const rules = [];
    const seenGroups = new Set();
    const seenRules = new Set();

    for (const config of normalized) {
        Object.entries(config['rule-providers']).forEach(([name, provider]) => {
            if (!(name in providers)) providers[name] = provider;
        });
        config['proxy-groups'].forEach(group => {
            const key = String(group?.name || '');
            if (key && !seenGroups.has(key)) {
                seenGroups.add(key);
                groups.push(group);
            }
        });
        config.rules.forEach(rule => {
            if (!seenRules.has(rule)) {
                seenRules.add(rule);
                rules.push(rule);
            }
        });
    }

    return {
        rules,
        'rule-providers': providers,
        'proxy-groups': groups
    };
}

/**
 * Extract the rule-bearing portion of an upstream Clash YAML subscription.
 * Node-only subscriptions intentionally return null so exporters use MiSub's fallback rules.
 */
export function extractClashSourceConfig(content) {
    const raw = String(content || '').trim();
    if (!raw) return null;

    const candidates = [raw];
    const decoded = decodeBase64Text(raw);
    if (decoded && decoded !== raw) candidates.push(decoded);

    for (const candidate of candidates) {
        try {
            const parsed = yaml.load(candidate);
            const normalized = normalizeClashSourceConfig(parsed);
            if (normalized) return normalized;
        } catch {
            // Other subscription formats are expected here.
        }
    }

    return null;
}
