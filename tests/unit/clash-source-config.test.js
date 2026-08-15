import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { extractClashSourceConfig } from '../../functions/modules/subscription/clash-source-config.js';
import { generateClashConfig } from '../../functions/utils/url-to-clash.js';
import { CLASH_REFERENCE_RULES } from '../../functions/modules/subscription/clash-reference-rules.js';

const NODE_URL = 'trojan://pass@1.1.1.1:443#Renamed-Node';
const SOURCE_YAML = `
proxies:
  - name: Original-Node
    type: trojan
    server: 1.1.1.1
    port: 443
    password: pass
proxy-groups:
  - name: Source Select
    type: select
    proxies:
      - Original-Node
      - DIRECT
rule-providers:
  SourceRules:
    type: http
    behavior: domain
    url: https://example.com/source-rules.yaml
rules:
  - DOMAIN-SUFFIX,example.com,DIRECT
  - RULE-SET,SourceRules,Source Select
  - MATCH,Source Select
`;

describe('upstream Clash rule preservation', () => {
    it('extracts rules, providers and policy groups from Clash YAML', () => {
        expect(extractClashSourceConfig(SOURCE_YAML)).toEqual({
            rules: [
                'DOMAIN-SUFFIX,example.com,DIRECT',
                'RULE-SET,SourceRules,Source Select',
                'MATCH,Source Select'
            ],
            'rule-providers': {
                SourceRules: {
                    type: 'http',
                    behavior: 'domain',
                    url: 'https://example.com/source-rules.yaml'
                }
            },
            'proxy-groups': [{
                name: 'Source Select',
                type: 'select',
                proxies: ['Original-Node', 'DIRECT']
            }]
        });
    });

    it('exports upstream rules without appending MiSub fallback rules', () => {
        const sourceClashConfig = extractClashSourceConfig(SOURCE_YAML);
        const config = yaml.load(generateClashConfig([NODE_URL], {
            addFlagEmoji: false,
            sourceClashConfig
        }));

        expect(config.rules).toEqual(sourceClashConfig.rules);
        expect(config['rule-providers']).toEqual(sourceClashConfig['rule-providers']);
        expect(config['rule-providers']).not.toHaveProperty('geolocation-cn');
        expect(config.rules).not.toEqual(expect.arrayContaining(CLASH_REFERENCE_RULES));
        expect(config['proxy-groups']).toEqual([{
            name: 'Source Select',
            type: 'select',
            proxies: ['Renamed-Node', 'DIRECT']
        }]);
    });

    it('uses MiSub fallback rules when the subscription has no rules', () => {
        const config = yaml.load(generateClashConfig([NODE_URL], { addFlagEmoji: false }));
        expect(config.rules.slice(-CLASH_REFERENCE_RULES.length)).toEqual(CLASH_REFERENCE_RULES);
        expect(config['rule-providers']).toHaveProperty('geolocation-cn');
    });
});
