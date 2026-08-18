import { beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';
import { CLASH_REFERENCE_GROUP_NAMES } from '../../functions/modules/subscription/clash-reference-template.js';
import { CLASH_REFERENCE_RULES } from '../../functions/modules/subscription/clash-reference-rules.js';

const createAdapter = vi.fn();
const getStorageType = vi.fn();
const clearAllNodeCaches = vi.fn();

vi.mock('../../functions/storage-adapter.js', () => ({
  StorageFactory: {
    createAdapter: (...args) => createAdapter(...args),
    getStorageType: (...args) => getStorageType(...args)
  }
}));

vi.mock('../../functions/services/node-cache-service.js', () => ({
  clearAllNodeCaches: (...args) => clearAllNodeCaches(...args)
}));

vi.mock('../../functions/modules/utils.js', () => ({
  createJsonResponse: (data, status = 200) => new Response(JSON.stringify(data), { status }),
  createTimeoutFetch: (input, init) => fetch(input, init),
  JSON_BODY_LIMITS: { auth: 16 * 1024, small: 128 * 1024, normal: 1024 * 1024, large: 5 * 1024 * 1024 },
  readJsonWithLimit: async request => request.json(),
  escapeHtml: (value = '') => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}));

function createState(overrides = {}) {
  const state = {
    settings: {
      telegram_push_config: {
        enabled: true,
        bot_token: 'bot-token',
        webhook_secret: 'secret-token',
        allowed_user_ids: ['1', '2'],
        auto_bind: true,
        user_bindings: {}
      }
    },
    subscriptions: [],
    misc: {},
    profiles: [
      { id: 'profile-1', name: 'Profile One', subscriptions: [], manualNodes: [] },
      { id: 'profile-2', name: 'Profile Two', subscriptions: [], manualNodes: [] }
    ],
    ...overrides
  };

  return {
    state,
    adapter: {
      get: vi.fn(async key => (
        key.startsWith('tg_subscription_preview:') || key.startsWith('node_cache_subscription_')
          ? state.misc[key] || null
          : state.settings
      )),
      put: vi.fn(async (key, value) => {
        if (key.startsWith('tg_subscription_preview:') || key.startsWith('node_cache_subscription_')) state.misc[key] = value;
        else state.settings = value;
        return true;
      }),
      delete: vi.fn(async key => {
        delete state.misc[key];
        return true;
      }),
      getAllSubscriptions: vi.fn(async () => state.subscriptions),
      putAllSubscriptions: vi.fn(async value => {
        state.subscriptions = value;
        return true;
      }),
      getAllProfiles: vi.fn(async () => state.profiles),
      putAllProfiles: vi.fn(async value => {
        state.profiles = value;
        return true;
      })
    }
  };
}

function createRequest(update, secret = 'secret-token') {
  return new Request('https://example.com/api/telegram/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret
    },
    body: JSON.stringify(update)
  });
}

function encodeUtf16Le(value) {
  const bytes = new Uint8Array(2 + value.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    bytes[2 + index * 2] = code & 0xff;
    bytes[3 + index * 2] = code >> 8;
  }
  return bytes;
}

function encodeBase64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe('handleTelegramWebhook', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getStorageType.mockResolvedValue('d1');
    clearAllNodeCaches.mockResolvedValue({ cleared: 1, failed: 0 });
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  it('rejects webhook requests when secret is missing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { state, adapter } = createState({
      settings: {
        telegram_push_config: {
          enabled: true,
          bot_token: 'bot-token',
          webhook_secret: '',
          allowed_user_ids: ['1']
        }
      }
    });
    createAdapter.mockReturnValue(adapter);

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    try {
      const response = await handleTelegramWebhook(createRequest({
        message: {
          text: '/start',
          chat: { id: 1001 },
          from: { id: 1 }
        }
      }, ''), { MISUB_KV: null });

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Webhook secret required' });
      expect(errorSpy).toHaveBeenCalledWith('[Telegram Push] Missing webhook secret');
      expect(global.fetch).not.toHaveBeenCalled();
      expect(state.settings.telegram_push_config.webhook_secret).toBe('');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('denies access by default when whitelist is empty', async () => {
    const { adapter } = createState({
      settings: {
        telegram_push_config: {
          enabled: true,
          bot_token: 'bot-token',
          webhook_secret: 'secret-token',
          allowed_user_ids: [],
          allow_all_users: false
        }
      }
    });
    createAdapter.mockReturnValue(adapter);

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    const response = await handleTelegramWebhook(createRequest({
      message: {
        text: '/start',
        chat: { id: 1001 },
        from: { id: 123456 }
      }
    }), { MISUB_KV: null });

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.chat_id).toBe(1001);
    expect(body.text).toContain('未配置白名单');
  });

  it('stores bindings per telegram user and auto-binds imports to the correct profile', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');

    try {
      await handleTelegramWebhook(createRequest({
        message: {
          text: '/bind 1',
          chat: { id: 2001 },
          from: { id: 1 }
        }
      }), { MISUB_KV: null });

      await handleTelegramWebhook(createRequest({
        message: {
          text: '/bind 2',
          chat: { id: 2002 },
          from: { id: 2 }
        }
      }), { MISUB_KV: null });

      await handleTelegramWebhook(createRequest({
        message: {
          text: 'ss://YWVzLTI1Ni1nY206cGFzc0BleGFtcGxlLmNvbTo0NDM=#Node-A',
          chat: { id: 2001 },
          from: { id: 1 }
        }
      }), { MISUB_KV: null });

      expect(state.subscriptions).toHaveLength(0);
      const previewBody = global.fetch.mock.calls
        .filter(([url]) => String(url).includes('/sendMessage'))
        .map(([, options]) => JSON.parse(options.body))
        .at(-1);
      const saveCallback = previewBody.reply_markup.inline_keyboard.flat()
        .find(button => button.callback_data.startsWith('sp_save_')).callback_data;
      await handleTelegramWebhook(createRequest({
        callback_query: {
          id: 'save-bound-single-node',
          data: saveCallback,
          from: { id: 1 },
          message: { message_id: 80, chat: { id: 2001 } }
        }
      }), { MISUB_KV: null });

      expect(state.settings.telegram_push_config.user_bindings).toEqual({
        '1': 'profile-1',
        '2': 'profile-2'
      });
      expect(state.subscriptions).toHaveLength(1);
      expect(state.profiles[0].manualNodes).toEqual([state.subscriptions[0].id]);
      expect(state.profiles[1].manualNodes).toEqual([]);
      expect(clearAllNodeCaches).toHaveBeenCalledTimes(1);
      expect(clearAllNodeCaches).toHaveBeenCalledWith(adapter, { preserveSubscriptionCaches: true });
      expect(infoSpy).not.toHaveBeenCalledWith('[Telegram Push] User 1 added 1 items (Ignored 0)');
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('renders a rich subscription preview and saves the source only after callback', async () => {
    const subscriptionUrl = 'https://sub.example.com/api/subscribe?token=test-token';
    const nodeUrl = 'vless://00000000-0000-4000-8000-000000000001@node.example.com:443?security=tls#Test-Node';
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (url === subscriptionUrl) {
        return new Response(btoa(`${nodeUrl}\n`), {
          status: 200,
          headers: {
            'Content-Disposition': 'attachment; filename=Demo-Airport.yaml',
            'subscription-userinfo': 'upload=1073741824; download=2147483648; total=107374182400; expire=1798003810'
          }
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: `我的订阅：${subscriptionUrl}`,
        chat: { id: 2101 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    expect(global.fetch).toHaveBeenCalledWith(subscriptionUrl, expect.objectContaining({
      method: 'GET',
      redirect: 'manual',
      headers: expect.objectContaining({ 'User-Agent': expect.stringContaining('Mozilla/5.0') })
    }));

    const telegramBodies = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body));
    const card = telegramBodies.at(-1);
    expect(card.text).toContain('机场名称:');
    expect(card.text).toContain('Demo-Airport');
    expect(card.text).toContain('节点总数: 1');
    expect(card.text).not.toContain('<b>');
    expect(card.text).toContain('📊 流量详情: 3GB / 100GB 🟢 流量充足');
    expect(card.text).toMatch(/使用进度: [▰▱]{10} 3\.0%/);
    expect(card.text).toMatch(/🗓️ 过期时间: .* 🟢 正常/);
    expect(card.text).toContain('Test-Node');
    expect(card.text).toContain(`<code>${subscriptionUrl}</code>`);
    expect(card.text).not.toContain('<a href=');
    expect(card.reply_markup.inline_keyboard).toHaveLength(3);

    const saveCallback = card.reply_markup.inline_keyboard.flat()
      .find(button => button.callback_data.startsWith('sp_save_')).callback_data;
    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'preview-save-callback',
        data: saveCallback,
        from: { id: 1 },
        message: { message_id: 99, chat: { id: 2101 } }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions[0]).toMatchObject({
      name: 'Demo-Airport',
      url: subscriptionUrl,
      source: 'telegram',
      telegram_user_id: 1,
      nodeCount: 1,
      customUserAgent: expect.stringContaining('Mozilla/5.0')
    });

    const yamlCallback = card.reply_markup.inline_keyboard.flat()
      .find(button => button.callback_data.startsWith('sp_yaml_')).callback_data;
    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'preview-yaml-callback',
        data: yamlCallback,
        from: { id: 1 },
        message: { message_id: 99, chat: { id: 2101 } }
      }
    }), { MISUB_KV: null });
    const documentCall = global.fetch.mock.calls.find(([url]) => String(url).includes('/sendDocument'));
    expect(documentCall).toBeTruthy();
    expect(documentCall[1].body.get('document').name).toMatch(/\.yaml$/);
    const exportedConfig = yaml.load(await documentCall[1].body.get('document').text());
    expect(exportedConfig).toMatchObject({ port: 7890, 'socks-port': 7891, mode: 'rule' });
    expect(exportedConfig.proxies).toHaveLength(1);
    expect(exportedConfig['proxy-groups'][0].proxies).toContain(exportedConfig.proxies[0].name);
    const fallbackGroup = exportedConfig['proxy-groups'].find(
      group => group.name === CLASH_REFERENCE_GROUP_NAMES.fallback
    );
    expect(fallbackGroup.proxies[0]).toBe(CLASH_REFERENCE_GROUP_NAMES.select);
    expect(exportedConfig.rules.slice(-CLASH_REFERENCE_RULES.length)).toEqual(CLASH_REFERENCE_RULES);

    const linkCallback = card.reply_markup.inline_keyboard.flat()
      .find(button => button.callback_data.startsWith('sp_link_')).callback_data;
    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'preview-link-callback',
        data: linkCallback,
        from: { id: 1 },
        message: { message_id: 99, chat: { id: 2101 } }
      }
    }), { MISUB_KV: null });
    expect(state.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'Demo-Airport',
        subscriptions: [state.subscriptions[0].id],
        telegramPreviewSubscriptionId: state.subscriptions[0].id
      })
    ]));
    const sentBodies = global.fetch.mock.calls
      .filter(([url], index) => String(url).includes('/sendMessage') && global.fetch.mock.calls[index][1]?.body)
      .map(([, options]) => JSON.parse(options.body));
    expect(sentBodies.some(body => body.text?.includes('https://example.com/profiles/tg-'))).toBe(true);
  });

  it.each([
    [80, '🟠 流量不足'],
    [100, '🔴 流量耗尽']
  ])('marks %i%% subscription usage as %s', async (used, expectedStatus) => {
    const subscriptionUrl = `https://sub.example.com/traffic-status-${used}`;
    const nodeUrl = `vless://00000000-0000-4000-8000-000000000005@node${used}.example.com:443?security=tls#Traffic-${used}`;
    const { adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (url === subscriptionUrl) {
        return new Response(btoa(`${nodeUrl}\n`), {
          status: 200,
          headers: {
            'Content-Disposition': `attachment; filename=Traffic-${used}.yaml`,
            'subscription-userinfo': `upload=${used}; download=0; total=100; expire=4102444800`
          }
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: subscriptionUrl,
        chat: { id: 2104 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    const card = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(card.text).toContain(`📊 流量详情: ${used}B / 100B ${expectedStatus}`);
  });

  it.each([
    [31, '🟢 正常'],
    [10, '🟠 临近到期'],
    [2, '🔴 即将到期'],
    [-1, '🔴 已过期']
  ])('marks a subscription expiring in %i days as %s', async (days, expectedStatus) => {
    const subscriptionUrl = `https://sub.example.com/expiry-status-${days}`;
    const nodeUrl = `vless://00000000-0000-4000-8000-000000000006@expiry${days}.example.com:443?security=tls#Expiry-${days}`;
    const { adapter } = createState();
    createAdapter.mockReturnValue(adapter);
    const expire = Math.floor(Date.now() / 1000) + days * 86400;

    global.fetch = vi.fn(async url => {
      if (url === subscriptionUrl) {
        return new Response(btoa(`${nodeUrl}\n`), {
          status: 200,
          headers: {
            'Content-Disposition': `attachment; filename=Expiry-${days}.yaml`,
            'subscription-userinfo': `upload=10; download=0; total=100; expire=${expire}`
          }
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: subscriptionUrl,
        chat: { id: 2105 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    const card = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(card.text).toMatch(new RegExp(`🗓️ 过期时间: .* ${expectedStatus}$`, 'm'));
  });

  it('keeps unknown traffic and long-term expiry visible when subscription metadata is missing', async () => {
    const subscriptionUrl = 'https://sub.example.com/without-metadata';
    const nodeUrl = 'vless://00000000-0000-4000-8000-000000000004@node.example.com:443?security=tls#No-Metadata';
    const { adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (url === subscriptionUrl) {
        return new Response(btoa(`${nodeUrl}\n`), {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename=No-Metadata.yaml' }
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: subscriptionUrl,
        chat: { id: 2103 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    const card = JSON.parse(global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .at(-1)[1].body);
    expect(card.text).toContain('📊 流量详情: 未知');
    expect(card.text).toContain('🗓️ 过期时间: 长期有效');
    expect(card.text).toContain('🗓️ 过期时间: 长期有效 🟢 正常');
    expect(card.text).not.toContain('🟢 流量充足');
    expect(card.text).not.toContain('🟠 流量不足');
    expect(card.text).not.toContain('🔴 流量耗尽');
    expect(card.text).not.toContain('📈 使用进度:');
    expect(card.text).not.toContain('💵 剩余可用:');
    expect(card.text).not.toContain('⌛ 剩余时间:');
  });

  it('sends a summary and one TXT report when more than five subscription URLs are provided', async () => {
    const urls = Array.from({ length: 6 }, (_, index) => `https://sub.example.com/batch-${index + 1}`);
    const validNode = 'trojan://password@valid.example.com:443?security=tls#Valid-Node';
    const depletedNode = 'vless://00000000-0000-4000-8000-000000000002@depleted.example.com:443?security=tls#Depleted-Node';
    const expiredNode = 'vmess://eyJhZGQiOiJleHBpcmVkLmV4YW1wbGUuY29tIiwicG9ydCI6IjQ0MyIsImlkIjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAzIiwibmFtZSI6IkV4cGlyZWQtTm9kZSIsInBhdGgiOiIiLCJ0eXBlIjoibm9uZSIsInZhaWQiOjAsImhvc3QiOiIiLCJ0bHMiOiJ0bHMifQ==';
    const unsupportedNode = 'ss://cmM0LW1kNTpwYXNzd29yZA==@legacy.example.com:443#Legacy-Node';
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      const value = String(url);
      const index = urls.indexOf(value);
      if (index === 0) {
        return new Response(btoa(`${validNode}\n`), {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename=Valid.yaml' }
        });
      }
      if (index === 1) {
        return new Response(btoa(`${depletedNode}\n`), {
          status: 200,
          headers: {
            'Content-Disposition': 'attachment; filename=Depleted.yaml',
            'subscription-userinfo': 'upload=100; download=0; total=100; expire=4102444800'
          }
        });
      }
      if (index === 2) {
        return new Response(btoa(`${expiredNode}\n`), {
          status: 200,
          headers: {
            'Content-Disposition': 'attachment; filename=Expired.yaml',
            'subscription-userinfo': 'upload=0; download=0; total=100; expire=1'
          }
        });
      }
      if (index === 3) {
        return new Response(btoa(`${unsupportedNode}\n`), {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename=Unsupported.txt' }
        });
      }
      if (index >= 4) return new Response('upstream error', { status: 503 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: urls.join('\n'),
        chat: { id: 2110 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    const messageBodies = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body));
    expect(messageBodies[0].text).toContain('检测到 6 条链接，超过阈值，结果将以文件形式发送');
    expect(messageBodies[1].text).toBe('查询统计: 有效: 1 | 耗尽: 1 | 过期: 1 | 失效: 3');

    const documentCall = global.fetch.mock.calls.find(([url]) => String(url).includes('/sendDocument'));
    expect(documentCall).toBeTruthy();
    expect(documentCall[1].body.get('document').name).toBe('subscription-batch-results.txt');
    const report = await documentCall[1].body.get('document').text();
    expect(report).toContain('链接总数: 6');
    expect(report).toContain('查询统计: 有效: 1 | 耗尽: 1 | 过期: 1 | 失效: 3');
    expect(report).toContain(`订阅链接: ${urls[0]}`);
    expect(report).toContain('流量详情: 未知');
    expect(report).toContain('过期时间: 长期有效');
    expect(report).toContain(validNode);
    expect(report).toContain('状态: 耗尽');
    expect(report).toContain('流量详情: 100B / 100B 🔴 流量耗尽');
    expect(report).toContain('状态: 过期');
    expect(report).toMatch(/过期时间: .* 🔴 已过期/);
    expect(report).toContain('状态: 失效');
    expect(report).toContain('失败原因: 内容解析阶段失败：未识别到可用节点');
    expect(report).not.toContain(unsupportedNode);
  });

  it('renders traffic metadata embedded in a Base64 subscription node fragment', async () => {
    const subscriptionUrl = 'https://sub.example.com/content-userinfo';
    const nodeUrl = 'vless://00000000-0000-4000-8000-000000000010@node.example.com:443?security=tls#Test-Node';
    const metadataNode = `${nodeUrl.split('#')[0]}#${encodeURIComponent('Test-Node | 剩余流量：400.5 GB | 距离下次重置剩余：14 天 | 套餐到期：2027-03-23')}`;
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (url === subscriptionUrl) {
        return new Response(encodeBase64Utf8(`${metadataNode}\n`), {
          status: 200,
          headers: {
            'Content-Type': 'text/html'
          }
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: subscriptionUrl,
        chat: { id: 2111 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    const card = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(card.text).toContain('流量详情: 剩余 400.5GB');
    expect(card.text).toContain('使用进度: 未知');
    expect(card.text).toContain('剩余可用: 400.5GB');
    expect(card.text).toContain('过期时间: 2027-03-23');
    expect(card.text).toContain('剩余时间:');
    expect(card.text).toContain('下次重置: 14天');
    expect(card.text).toContain('节点总数: 1');
    expect(card.text).not.toContain('<b>');
  });

  it('shows up to 50 subscription preview nodes and preserves the hidden-node count', async () => {
    const subscriptionUrl = 'https://sub.example.com/fifty-node-preview';
    const nodeUrls = Array.from({ length: 55 }, (_, index) => (
      `trojan://p@n${index + 1}.example.com:443#N${String(index + 1).padStart(2, '0')}`
    ));
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (url === subscriptionUrl) {
        return new Response(encodeBase64Utf8(`${nodeUrls.join('\n')}\n`), {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename=Fifty-Node-Airport.yaml' }
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: subscriptionUrl,
        chat: { id: 2102 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    const card = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(card.text).toContain('节点列表 (共 55 个)');
    expect(card.text).not.toContain('<b>节点列表 (共 55 个)</b>');
    expect(card.text).toContain('N50');
    expect(card.text).not.toContain('<b>- 🌍 trojan: N50</b>');
    expect(card.text).not.toContain('N51');
    expect(card.text).toContain('5 个更多节点未显示');
  });

  it('permanently stores an unsaved parsed subscription preview', async () => {
    const subscriptionUrl = 'https://sub.example.com/permanent-preview';
    const nodeUrl = 'trojan://password@permanent.example.com:443?security=tls#Permanent-Node';
    const { state, adapter } = createState();
    const kvData = new Map();
    const kv = {
      get: vi.fn(async key => kvData.get(key) || null),
      put: vi.fn(async (key, value) => {
        kvData.set(key, value);
      }),
      delete: vi.fn(async key => kvData.delete(key))
    };
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (url === subscriptionUrl) {
        return new Response(btoa(`${nodeUrl}\n`), {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename=Permanent.yaml' }
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: subscriptionUrl,
        chat: { id: 2108 },
        from: { id: 1 }
      }
    }), { MISUB_KV: kv });

    expect(state.subscriptions).toHaveLength(0);
    const previewWrite = kv.put.mock.calls.find(([key]) => key.startsWith('tg_subscription_preview:'));
    expect(previewWrite).toHaveLength(2);
    expect(JSON.parse(previewWrite[1])).toMatchObject({
      sourceUrl: subscriptionUrl,
      name: 'Permanent',
      nodeUrls: [nodeUrl],
      savedSubscriptionId: null
    });
    expect(JSON.parse(previewWrite[1])).not.toHaveProperty('expiresAt');
  });

  it('explains that an HTML webpage is not subscription data', async () => {
    const webpageUrl = 'https://zip0.com/';
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (url === webpageUrl) {
        return new Response('<!doctype html><html><head><title>ZIP0</title></head><body>Home</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=UTF-8' }
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: webpageUrl,
        chat: { id: 2112 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    const body = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(body.text).toBe(
      '❌ 无法解析订阅内容：\n\n' +
      '⚠️ 该链接返回的是网页内容（HTML），不是订阅数据。' +
      '请确认订阅链接是否完整（通常包含 /api/ 或 token= 等参数）。'
    );
  });

  it('rejects private-network subscription URLs sent as plain messages', async () => {
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: 'http://127.0.0.1/subscription',
        chat: { id: 2102 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(String(global.fetch.mock.calls[0][0])).toContain('api.telegram.org');
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.text).toContain('订阅解析失败');
    expect(body.text).toContain('地址校验阶段失败');
    expect(body.text).toContain('订阅地址无效或不安全');
  });
  it('previews a single node parsed from Base64 and saves it only after callback', async () => {
    const nodeUrl = 'trojan://password@node.example.com:443?security=tls#Base64-Node';
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: btoa(`${nodeUrl}\n`),
        chat: { id: 2102 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.text).toContain('机场名称:');
    expect(body.text).toContain('Base64-Node');
    expect(body.text).toContain('来源类型:</b> 节点链接');

    const saveCallback = body.reply_markup.inline_keyboard.flat()
      .find(button => button.callback_data.startsWith('sp_save_')).callback_data;
    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'save-base64-single-node',
        data: saveCallback,
        from: { id: 1 },
        message: { message_id: 81, chat: { id: 2102 } }
      }
    }), { MISUB_KV: null });
    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions[0].url).toBe(nodeUrl);
  });
  it('renders a detailed single-node card and supports its preview actions', async () => {
    const nodeUrl = 'vless://77777777-6666-8888-841f-1fe01760d842@awsjp.5671234.xyz:443?encryption=none&security=tls&sni=xray4.5671234.xyz&fp=chrome&insecure=0&allowInsecure=0&type=ws&host=xray4.5671234.xyz&path=%2F%3Fed%3D2560#Aws%20JP';
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: nodeUrl,
        chat: { id: 2102 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const card = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(card.text).toContain('机场名称:</b> <code>Aws JP</code>');
    expect(card.text).toContain('来源类型:</b> 节点链接');
    expect(card.text).toContain('流量详情:</b> 未知');
    expect(card.text).toContain('过期时间:</b> 长期有效');
    expect(card.text).toContain('- name: Aws JP');
    expect(card.text).toContain('server: awsjp.5671234.xyz');
    expect(card.text).toContain('port: 443');
    expect(card.text).toContain('type: vless');
    expect(card.text).toContain('uuid: 77777777-6666-8888-841f-1fe01760d842');
    expect(card.text).toContain('tls: true');
    expect(card.text).toContain('network: ws');
    expect(card.text).toContain('servername: xray4.5671234.xyz');
    expect(card.text).toContain('client-fingerprint: chrome');
    expect(card.text).toContain('ws-opts:');
    expect(card.text).toContain('path: /?ed=2560');
    expect(card.text).toContain('headers:');
    expect(card.text).toContain('Host: xray4.5671234.xyz');
    expect(card.text).not.toContain('sni: xray4.5671234.xyz');

    const buttons = card.reply_markup.inline_keyboard.flat();
    expect(buttons.map(button => button.text)).toEqual([
      '🔄 刷新订阅信息',
      '📄 显示全部节点',
      '📥 导出Base64',
      '📥 导出YAML',
      '🔗 生成短链',
      '💾 保存订阅'
    ]);
    const invoke = data => handleTelegramWebhook(createRequest({
      callback_query: {
        id: `single-node-${data}`,
        data,
        from: { id: 1 },
        message: { message_id: 82, chat: { id: 2102 } }
      }
    }), { MISUB_KV: null });

    await invoke(buttons.find(button => button.callback_data.startsWith('sp_refresh_')).callback_data);
    const refreshedCard = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(refreshedCard.text).toContain('server: awsjp.5671234.xyz');

    await invoke(buttons.find(button => button.callback_data.startsWith('sp_b64_')).callback_data);
    await invoke(buttons.find(button => button.callback_data.startsWith('sp_yaml_')).callback_data);
    const documentCalls = global.fetch.mock.calls.filter(([url]) => String(url).includes('/sendDocument'));
    expect(documentCalls).toHaveLength(2);
    expect(await documentCalls[0][1].body.get('document').text()).toBe(encodeBase64Utf8(nodeUrl));
    const exportedYaml = yaml.load(await documentCalls[1][1].body.get('document').text());
    expect(exportedYaml.proxies[0]).toMatchObject({
      server: 'awsjp.5671234.xyz',
      port: 443,
      type: 'vless'
    });
    expect(exportedYaml['proxy-groups'][0].proxies).toContain(exportedYaml.proxies[0].name);

    await invoke(buttons.find(button => button.callback_data.startsWith('sp_link_')).callback_data);
    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions[0]).toMatchObject({ name: 'Aws JP', url: nodeUrl });
    expect(state.subscriptions[0]).not.toHaveProperty('nodeCount');
    expect(clearAllNodeCaches).toHaveBeenCalledWith(adapter, { preserveSubscriptionCaches: true });
    expect(state.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subscriptions: [],
        manualNodes: [state.subscriptions[0].id],
        telegramPreviewSubscriptionId: state.subscriptions[0].id
      })
    ]));
    const sentBodies = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body));
    expect(sentBodies.some(body => body.text?.includes('https://example.com/profiles/tg-'))).toBe(true);

    await invoke(buttons.find(button => button.callback_data.startsWith('sp_save_')).callback_data);
    expect(state.subscriptions).toHaveLength(1);
  });
  it('renders Reality parameters in the detailed single-node card', async () => {
    const nodeUrl = 'vless://0c4a5f22-1c3a-4ce6-bbf4-012ec67707ad@38.47.120.48:29075?encryption=none&security=reality&pbk=NjURocQ5TRu0TAnVlRaqysXb7YggSgLimV9-3FlrGo&type=tcp&sni=one-piece.com&fp=chrome&flow=xtls-rprx-vision&sid=6ba85179e30d4fc2#%E9%A6%99%E6%B8%AF-01';
    const { adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: nodeUrl,
        chat: { id: 2115 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    const card = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(card.text).toContain('- name: 香港-01');
    expect(card.text).toContain('flow: xtls-rprx-vision');
    expect(card.text).toContain('servername: one-piece.com');
    expect(card.text).toContain('client-fingerprint: chrome');
    expect(card.text).toContain('reality-opts:');
    expect(card.text).toContain('public-key: NjURocQ5TRu0TAnVlRaqysXb7YggSgLimV9-3FlrGo');
    expect(card.text).toContain('short-id: 6ba85179e30d4fc2');
    expect(card.text).not.toContain('sni: one-piece.com');
  });
  it('previews multiple direct nodes without automatically saving them', async () => {
    const nodeUrls = [
      'anytls://sub_wWhcbH2TOzZSD7xcL6CAlij-%3Aand-f45785c5d45593d4@179.255.156.42:2086/?insecure=1#%E7%BE%8E%E5%9B%BD%20%C2%B7%20AnyTLS',
      'anytls://sub_wWhcbH2TOzZSD7xcL6CAlij-%3Aand-f45785c5d45593d4@56.68.20.70:2086/?insecure=1#%E9%A9%AC%E6%9D%A5%E8%A5%BF%E4%BA%9A%20%C2%B7%20AnyTLS',
      'anytls://sub_wWhcbH2TOzZSD7xcL6CAlij-%3Aand-f45785c5d45593d4@64.90.10.212:2086/?insecure=1#%E9%A6%99%E6%B8%AF%20%C2%B7%20AnyTLS'
    ];
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: nodeUrls.join('\n'),
        chat: { id: 2114 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);

    const card = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body))
      .find(body => body.text?.includes('机场名称:'));
    expect(card).toBeTruthy();
    expect(card.text).toContain('美国 · AnyTLS');
    expect(card.text).toContain('节点总数: 3');
    expect(card.text).toContain('节点列表 (共 3 个)');
    expect(card.reply_markup.inline_keyboard.flat()).toHaveLength(6);
    expect(card.reply_markup.inline_keyboard.flat().map(button => button.text)).toContain('💾 保存订阅');
    expect(card.text).not.toContain('成功添加 1 个项目');

    const buttons = card.reply_markup.inline_keyboard.flat();
    const invoke = data => handleTelegramWebhook(createRequest({
      callback_query: {
        id: `multi-node-${data}`,
        data,
        from: { id: 1 },
        message: { message_id: 110, chat: { id: 2114 } }
      }
    }), { MISUB_KV: null });

    await invoke(buttons.find(button => button.callback_data.startsWith('sp_refresh_')).callback_data);
    expect(state.subscriptions).toHaveLength(0);
    const refreshedCard = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(refreshedCard.text).toContain('节点总数: 3');
    expect(refreshedCard.reply_markup.inline_keyboard.flat().map(button => button.text))
      .toContain('💾 保存订阅');

    await invoke(buttons.find(button => button.callback_data.startsWith('sp_save_')).callback_data);
    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions[0]).toMatchObject({
      type: 'inline',
      name: '美国 · AnyTLS',
      nodeUrls,
      nodeCount: 3
    });
  });
  it('downloads and imports supported Telegram text documents', async () => {
    const firstNode = 'vless://00000000-0000-4000-8000-000000000011@th.example.com:443?remarks=%E6%B3%B0%E5%9B%BDTH&security=tls';
    const secondNode = 'vless://00000000-0000-4000-8000-000000000012@sg.example.com:443?remarks=%E6%96%B0%E5%8A%A0%E5%9D%A1SG&security=tls';
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      const value = String(url);
      if (value.includes('/getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'documents/nodes.txt' } }), { status: 200 });
      }
      if (value.includes('/file/botbot-token/documents/nodes.txt')) {
        return new Response(`${firstNode}\n${secondNode}\n`, {
          status: 200,
          headers: { 'Content-Length': String(firstNode.length + secondNode.length + 2) }
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        document: {
          file_id: 'telegram-file-id',
          file_name: '笔记 2026年7月27日 18_12_58.txt',
          file_size: 17084,
          mime_type: 'text/plain'
        },
        chat: { id: 2105 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions[0]).toMatchObject({
      type: 'inline',
      name: '笔记 2026年7月27日 18_12_58',
      nodeUrls: [firstNode, secondNode],
      nodeCount: 2
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.telegram.org/botbot-token/getFile',
      expect.objectContaining({ method: 'POST' })
    );
    const sentBodies = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body));
    expect(sentBodies.some(body => body.text?.includes('正在解析文件'))).toBe(true);
    const card = sentBodies.find(body => body.text?.includes('机场名称:'));
    expect(card.text).toContain('笔记 2026年7月27日 18_12_58');
    expect(card.text).toContain('订阅链接:');
    expect(card.text).toContain('本地文件 · 笔记 2026年7月27日 18_12_58.txt');
    expect(card.text).toContain('协议类型:');
    expect(card.text).toContain('节点总数: 2');
    expect(card.text).toContain('节点范围: 🇹🇭泰国,🇸🇬新加坡');
    expect(card.text).toContain('节点列表 (共 2 个)');
    const buttons = card.reply_markup.inline_keyboard.flat();
    expect(buttons).toHaveLength(6);
    expect(buttons.map(button => button.text)).toEqual([
      '🔄 刷新订阅信息',
      '📄 显示全部节点',
      '📤 导出Base64',
      '📤 导出YAML',
      '🔗 生成短链',
      '✅ 已保存订阅'
    ]);

    const fileFetchCount = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/file/botbot-token/')).length;
    const refreshCallback = buttons.find(button => button.callback_data.startsWith('sp_refresh_')).callback_data;
    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'inline-preview-refresh',
        data: refreshCallback,
        from: { id: 1 },
        message: { message_id: 98, chat: { id: 2105 } }
      }
    }), { MISUB_KV: null });
    expect(global.fetch.mock.calls.filter(([url]) => String(url).includes('/file/botbot-token/'))).toHaveLength(fileFetchCount);
    const refreshedCard = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(refreshedCard.text).toContain('节点总数: 2');

    const saveCallback = buttons.find(button => button.callback_data.startsWith('sp_save_')).callback_data;
    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'inline-preview-save',
        data: saveCallback,
        from: { id: 1 },
        message: { message_id: 98, chat: { id: 2105 } }
      }
    }), { MISUB_KV: null });
    expect(state.subscriptions).toHaveLength(1);

    const linkCallback = buttons.find(button => button.callback_data.startsWith('sp_link_')).callback_data;
    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'inline-preview-link',
        data: linkCallback,
        from: { id: 1 },
        message: { message_id: 98, chat: { id: 2105 } }
      }
    }), { MISUB_KV: null });
    expect(state.subscriptions).toHaveLength(1);
    expect(state.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subscriptions: [state.subscriptions[0].id],
        telegramPreviewSubscriptionId: state.subscriptions[0].id
      })
    ]));
    const linkMessage = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(linkMessage.text).toContain('https://example.com/profiles/tg-');
  });
  it('decodes UTF-16LE Telegram text documents before parsing nodes', async () => {
    const nodeUrl = 'trojan://password@utf16.example.com:443?security=tls#UTF16-Node';
    const fileBytes = encodeUtf16Le(`${nodeUrl}\r\n`);
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      const value = String(url);
      if (value.includes('/getFile')) {
        return new Response(JSON.stringify({
          ok: true,
          result: { file_path: 'documents/utf16.txt', file_size: fileBytes.byteLength }
        }), { status: 200 });
      }
      if (value.includes('/file/botbot-token/documents/utf16.txt')) {
        return new Response(fileBytes, { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        document: {
          file_id: 'telegram-utf16-file-id',
          file_name: 'utf16.txt',
          file_size: fileBytes.byteLength,
          mime_type: 'text/plain'
        },
        chat: { id: 2105 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    const previewCard = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body))
      .find(body => body.text?.includes('UTF16-Node'));
    expect(previewCard.text).toContain('来源类型:</b> 节点链接');
  });
  it('preserves subscription links embedded in descriptive Telegram file text', async () => {
    const subscriptionUrl = 'https://sub.example.com/from-file';
    const subscriptionNode = 'trojan://password@subscription.example.com:443?security=tls#Subscription-Node';
    const directNode = 'vless://00000000-0000-4000-8000-000000000013@direct.example.com:443?security=tls#Direct-Node';
    const fileContent = `订阅地址：${subscriptionUrl}\n直连节点：${directNode}\n`;
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      const value = String(url);
      if (value.includes('/getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'documents/mixed.conf' } }), { status: 200 });
      }
      if (value.includes('/file/botbot-token/documents/mixed.conf')) {
        return new Response(fileContent, { status: 200 });
      }
      if (value === subscriptionUrl) {
        return new Response(btoa(`${subscriptionNode}\n`), {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename=From-File.yaml' }
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        document: {
          file_id: 'telegram-mixed-file-id',
          file_name: 'mixed.conf',
          file_size: fileContent.length,
          mime_type: 'text/plain'
        },
        chat: { id: 2107 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions[0]).toMatchObject({
      type: 'inline',
      name: 'mixed',
      nodeUrls: [directNode, subscriptionNode],
      nodeCount: 2
    });
    expect(global.fetch).toHaveBeenCalledWith(subscriptionUrl, expect.objectContaining({
      method: 'GET',
      redirect: 'manual'
    }));
    const sentBodies = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body));
    expect(sentBodies.some(body => (
      body.text?.includes('机场名称:')
      && body.text?.includes('mixed')
      && body.text?.includes('节点总数: 2')
      && body.reply_markup?.inline_keyboard?.flat().length === 6
    ))).toBe(true);
  });
  it('imports Clash YAML documents through the shared subscription parser', async () => {
    const yamlText = [
      'proxies:',
      '  - name: YAML-Node',
      '    type: vless',
      '    server: yaml.example.com',
      '    port: 443',
      '    uuid: 00000000-0000-4000-8000-000000000014',
      '    tls: true',
      'proxy-groups:',
      '  - name: YAML Select',
      '    type: select',
      '    proxies:',
      '      - YAML-Node',
      '      - DIRECT',
      'rule-providers:',
      '  reject:',
      '    type: http',
      '    url: https://rules.example.com/reject.yaml',
      'rules:',
      '  - RULE-SET,reject,REJECT',
      '  - MATCH,YAML Select'
    ].join('\n');
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      const value = String(url);
      if (value.includes('/getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'documents/nodes.yaml' } }), { status: 200 });
      }
      if (value.includes('/file/botbot-token/documents/nodes.yaml')) {
        return new Response(yamlText, { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        document: {
          file_id: 'telegram-yaml-file-id',
          file_name: 'nodes.yaml',
          file_size: yamlText.length,
          mime_type: 'application/yaml'
        },
        chat: { id: 2108 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    expect(global.fetch.mock.calls.some(([url]) => String(url).includes('rules.example.com'))).toBe(false);

    const previewCard = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body))
      .find(body => body.reply_markup?.inline_keyboard?.flat().some(button => button.callback_data?.startsWith('sp_yaml_')));
    const previewButtons = previewCard.reply_markup.inline_keyboard.flat();
    const refreshCallback = previewButtons
      .find(button => button.callback_data?.startsWith('sp_refresh_')).callback_data;

    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'uploaded-yaml-refresh-callback',
        data: refreshCallback,
        from: { id: 1 },
        message: { message_id: 109, chat: { id: 2108 } }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    const yamlCallback = previewButtons.find(button => button.callback_data?.startsWith('sp_yaml_')).callback_data;

    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'uploaded-yaml-export-callback',
        data: yamlCallback,
        from: { id: 1 },
        message: { message_id: 109, chat: { id: 2108 } }
      }
    }), { MISUB_KV: null });

    const documentCall = global.fetch.mock.calls.find(([url]) => String(url).includes('/sendDocument'));
    const exportedConfig = yaml.load(await documentCall[1].body.get('document').text());
    expect(exportedConfig.rules).toEqual(['RULE-SET,reject,REJECT', 'MATCH,YAML Select']);
    expect(exportedConfig['rule-providers']).toEqual({
      reject: {
        type: 'http',
        url: 'https://rules.example.com/reject.yaml'
      }
    });
    expect(exportedConfig['rule-providers']).not.toHaveProperty('geolocation-cn');
    expect(exportedConfig['proxy-groups']).toEqual([{
      name: 'YAML Select',
      type: 'select',
      proxies: [exportedConfig.proxies[0].name, 'DIRECT']
    }]);
  });
  it('does not fetch HTTP proxy nodes parsed from Clash YAML documents', async () => {
    const yamlText = [
      'proxies:',
      '  - name: YAML-HTTP-Proxy',
      '    type: http',
      '    server: http-proxy.example.com',
      '    port: 8080'
    ].join('\n');
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      const value = String(url);
      if (value.includes('/getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'documents/http-proxy.yaml' } }), { status: 200 });
      }
      if (value.includes('/file/botbot-token/documents/http-proxy.yaml')) {
        return new Response(yamlText, { status: 200 });
      }
      if (value.includes('http-proxy.example.com')) {
        throw new Error('HTTP proxy node must not be fetched as a subscription');
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        document: {
          file_id: 'telegram-http-proxy-yaml-file-id',
          file_name: 'http-proxy.yaml',
          file_size: yamlText.length,
          mime_type: 'application/yaml'
        },
        chat: { id: 2113 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    expect(global.fetch.mock.calls.some(([url]) => String(url).includes('http-proxy.example.com'))).toBe(false);
    const previewCard = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body))
      .find(body => body.text?.includes('YAML-HTTP-Proxy'));
    expect(previewCard.text).toContain('来源类型:</b> 节点链接');
  });
  it('imports legacy Clash documents that use the singular Proxy key', async () => {
    const yaml = [
      'Proxy:',
      '  - name: Legacy-YAML-Node',
      '    type: trojan',
      '    server: legacy.example.com',
      '    port: 443',
      '    password: password',
      '    sni: legacy.example.com'
    ].join('\n');
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      const value = String(url);
      if (value.includes('/getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'documents/legacy.yaml' } }), { status: 200 });
      }
      if (value.includes('/file/botbot-token/documents/legacy.yaml')) {
        return new Response(yaml, { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        document: {
          file_id: 'telegram-legacy-yaml-file-id',
          file_name: 'legacy.yaml',
          file_size: yaml.length,
          mime_type: 'application/yaml'
        },
        chat: { id: 2108 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    const previewCard = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body))
      .find(body => body.text?.includes('Legacy-YAML-Node'));
    expect(previewCard.text).toContain('来源类型:</b> 节点链接');
  });
  it('imports Clash JSON documents through the shared subscription parser', async () => {
    const json = JSON.stringify({
      proxies: [{
        name: 'JSON-Node',
        type: 'trojan',
        server: 'json.example.com',
        port: 443,
        password: 'json-password',
        sni: 'json.example.com'
      }]
    });
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      const value = String(url);
      if (value.includes('/getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'documents/nodes.json' } }), { status: 200 });
      }
      if (value.includes('/file/botbot-token/documents/nodes.json')) {
        return new Response(json, { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        document: {
          file_id: 'telegram-json-file-id',
          file_name: 'nodes.json',
          file_size: json.length,
          mime_type: 'application/json'
        },
        chat: { id: 2111 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    const previewCard = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body))
      .find(body => body.text?.includes('JSON-Node'));
    expect(previewCard.text).toContain('来源类型:</b> 节点链接');
  });
  it('does not fetch rule URLs from unsupported structured JSON documents', async () => {
    const ruleUrl = 'https://rules.example.com/geosite.srs';
    const json = JSON.stringify({
      outbounds: [{ type: 'selector', tag: 'Proxy', outbounds: ['DIRECT'] }],
      route: { rule_set: [{ type: 'remote', tag: 'geosite', url: ruleUrl }] }
    });
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      const value = String(url);
      if (value.includes('/getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'documents/singbox.json' } }), { status: 200 });
      }
      if (value.includes('/file/botbot-token/documents/singbox.json')) {
        return new Response(json, { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        document: {
          file_id: 'telegram-singbox-file-id',
          file_name: 'singbox.json',
          file_size: json.length,
          mime_type: 'application/json'
        },
        chat: { id: 2112 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    expect(global.fetch.mock.calls.some(([url]) => String(url) === ruleUrl)).toBe(false);
    const sentBodies = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body));
    expect(sentBodies.at(-1).text).toContain('内容解析失败');
    expect(sentBodies.at(-1).text).toContain('检测到结构化配置');
  });
  it('imports extensionless subscription files returned by some providers', async () => {
    const firstNode = 'trojan://password@one.example.com:443?security=tls#One';
    const secondNode = 'vless://00000000-0000-4000-8000-000000000020@two.example.com:443?security=tls#Two';
    const fileContent = btoa(`${firstNode}\n${secondNode}\n`);
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      const value = String(url);
      if (value.includes('/getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'documents/extensionless-subscription' } }), { status: 200 });
      }
      if (value.includes('/file/botbot-token/documents/extensionless-subscription')) {
        return new Response(fileContent, { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        document: {
          file_id: 'telegram-extensionless-file-id',
          file_name: '一元机场',
          file_size: fileContent.length,
          mime_type: 'application/octet-stream'
        },
        chat: { id: 2112 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions[0]).toMatchObject({
      type: 'inline',
      name: '一元机场',
      nodeUrls: [firstNode, secondNode],
      nodeCount: 2
    });
    const card = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body))
      .find(body => body.text?.includes('机场名称:'));
    expect(card.text).toContain('一元机场');
    expect(card.text).toContain('节点总数: 2');
    expect(card.reply_markup.inline_keyboard.flat()).toHaveLength(6);
  });
  it('accepts extensionless JSON documents reported with an application/json MIME type', async () => {
    const documentContent = JSON.stringify({
      proxies: [{
        name: 'JSON-No-Extension',
        type: 'trojan',
        server: 'json-no-extension.example.com',
        port: 443,
        password: 'secret',
        sni: 'json-no-extension.example.com'
      }]
    });
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      const value = String(url);
      if (value.includes('/getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'documents/provider-config' } }), { status: 200 });
      }
      if (value.includes('/file/botbot-token/documents/provider-config')) {
        return new Response(documentContent, { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        document: {
          file_id: 'telegram-extensionless-json-id',
          file_name: 'provider-config',
          file_size: documentContent.length,
          mime_type: 'application/json'
        },
        chat: { id: 2114 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    const previewCard = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body))
      .find(body => body.text?.includes('JSON-No-Extension'));
    expect(previewCard.text).toContain('json-no-extension.example.com');
  });
  it('rejects unsupported Telegram document types before downloading', async () => {
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        document: {
          file_id: 'telegram-zip-id',
          file_name: 'nodes.zip',
          file_size: 1024,
          mime_type: 'application/zip'
        },
        chat: { id: 2106 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(String(global.fetch.mock.calls[0][0])).toContain('/sendMessage');
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.text).toContain('仅支持 TXT、YAML、YML、CONF、JSON 或无扩展名的订阅文件');
  });
  it('rejects oversized Telegram documents before requesting file info', async () => {
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        document: {
          file_id: 'telegram-large-file-id',
          file_name: 'large.txt',
          file_size: 5 * 1024 * 1024 + 1,
          mime_type: 'text/plain'
        },
        chat: { id: 2109 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(String(global.fetch.mock.calls[0][0])).toContain('/sendMessage');
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.text).toContain('文件超过 5 MB 限制');
  });
  it('rejects documents whose getFile metadata reports an oversized payload', async () => {
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (String(url).includes('/getFile')) {
        return new Response(JSON.stringify({
          ok: true,
          result: { file_path: 'documents/actually-large.txt', file_size: 5 * 1024 * 1024 + 1 }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        document: {
          file_id: 'telegram-remote-large-file-id',
          file_name: 'actually-large.txt',
          file_size: 10,
          mime_type: 'text/plain'
        },
        chat: { id: 2109 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    expect(global.fetch.mock.calls.some(([url]) => String(url).includes('/file/bot'))).toBe(false);
    const sentBodies = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body));
    expect(sentBodies.at(-1).text).toContain('文件超过 5 MB 限制');
  });
  it('reports Telegram getFile API failures without attempting a download', async () => {
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (String(url).includes('/getFile')) {
        return new Response(JSON.stringify({ ok: false, description: 'Bad Request: file not found' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        document: {
          file_id: 'missing-file-id',
          file_name: 'missing.txt',
          file_size: 10,
          mime_type: 'text/plain'
        },
        chat: { id: 2110 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    expect(global.fetch.mock.calls.some(([url]) => String(url).includes('/file/bot'))).toBe(false);
    const sentBodies = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body));
    expect(sentBodies.at(-1).text).toContain('无法获取 Telegram 文件信息');
  });
  it('previews subscription URLs and still imports direct nodes from the same message', async () => {
    const subscriptionUrl = 'https://sub.example.com/mixed';
    const subscriptionNode = 'trojan://password@subscription.example.com:443?security=tls#Subscription-Node';
    const directNode = 'vless://00000000-0000-4000-8000-000000000002@direct.example.com:443?security=tls#Direct-Node';
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (url === subscriptionUrl) {
        return new Response(btoa(`${subscriptionNode}\n`), {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename=Mixed.yaml' }
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: `${subscriptionUrl}\n${directNode}`,
        chat: { id: 2103 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    const sentBodies = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body));
    expect(sentBodies.some(body => body.text?.includes('Mixed'))).toBe(true);
    expect(sentBodies.some(body => body.text?.includes('Direct-Node'))).toBe(true);
    expect(sentBodies.some(body => body.text?.includes('来源类型:</b> 节点链接'))).toBe(true);
  });
  it('falls back to an embedded original subscription when a converter short link returns HTTP 502', async () => {
    const shortUrl = 'https://suo.yt/MAK3R1r';
    const originalUrl = 'http://154.23.242.65:61672/original-subscription';
    const converterUrl = `https://api.wcc.best/sub?target=clash&url=${encodeURIComponent(originalUrl)}&emoji=true`;
    const firstNode = 'vless://6d1ba774-7ca6-4768-8de6-4efd90d17905@154.23.242.65:61671?security=reality#US-Fastnet-Data';
    const secondNode = 'hysteria2://password@154.23.242.65:61674/?sni=www.bing.com#US-HY2';
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (String(url) === shortUrl) {
        return new Response('', { status: 301, headers: { Location: converterUrl } });
      }
      if (String(url) === converterUrl) {
        return new Response('error code: 502', { status: 502 });
      }
      if (String(url) === originalUrl) {
        return new Response(encodeBase64Utf8(`${firstNode}\n${secondNode}\n`), {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename=Original-Airport.yaml' }
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: shortUrl,
        chat: { id: 2115 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    expect(global.fetch.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
      shortUrl,
      converterUrl,
      originalUrl
    ]));
    const previewBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(previewBody.text).toContain('Original-Airport');
    expect(previewBody.text).toContain('节点总数: 2');
    expect(previewBody.text).toContain(shortUrl);
    expect(previewBody.text).not.toContain(originalUrl);
  });
  it('falls back to an embedded original subscription when a converter returns empty content', async () => {
    const shortUrl = 'https://suo.yt/empty-converter';
    const originalUrl = 'https://origin.example.com/empty-converter-source';
    const converterUrl = `https://api.wcc.best/sub?url=${encodeURIComponent(originalUrl)}`;
    const nodeUrl = 'trojan://password@empty-fallback.example.com:443#Empty-Fallback-Node';
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (String(url) === shortUrl) {
        return new Response('', { status: 302, headers: { Location: converterUrl } });
      }
      if (String(url) === converterUrl) return new Response('', { status: 200 });
      if (String(url) === originalUrl) return new Response(encodeBase64Utf8(`${nodeUrl}\n`), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: shortUrl,
        chat: { id: 2118 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    const previewBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(previewBody.text).toContain('Empty-Fallback-Node');
    expect(previewBody.text).toContain('节点总数: 1');
  });
  it('keeps the embedded original subscription across a converter redirect to an error endpoint', async () => {
    const shortUrl = 'https://suo.yt/converter-error-endpoint';
    const originalUrl = 'https://origin.example.com/redirected-converter-source';
    const converterUrl = `https://api.wcc.best/sub?url=${encodeURIComponent(originalUrl)}`;
    const converterErrorUrl = 'https://converter-cdn.example.com/errors/502';
    const nodeUrl = 'trojan://password@redirect-fallback.example.com:443#Redirect-Fallback-Node';
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (String(url) === shortUrl) {
        return new Response('', { status: 302, headers: { Location: converterUrl } });
      }
      if (String(url) === converterUrl) {
        return new Response('', { status: 302, headers: { Location: converterErrorUrl } });
      }
      if (String(url) === converterErrorUrl) return new Response('bad gateway', { status: 502 });
      if (String(url) === originalUrl) {
        return new Response(encodeBase64Utf8(`${nodeUrl}\n`), {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename=Redirect-Original.yaml' }
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: shortUrl,
        chat: { id: 2119 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    expect(global.fetch.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
      shortUrl,
      converterUrl,
      converterErrorUrl,
      originalUrl
    ]));
    const previewBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(previewBody.text).toContain('Redirect-Original');
    expect(previewBody.text).toContain('Redirect-Fallback-Node');
    expect(previewBody.text).toContain(shortUrl);
    expect(previewBody.text).not.toContain(originalUrl);
    const previewSession = Object.values(state.misc)
      .find(value => value?.sourceUrl === shortUrl);
    expect(previewSession).toMatchObject({
      sourceUrl: shortUrl,
      finalUrl: originalUrl
    });
  });
  it('reports both converter and original-source failures when short-link fallback fails', async () => {
    const shortUrl = 'https://suo.yt/broken';
    const originalUrl = 'https://origin.example.com/subscription';
    const converterUrl = `https://api.wcc.best/sub?url=${encodeURIComponent(originalUrl)}`;
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (String(url) === shortUrl) {
        return new Response('', { status: 302, headers: { Location: converterUrl } });
      }
      if (String(url) === converterUrl) return new Response('bad gateway', { status: 502 });
      if (String(url) === originalUrl) return new Response('unavailable', { status: 503 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: shortUrl,
        chat: { id: 2116 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    const errorBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(errorBody.text).toContain('订阅解析失败');
    expect(errorBody.text).toContain('下载阶段失败');
    expect(errorBody.text).toContain('api.wcc.best 返回 HTTP 502');
    expect(errorBody.text).toContain('原始订阅回退失败');
    expect(errorBody.text).toContain('origin.example.com 返回 HTTP 503');
    expect(errorBody.text).not.toContain('/subscription');
  });
  it('rejects private embedded subscription URLs during converter fallback', async () => {
    const shortUrl = 'https://suo.yt/private-fallback';
    const converterUrl = `https://api.wcc.best/sub?url=${encodeURIComponent('http://127.0.0.1/private-sub')}`;
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (String(url) === shortUrl) {
        return new Response('', { status: 302, headers: { Location: converterUrl } });
      }
      if (String(url) === converterUrl) return new Response('bad gateway', { status: 502 });
      if (String(url).startsWith('http://127.0.0.1')) {
        throw new Error(`private fallback must not be fetched: ${url}`);
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: shortUrl,
        chat: { id: 2117 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    expect(global.fetch.mock.calls.some(([url]) => String(url).startsWith('http://127.0.0.1'))).toBe(false);
    const errorBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(errorBody.text).toContain('原始订阅回退被拒绝');
    expect(errorBody.text).toContain('URL host is not allowed');
  });
  it('persists and reuses the Clash user-agent after a subscription preview gets HTTP 403', async () => {
    const subscriptionUrl = 'https://sub.example.com/ua-fallback';
    const nodeUrl = 'trojan://password@fallback.example.com:443?security=tls#Fallback-Node';
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);
    let requestCount = 0;

    global.fetch = vi.fn(async url => {
      if (url === subscriptionUrl) {
        requestCount += 1;
        const requestOptions = global.fetch.mock.calls.at(-1)?.[1] || {};
        if (requestOptions.headers?.['User-Agent'] !== 'clash-verge/v2.4.3') {
          return new Response('forbidden', { status: 403 });
        }
        return new Response(btoa(`${nodeUrl}\n`), {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename=Fallback.yaml' }
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: subscriptionUrl,
        chat: { id: 2113 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(requestCount).toBe(2);
    expect(state.subscriptions).toHaveLength(0);
    const previewBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(previewBody.text).toContain('Fallback');
    expect(previewBody.text).toContain('节点总数: 1');

    const buttons = previewBody.reply_markup.inline_keyboard.flat();
    const invoke = data => handleTelegramWebhook(createRequest({
      callback_query: {
        id: `ua-fallback-${data}`,
        data,
        from: { id: 1 },
        message: { message_id: 97, chat: { id: 2113 } }
      }
    }), { MISUB_KV: null });

    await invoke(buttons.find(button => button.callback_data.startsWith('sp_save_')).callback_data);
    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions[0]).toMatchObject({
      customUserAgent: 'clash-verge/v2.4.3',
      nodeUrls: [nodeUrl],
      nodeCount: 1
    });

    await invoke(buttons.find(button => button.callback_data.startsWith('sp_refresh_')).callback_data);
    expect(requestCount).toBe(3);
    const subscriptionRequests = global.fetch.mock.calls.filter(([url]) => url === subscriptionUrl);
    expect(subscriptionRequests.at(-1)[1].headers['User-Agent']).toBe('clash-verge/v2.4.3');
    expect(state.subscriptions).toHaveLength(1);
  });
  it('retries redirecting subscriptions with the Clash user-agent before following a decoy page', async () => {
    const subscriptionUrl = 'https://sub.example.com/redirecting-user-agent';
    const decoyUrl = 'https://www.apple.com/';
    const yaml = [
      'proxies:',
      '  - name: Redirect-UA-Node',
      '    type: vless',
      '    server: redirect-ua.example.com',
      '    port: 443',
      '    uuid: 00000000-0000-4000-8000-000000000020',
      '    tls: true'
    ].join('\n');
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async (url, requestOptions = {}) => {
      if (url === subscriptionUrl) {
        if (requestOptions.headers?.['User-Agent'] !== 'clash-verge/v2.4.3') {
          return new Response('', { status: 302, headers: { Location: decoyUrl } });
        }
        return new Response(yaml, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=UTF-8',
            'Content-Disposition': 'attachment; filename=apple'
          }
        });
      }
      if (url === decoyUrl) throw new Error('decoy page must not be fetched');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: subscriptionUrl,
        chat: { id: 2118 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(0);
    const subscriptionRequests = global.fetch.mock.calls.filter(([url]) => url === subscriptionUrl);
    expect(subscriptionRequests).toHaveLength(2);
    expect(subscriptionRequests[0][1].headers['User-Agent']).toContain('Mozilla/5.0');
    expect(subscriptionRequests[1][1].headers['User-Agent']).toBe('clash-verge/v2.4.3');
    expect(global.fetch.mock.calls.some(([url]) => url === decoyUrl)).toBe(false);

    const previewBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(previewBody.text).toContain('Redirect-UA-Node');
    expect(previewBody.text).toContain('节点总数: 1');
  });
  it('refreshes a saved preview in place without creating a duplicate subscription', async () => {
    const subscriptionUrl = 'https://sub.example.com/refresh';
    const firstNode = 'trojan://password@one.example.com:443?security=tls#Node-One';
    const secondNode = 'trojan://password@two.example.com:443?security=tls#Node-Two';
    let responseNodes = [firstNode];
    let total = 1000;
    let filename = 'Refresh.yaml';
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (url === subscriptionUrl) {
        return new Response(btoa(`${responseNodes.join('\n')}\n`), {
          status: 200,
          headers: {
            'Content-Disposition': `attachment; filename=${filename}`,
            'subscription-userinfo': `upload=10; download=20; total=${total}; expire=1798003810`
          }
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: subscriptionUrl,
        chat: { id: 2104 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    const previewBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    const buttons = previewBody.reply_markup.inline_keyboard.flat();
    const saveCallback = buttons.find(button => button.callback_data.startsWith('sp_save_')).callback_data;
    const refreshCallback = buttons.find(button => button.callback_data.startsWith('sp_refresh_')).callback_data;

    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'save-before-refresh',
        data: saveCallback,
        from: { id: 1 },
        message: { message_id: 100, chat: { id: 2104 } }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions[0].name).toBe('Refresh');

    responseNodes = [firstNode, secondNode];
    total = 2000;
    state.subscriptions[0].name = 'sub.example.com';
    filename = 'Updated-Airport.yaml';
    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'refresh-saved-preview',
        data: refreshCallback,
        from: { id: 1 },
        message: { message_id: 100, chat: { id: 2104 } }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions[0]).toMatchObject({
      name: 'Updated-Airport',
      url: subscriptionUrl,
      nodeCount: 2,
      userInfo: expect.objectContaining({ total: 2000 })
    });

    state.subscriptions[0].name = 'My Custom Airport';
    filename = 'Latest-Upstream-Name.yaml';
    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'refresh-custom-named-preview',
        data: refreshCallback,
        from: { id: 1 },
        message: { message_id: 100, chat: { id: 2104 } }
      }
    }), { MISUB_KV: null });
    expect(state.subscriptions[0].name).toBe('My Custom Airport');
  });
  it('keeps the original command surface in help output', async () => {
    const { adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: '/help',
        chat: { id: 3001 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(global.fetch).toHaveBeenCalledTimes(6);
    const body = JSON.parse(global.fetch.mock.calls[5][1].body);
    expect(body.text).toContain('/delete');
    expect(body.text).toContain('/search');
    expect(body.text).toContain('/sort');
    expect(body.text).toContain('TXT、YAML、YML、CONF、JSON');
  });

  it('configures the Telegram command menu when /start is used', async () => {
    const { adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: '/start',
        chat: { id: 3002 },
        from: { id: 1, language_code: 'zh-Hans' }
      }
    }), { MISUB_KV: null });

    expect(global.fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.telegram.org/botbot-token/setMyCommands',
      'https://api.telegram.org/botbot-token/setMyCommands',
      'https://api.telegram.org/botbot-token/setChatMenuButton',
      'https://api.telegram.org/botbot-token/setMyCommands',
      'https://api.telegram.org/botbot-token/setMyCommands',
      'https://api.telegram.org/botbot-token/setChatMenuButton',
      'https://api.telegram.org/botbot-token/sendMessage'
    ]);

    const defaultCommandsBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(defaultCommandsBody).toEqual({
      commands: [
        { command: 'start', description: '开始使用 MiSub' },
        { command: 'help', description: '查看帮助' },
        { command: 'list', description: '查看节点和订阅列表' }
      ],
      scope: { type: 'default' }
    });

    const privateCommandsBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(privateCommandsBody).toEqual({
      commands: [
        { command: 'start', description: '开始使用 MiSub' },
        { command: 'help', description: '查看帮助' },
        { command: 'list', description: '查看节点和订阅列表' }
      ],
      scope: { type: 'all_private_chats' }
    });

    const menuBody = JSON.parse(global.fetch.mock.calls[2][1].body);
    expect(menuBody).toEqual({
      menu_button: { type: 'commands' }
    });

    const chatCommandsBody = JSON.parse(global.fetch.mock.calls[3][1].body);
    expect(chatCommandsBody).toEqual({
      commands: [
        { command: 'start', description: '开始使用 MiSub' },
        { command: 'help', description: '查看帮助' },
        { command: 'list', description: '查看节点和订阅列表' }
      ],
      scope: { type: 'chat', chat_id: 3002 }
    });

    const localizedChatCommandsBody = JSON.parse(global.fetch.mock.calls[4][1].body);
    expect(localizedChatCommandsBody).toEqual({
      commands: [
        { command: 'start', description: '开始使用 MiSub' },
        { command: 'help', description: '查看帮助' },
        { command: 'list', description: '查看节点和订阅列表' }
      ],
      scope: { type: 'chat', chat_id: 3002 },
      language_code: 'zh'
    });

    const chatMenuBody = JSON.parse(global.fetch.mock.calls[5][1].body);
    expect(chatMenuBody).toEqual({
      chat_id: 3002,
      menu_button: { type: 'commands' }
    });

    const messageBody = JSON.parse(global.fetch.mock.calls[6][1].body);
    expect(messageBody.text).toContain('欢迎使用 MiSub Telegram Bot');

    await handleTelegramWebhook(createRequest({
      message: {
        text: '/help',
        chat: { id: 3002 },
        from: { id: 1, language_code: 'zh-Hans' }
      }
    }), { MISUB_KV: null });

    expect(global.fetch.mock.calls.slice(7).map(([url]) => String(url))).toEqual([
      'https://api.telegram.org/botbot-token/setMyCommands',
      'https://api.telegram.org/botbot-token/setMyCommands',
      'https://api.telegram.org/botbot-token/setChatMenuButton',
      'https://api.telegram.org/botbot-token/sendMessage'
    ]);
  });

  it('refreshes the Telegram command menu for any private-chat update', async () => {
    const { adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: 'hello',
        chat: { id: 3004, type: 'private' },
        from: { id: 1, language_code: 'zh-Hans' }
      }
    }), { MISUB_KV: null });

    expect(global.fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.telegram.org/botbot-token/setMyCommands',
      'https://api.telegram.org/botbot-token/setMyCommands',
      'https://api.telegram.org/botbot-token/setChatMenuButton',
      'https://api.telegram.org/botbot-token/setMyCommands',
      'https://api.telegram.org/botbot-token/setMyCommands',
      'https://api.telegram.org/botbot-token/setChatMenuButton',
      'https://api.telegram.org/botbot-token/sendMessage'
    ]);
  });

  it('continues replying when Telegram rejects command menu configuration', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { adapter } = createState();
    createAdapter.mockReturnValue(adapter);
    global.fetch = vi.fn(async url => {
      if (String(url).endsWith('/sendMessage')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false, description: 'menu unavailable' }), { status: 400 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    try {
      const response = await handleTelegramWebhook(createRequest({
        message: {
          text: '/start',
          chat: { id: 3003 },
          from: { id: 1 }
        }
      }), { MISUB_KV: null });

      expect(response.status).toBe(200);
      expect(global.fetch.mock.calls.map(([url]) => String(url))).toEqual([
        'https://api.telegram.org/botbot-token/setMyCommands',
        'https://api.telegram.org/botbot-token/setMyCommands',
        'https://api.telegram.org/botbot-token/setChatMenuButton',
        'https://api.telegram.org/botbot-token/setMyCommands',
        'https://api.telegram.org/botbot-token/setChatMenuButton',
        'https://api.telegram.org/botbot-token/sendMessage'
      ]);
      const messageBody = JSON.parse(global.fetch.mock.calls[5][1].body);
      expect(messageBody.text).toContain('欢迎使用 MiSub Telegram Bot');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('shows separate Telegram list entry points instead of mixing manual nodes and airport subscriptions', async () => {
    const { adapter } = createState({
      subscriptions: [
        { id: 'node-1', name: 'HK VLESS', url: 'vless://uuid@example.com:443#HK', enabled: true },
        { id: 'airport-1', name: '机场订阅', url: 'https://airport.example/sub', enabled: true }
      ]
    });
    createAdapter.mockReturnValue(adapter);

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: '/list',
        chat: { id: 4001 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(global.fetch).toHaveBeenCalledTimes(6);
    const body = JSON.parse(global.fetch.mock.calls[5][1].body);
    expect(body.text).toContain('请选择列表类型');
    expect(body.text).toContain('节点列表');
    expect(body.text).toContain('机场列表');
    expect(body.text).not.toContain('HK VLESS');
    expect(body.text).not.toContain('airport.example');
    expect(body.reply_markup.inline_keyboard.flat()).toEqual(expect.arrayContaining([
      expect.objectContaining({ callback_data: 'cmd_list_node' }),
      expect.objectContaining({ callback_data: 'cmd_list_sub' })
    ]));
  });

  it('renders airport subscriptions as one full-width button per item with status summaries', async () => {
    const now = Math.floor(Date.now() / 1000);
    const subscriptions = Array.from({ length: 11 }, (_, index) => ({
      id: `airport-${index + 1}`,
      name: `Airport ${index + 1}`,
      url: `https://airport${index + 1}.example/sub`,
      enabled: index !== 5,
      userInfo: {
        upload: 10 * 1024 ** 3,
        download: 20 * 1024 ** 3,
        total: (100 + index) * 1024 ** 3,
        expire: now + (index === 1 ? 7 : 120) * 86400
      }
    }));
    const { adapter } = createState({ subscriptions });
    createAdapter.mockReturnValue(adapter);

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: '/list sub',
        chat: { id: 4003 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    const body = JSON.parse(global.fetch.mock.calls[5][1].body);
    expect(body.text).toContain('订阅列表 共11个');
    expect(body.text).toContain('🟠1个临期');
    expect(body.text).toContain('第1/2页');

    const rows = body.reply_markup.inline_keyboard;
    expect(rows.slice(0, 10).every(row => row.length === 1)).toBe(true);
    expect(rows[0][0]).toMatchObject({ callback_data: 'sub_detail_0' });
    expect(rows[0][0].text).toContain('🟢 #1 Airport 1 [70.00 GB] 120天');
    expect(rows[1][0].text).toContain('🟠 #2 Airport 2 [71.00 GB] 7天');
    expect(rows[5][0].text).toContain('🟠 #6 Airport 6');
    expect(rows.flat().some(button => button.text.includes('Airport 11'))).toBe(false);
    expect(rows.flat()).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '📄 1/2', callback_data: 'noop' }),
      expect.objectContaining({ text: '➡️', callback_data: 'list_page_sub_1' }),
      expect.objectContaining({ text: '🔢 跳转页码', callback_data: 'prompt_sub_page' }),
      expect.objectContaining({ text: '🔄 更新所有', callback_data: 'refresh_all_subs_0' }),
      expect.objectContaining({ text: '🏠 主菜单', callback_data: 'cmd_menu' })
    ]));

    await handleTelegramWebhook(createRequest({
      message: {
        text: '/list sub 2',
        chat: { id: 4003 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    const secondPageBody = JSON.parse(global.fetch.mock.calls.at(-1)[1].body);
    expect(secondPageBody.text).toContain('第2/2页');
    expect(secondPageBody.reply_markup.inline_keyboard[0][0]).toMatchObject({
      text: expect.stringContaining('#11 Airport 11'),
      callback_data: 'sub_detail_10'
    });
    expect(secondPageBody.reply_markup.inline_keyboard.flat()).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '⬅️', callback_data: 'list_page_sub_0' }),
      expect.objectContaining({ text: '📄 2/2', callback_data: 'noop' })
    ]));
  });

  it('renders manual nodes as full-width detail buttons with stable pagination indexes', async () => {
    const subscriptions = Array.from({ length: 7 }, (_, index) => ({
      id: `node-${index + 1}`,
      name: `Node ${index + 1}`,
      url: `vless://uuid@example${index + 1}.com:443#Node-${index + 1}`,
      enabled: index !== 1
    }));
    const { adapter } = createState({ subscriptions });
    createAdapter.mockReturnValue(adapter);

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: '/list node',
        chat: { id: 4004 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    const firstPageBody = JSON.parse(global.fetch.mock.calls.at(-1)[1].body);
    const firstPageRows = firstPageBody.reply_markup.inline_keyboard;
    expect(firstPageBody.text).toContain('节点列表 共7个 | 第1/2页');
    expect(firstPageBody.text).not.toContain('Node 1');
    expect(firstPageRows.slice(0, 6).every(row => row.length === 1)).toBe(true);
    expect(firstPageRows[0][0]).toMatchObject({
      text: '✅ #1 Node 1 [VLESS]',
      callback_data: 'node_action_node_0'
    });
    expect(firstPageRows[1][0]).toMatchObject({
      text: '⛔ #2 Node 2 [VLESS]',
      callback_data: 'node_action_node_1'
    });
    expect(firstPageRows.flat()).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '➡️', callback_data: 'list_page_node_1' }),
      expect.objectContaining({ text: '🔢 跳转页码', callback_data: 'prompt_node_page' })
    ]));

    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'prompt-node-page',
        data: 'prompt_node_page',
        from: { id: 1 },
        message: { message_id: 95, chat: { id: 4004 } }
      }
    }), { MISUB_KV: null });

    const promptBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/answerCallbackQuery'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(promptBody).toMatchObject({
      callback_query_id: 'prompt-node-page',
      text: '请发送 /list node 页码',
      show_alert: true
    });

    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'node-list-page-2',
        data: 'list_page_node_1',
        from: { id: 1 },
        message: { message_id: 95, chat: { id: 4004 } }
      }
    }), { MISUB_KV: null });

    const secondPageBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(secondPageBody.text).toContain('节点列表 共7个 | 第2/2页');
    expect(secondPageBody.reply_markup.inline_keyboard[0][0]).toMatchObject({
      text: '✅ #7 Node 7 [VLESS]',
      callback_data: 'node_action_node_6'
    });

    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'open-node-7',
        data: 'node_action_node_6',
        from: { id: 1 },
        message: { message_id: 95, chat: { id: 4004 } }
      }
    }), { MISUB_KV: null });

    const detailBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(detailBody.text).toContain('机场名称:</b> <code>Node 7</code>');
    expect(detailBody.text).toContain('来源类型:</b> 节点链接');
    expect(detailBody.text).toContain('流量详情:</b> 未知');
    expect(detailBody.text).toContain('过期时间:</b> 长期有效');
    expect(detailBody.text).toContain('- name: Node-7');
    expect(detailBody.text).toContain('server: example7.com');
    const detailButtons = detailBody.reply_markup.inline_keyboard.flat();
    expect(detailButtons.map(button => button.text)).toEqual([
      '🔄 刷新订阅信息', '📄 显示全部节点',
      '📥 导出Base64', '📥 导出YAML',
      '🔗 生成短链', '✅ 已保存订阅',
      '⬅️ 返回节点列表'
    ]);
    expect(detailButtons).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '⬅️ 返回节点列表', callback_data: 'list_page_node_1' })
    ]));

    const refreshCallback = detailButtons.find(button => button.text === '🔄 刷新订阅信息').callback_data;
    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'refresh-node-7',
        data: refreshCallback,
        from: { id: 1 },
        message: { message_id: 95, chat: { id: 4004 } }
      }
    }), { MISUB_KV: null });

    const refreshedDetailBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(refreshedDetailBody.text).toContain('机场名称:</b> <code>Node 7</code>');
    expect(refreshedDetailBody.reply_markup.inline_keyboard.flat()).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '⬅️ 返回节点列表', callback_data: 'list_page_node_1' })
    ]));

    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'return-node-list-page-2',
        data: 'list_page_node_1',
        from: { id: 1 },
        message: { message_id: 95, chat: { id: 4004 } }
      }
    }), { MISUB_KV: null });

    const returnedListBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(returnedListBody.text).toContain('节点列表 共7个 | 第2/2页');
    expect(returnedListBody.reply_markup.inline_keyboard[0][0]).toMatchObject({
      text: '✅ #7 Node 7 [VLESS]',
      callback_data: 'node_action_node_6'
    });
  });

  it('refreshes all enabled airport subscriptions and redraws the current list page', async () => {
    const subscriptionUrl = 'https://airport.example/refresh-all';
    const refreshedNode = 'trojan://password@refresh.example.com:443?security=tls#Refreshed-Node';
    const { state, adapter } = createState({
      subscriptions: [{
        id: 'airport-refresh',
        name: 'airport.example',
        url: subscriptionUrl,
        enabled: true,
        nodeCount: 0,
        userInfo: null
      }]
    });
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (String(url) === subscriptionUrl) {
        return new Response(btoa(`${refreshedNode}\n`), {
          status: 200,
          headers: {
            'Content-Disposition': 'attachment; filename=Refresh-Airport.yaml',
            'subscription-userinfo': 'upload=1073741824; download=2147483648; total=107374182400; expire=1798003810'
          }
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'refresh-all-callback',
        data: 'refresh_all_subs_0',
        from: { id: 1 },
        message: { message_id: 89, chat: { id: 4004 } }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions[0]).toMatchObject({
      name: 'Refresh-Airport',
      customUserAgent: expect.stringContaining('Mozilla/5.0'),
      nodeUrls: [refreshedNode],
      nodeCount: 1,
      userInfo: expect.objectContaining({ total: 107374182400 }),
      lastError: null,
      lastUpdate: expect.any(String)
    });
    expect(state.misc['node_cache_subscription_airport-refresh']).toMatchObject({
      nodes: [refreshedNode],
      nodeCount: 1,
      sourceId: 'airport-refresh',
      sourceUrl: subscriptionUrl
    });
    const calls = global.fetch.mock.calls;
    expect(calls.some(([url]) => String(url) === subscriptionUrl)).toBe(true);
    const editBody = calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(editBody.text).toContain('订阅列表 共1个');
    expect(editBody.reply_markup.inline_keyboard[0][0].text).toContain('[97.00 GB]');
    const sentBodies = calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body));
    expect(sentBodies.at(-1).text).toContain('更新完成：成功 1 个，失败 0 个');

    delete state.misc['node_cache_subscription_airport-refresh'];

    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'open-refreshed-subscription',
        data: 'sub_detail_0',
        from: { id: 1 },
        message: { message_id: 89, chat: { id: 4004 } }
      }
    }), { MISUB_KV: null });

    expect(global.fetch.mock.calls.filter(([url]) => String(url) === subscriptionUrl)).toHaveLength(1);
    const detailBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(detailBody.text).toContain('节点列表（共1个）');
    expect(detailBody.text).toContain('1. [TROJAN] Refreshed-Node');
  });
  it('clears stale traffic metadata when a successful refresh omits the user-info header', async () => {
    const subscriptionUrl = 'https://airport.example/without-user-info';
    const refreshedNode = 'trojan://password@fresh.example.com:443?security=tls#Fresh-Node';
    const { state, adapter } = createState({
      subscriptions: [{
        id: 'airport-stale-traffic',
        name: 'Stale Traffic Airport',
        url: subscriptionUrl,
        enabled: true,
        nodeCount: 99,
        userInfo: { upload: 10, download: 20, total: 1000, expire: 1798003810 }
      }]
    });
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (String(url) === subscriptionUrl) {
        return new Response(btoa(`${refreshedNode}\n`), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'refresh-without-user-info',
        data: 'refresh_all_subs_0',
        from: { id: 1 },
        message: { message_id: 90, chat: { id: 4004 } }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions[0]).toMatchObject({
      nodeCount: 1,
      userInfo: null,
      lastError: null,
      lastUpdate: expect.any(String)
    });
  });
  it('lists per-subscription failure reasons in bulk refresh results without exposing tokens', async () => {
    const failedUrl = 'https://failed.example.com/very-secret-token-123?token=abc';
    const { state, adapter } = createState({
      subscriptions: [{
        id: 'airport-bulk-failure',
        name: 'Broken Airport',
        url: failedUrl,
        enabled: true
      }]
    });
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (String(url) === failedUrl) throw new Error(`network error for ${failedUrl}`);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'refresh-all-with-failure-reason',
        data: 'refresh_all_subs_0',
        from: { id: 1 },
        message: { message_id: 90, chat: { id: 4004 } }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions[0].lastError).toContain('下载阶段失败');
    const resultBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(resultBody.text).toContain('更新完成：成功 0 个，失败 1 个');
    expect(resultBody.text).toContain('Broken Airport');
    expect(resultBody.text).toContain('下载阶段失败');
    expect(resultBody.text).toContain('[REDACTED]');
    expect(resultBody.text).not.toContain('very-secret-token-123');
    expect(resultBody.text).not.toContain('token=abc');
  });
  it('uses each subscription custom user-agent during bulk refresh', async () => {
    const subscriptionUrl = 'https://airport.example/custom-user-agent';
    const customUserAgent = 'ClashMetaForAndroid/2.11.6';
    const refreshedNode = 'trojan://password@ua.example.com:443?security=tls#UA-Node';
    const { adapter } = createState({
      subscriptions: [{
        id: 'airport-custom-user-agent',
        name: 'Custom UA Airport',
        url: subscriptionUrl,
        enabled: true,
        customUserAgent
      }]
    });
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async (url, options) => {
      if (String(url) === subscriptionUrl) {
        expect(options.headers['User-Agent']).toBe(customUserAgent);
        return new Response(btoa(`${refreshedNode}\n`), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'refresh-with-custom-user-agent',
        data: 'refresh_all_subs_0',
        from: { id: 1 },
        message: { message_id: 91, chat: { id: 4004 } }
      }
    }), { MISUB_KV: null });

    expect(global.fetch.mock.calls.some(([url]) => String(url) === subscriptionUrl)).toBe(true);
  });

  it('opens a rich stored-subscription detail with screenshot-style actions', async () => {
    const now = Math.floor(Date.now() / 1000);
    const subscriptionUrl = 'https://airport.example/detail/token';
    const firstNode = 'anytls://password@one.example.com:443#剩余流量：41.96 GB';
    const secondNode = 'anytls://password@two.example.com:443#距离下次重置剩余：116 天';
    const { state, adapter } = createState({
      subscriptions: [{
        id: 'airport-detail',
        name: '悠悠',
        url: subscriptionUrl,
        enabled: true,
        customUserAgent: 'ClashMeta/1.0',
        nodeCount: 2,
        userInfo: {
          upload: 20 * 1024 ** 3,
          download: 138 * 1024 ** 3,
          total: 200 * 1024 ** 3,
          expire: now + 116 * 86400
        },
        lastError: null,
        lastUpdate: '2026-08-12T06:00:00.000Z'
      }],
      misc: {
        'node_cache_subscription_airport-detail': {
          nodes: [firstNode, secondNode],
          nodeCount: 2,
          updatedAt: '2026-08-12T06:00:00.000Z'
        }
      }
    });
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (String(url) === subscriptionUrl) throw new Error('stored detail must not fetch the subscription');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'open-subscription-detail',
        data: 'sub_detail_0',
        from: { id: 1 },
        message: { message_id: 92, chat: { id: 4005 } }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions[0]).toMatchObject({
      name: '悠悠',
      nodeCount: 2,
      userInfo: expect.objectContaining({ total: 200 * 1024 ** 3 }),
      lastError: null,
      lastUpdate: '2026-08-12T06:00:00.000Z'
    });
    expect(global.fetch.mock.calls.some(([url]) => String(url) === subscriptionUrl)).toBe(false);
    const editBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(editBody.text).toContain('<b>编号:</b> #1');
    expect(editBody.text).toContain('<b>配置名称:</b> <code>悠悠</code>');
    expect(editBody.text).toContain(`<code>${subscriptionUrl}</code>`);
    expect(editBody.text).toContain('<b>流量详情:</b> 158.00 GB / 200.00 GB');
    expect(editBody.text).toContain('<b>流量详情:</b> 158.00 GB / 200.00 GB 🟢 流量充足');
    expect(editBody.text).toMatch(/<b>🗓️ 过期时间:<\/b> .* 🟢 正常/);
    expect(editBody.text).toContain('<b>使用进度:</b>');
    expect(editBody.text).toContain('<b>剩余可用:</b> 42.00 GB');
    expect(editBody.text).toContain('<blockquote expandable>🔌 节点列表（共2个）');
    expect(editBody.text).not.toContain('<b>节点列表（共2个）</b>');
    expect(editBody.text).toContain('1. [ANYTLS] 剩余流量：41.96 GB');
    expect(editBody.text).not.toContain('<b>1. [ANYTLS] 剩余流量：41.96 GB</b>');
    expect(editBody.text).toContain('2. [ANYTLS] 距离下次重置剩余：116 天');
    expect(editBody.disable_web_page_preview).toBe(true);

    const buttons = editBody.reply_markup.inline_keyboard;
    expect(buttons).toHaveLength(4);
    expect(buttons[1]).toEqual([{
      text: '📋 复制配置名称',
      copy_text: { text: '悠悠' }
    }]);
    expect(buttons.flat().map(button => button.text)).toEqual([
      '🔄 刷新订阅', '🗑️ 删除订阅',
      '📋 复制配置名称',
      '📦 导出节点', '🔗 生成短链',
      '⬅️ 返回列表', '🏠 主菜单'
    ]);
    expect(buttons.flat().filter(button => button.text !== '📋 复制配置名称')
      .every(button => button.callback_data)).toBe(true);
  });

  it('shows stored metadata without fetching when no node-detail cache exists', async () => {
    const subscriptionUrl = 'https://airport.example/stored-metadata-only';
    const { state, adapter } = createState({
      subscriptions: [{
        name: 'Stored Metadata Airport',
        url: subscriptionUrl,
        enabled: true,
        nodeCount: 56,
        userInfo: {
          upload: 20 * 1024 ** 3,
          download: 80 * 1024 ** 3,
          total: 200 * 1024 ** 3,
          expire: Math.floor(Date.now() / 1000) + 90 * 86400
        },
        lastUpdate: '2026-08-12T06:00:00.000Z'
      }]
    });
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (String(url) === subscriptionUrl) throw new Error('stored detail must not fetch the subscription');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    const invoke = data => handleTelegramWebhook(createRequest({
      callback_query: {
        id: `stored-metadata-${data}`,
        data,
        from: { id: 1 },
        message: { message_id: 95, chat: { id: 4008 } }
      }
    }), { MISUB_KV: null });

    await invoke('sub_detail_0');
    expect(global.fetch.mock.calls.some(([url]) => String(url) === subscriptionUrl)).toBe(false);
    expect(state.subscriptions[0].id).toEqual(expect.any(String));
    const storedSession = Object.entries(state.misc)
      .find(([key]) => key.startsWith('tg_subscription_preview:'))?.[1];
    expect(storedSession?.savedSubscriptionId).toBe(state.subscriptions[0].id);
    const detailBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(detailBody.text).toContain('<b>流量详情:</b> 100.00 GB / 200.00 GB');
    expect(detailBody.text).toContain('节点列表（共56个）');
    expect(detailBody.text).toContain('暂无已缓存节点明细，请点击“刷新订阅”更新');

    const exportCallback = detailBody.reply_markup.inline_keyboard.flat()
      .find(button => button.text === '📦 导出节点').callback_data;
    await invoke(exportCallback);
    expect(global.fetch.mock.calls.some(([url]) => String(url).includes('/sendDocument'))).toBe(false);
    const callbackBodies = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/answerCallbackQuery'))
      .map(([, options]) => JSON.parse(options.body));
    expect(callbackBodies.at(-1)).toMatchObject({
      text: '暂无已缓存节点，请先刷新订阅',
      show_alert: true
    });
  });

  it('shows only unknown traffic and long-term expiry when stored subscription metadata is absent', async () => {
    const subscriptionUrl = 'https://airport.example/no-stored-metadata';
    const { adapter } = createState({
      subscriptions: [{
        id: 'airport-no-stored-metadata',
        name: 'No Metadata Airport',
        url: subscriptionUrl,
        enabled: true,
        nodeCount: 3
      }]
    });
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (String(url) === subscriptionUrl) throw new Error('stored detail must not fetch the subscription');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'open-no-metadata-subscription',
        data: 'sub_detail_0',
        from: { id: 1 },
        message: { message_id: 96, chat: { id: 4009 } }
      }
    }), { MISUB_KV: null });

    const detailBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(detailBody.text).toContain('📊 <b>流量详情:</b> 未知');
    expect(detailBody.text).toContain('<b>🗓️ 过期时间:</b> 长期有效');
    expect(detailBody.text).not.toContain('使用进度:');
    expect(detailBody.text).not.toContain('剩余可用:');
    expect(detailBody.text).not.toContain('剩余时间:');
    expect(detailBody.text).not.toContain('🟢 正常');
    expect(detailBody.text).not.toContain('🟢 流量充足');
  });

  it('migrates legacy URL-keyed node details when assigning a stored subscription id', async () => {
    const subscriptionUrl = 'https://airport.example/legacy-url-cache';
    const cachedNode = 'trojan://password@legacy.example.com:443#Legacy-Node';
    const legacyCacheKey = 'node_cache_subscription_url_5m2uvd';
    const { state, adapter } = createState({
      subscriptions: [{
        name: 'Legacy Cache Airport',
        url: subscriptionUrl,
        enabled: true,
        nodeCount: 1
      }],
      misc: {
        [legacyCacheKey]: {
          nodes: [cachedNode],
          nodeCount: 1
        }
      }
    });
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (String(url) === subscriptionUrl) throw new Error('legacy cached detail must not fetch the subscription');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    const invoke = id => handleTelegramWebhook(createRequest({
      callback_query: {
        id,
        data: 'sub_detail_0',
        from: { id: 1 },
        message: { message_id: 96, chat: { id: 4009 } }
      }
    }), { MISUB_KV: null });

    await invoke('legacy-detail-first');
    const assignedId = state.subscriptions[0].id;
    expect(assignedId).toEqual(expect.any(String));
    expect(state.misc[`node_cache_subscription_${encodeURIComponent(assignedId)}`]?.nodes).toEqual([cachedNode]);

    await invoke('legacy-detail-second');
    expect(global.fetch.mock.calls.some(([url]) => String(url) === subscriptionUrl)).toBe(false);
    const detailBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(detailBody.text).toContain('1. [TROJAN] Legacy-Node');
  });

  it('supports stored-subscription refresh, export, short link, delete cancel, and list return', async () => {
    const subscriptionUrl = 'https://airport.example/detail-actions';
    const firstNode = 'trojan://password@first.example.com:443#First-Node';
    const secondNode = 'trojan://password@second.example.com:443#Second-Node';
    let nodes = [firstNode];
    const { state, adapter } = createState({
      subscriptions: [{
        id: 'airport-detail-actions',
        name: 'Action Airport',
        url: subscriptionUrl,
        enabled: true
      }]
    });
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (String(url) === subscriptionUrl) {
        return new Response(btoa(`${nodes.join('\n')}\n`), {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename=Parsed-Action-Airport.yaml' }
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    const invoke = data => handleTelegramWebhook(createRequest({
      callback_query: {
        id: `detail-action-${data}`,
        data,
        from: { id: 1 },
        message: { message_id: 93, chat: { id: 4006 } }
      }
    }), { MISUB_KV: null });

    await invoke('sub_detail_0');
    const detailBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    const detailButtons = detailBody.reply_markup.inline_keyboard.flat();
    const callbackFor = label => detailButtons.find(button => button.text === label).callback_data;

    nodes = [firstNode, secondNode];
    await invoke(callbackFor('🔄 刷新订阅'));
    expect(state.subscriptions[0].nodeCount).toBe(2);
    expect(state.subscriptions[0].nodeUrls).toEqual([firstNode, secondNode]);
    const refreshedBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(refreshedBody.text).toContain('节点列表（共2个）');

    Object.keys(state.misc)
      .filter(key => key.startsWith('node_cache_subscription_'))
      .forEach(key => delete state.misc[key]);
    await invoke('sub_detail_0');
    const reopenedBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(reopenedBody.text).toContain('节点列表（共2个）');
    expect(reopenedBody.text).toContain('First-Node');
    expect(reopenedBody.text).toContain('Second-Node');

    await invoke(callbackFor('📦 导出节点'));
    const documentCall = global.fetch.mock.calls.find(([url]) => String(url).includes('/sendDocument'));
    expect(documentCall).toBeTruthy();
    expect(await documentCall[1].body.get('document').text()).toBe(`${firstNode}\n${secondNode}`);

    await invoke(callbackFor('🔗 生成短链'));
    expect(state.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ subscriptions: ['airport-detail-actions'] })
    ]));
    const sentBodies = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body));
    expect(sentBodies.some(body => body.text?.includes('https://example.com/profiles/tg-'))).toBe(true);

    await invoke(callbackFor('🗑️ 删除订阅'));
    const confirmBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(confirmBody.text).toContain('确认删除订阅');
    const cancelCallback = confirmBody.reply_markup.inline_keyboard.flat()
      .find(button => button.text === '❌ 取消').callback_data;
    await invoke(cancelCallback);
    expect(state.subscriptions).toHaveLength(1);
    const cancelledBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(cancelledBody.text).toContain('<b>配置名称:</b> <code>Action Airport</code>');

    await invoke(callbackFor('⬅️ 返回列表'));
    const listBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(listBody.text).toContain('订阅列表 共1个');
  });

  it('keeps each subscription node cache when refreshing subscriptions one by one', async () => {
    const firstUrl = 'https://airport.example/cache-first';
    const secondUrl = 'https://airport.example/cache-second';
    const firstNode = 'trojan://password@first-cache.example.com:443#First-Cache-Node';
    const secondNode = 'trojan://password@second-cache.example.com:443#Second-Cache-Node';
    const { state, adapter } = createState({
      subscriptions: [
        { id: 'cache-first', name: 'First Cache Airport', url: firstUrl, enabled: true },
        { id: 'cache-second', name: 'Second Cache Airport', url: secondUrl, enabled: true }
      ]
    });
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (String(url) === firstUrl) return new Response(btoa(`${firstNode}\n`), { status: 200 });
      if (String(url) === secondUrl) return new Response(btoa(`${secondNode}\n`), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    const invoke = data => handleTelegramWebhook(createRequest({
      callback_query: {
        id: `sequential-cache-${data}`,
        data,
        from: { id: 1 },
        message: { message_id: 98, chat: { id: 4010 } }
      }
    }), { MISUB_KV: null });

    await invoke('sub_detail_0');
    let detailBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    const firstRefresh = detailBody.reply_markup.inline_keyboard.flat()
      .find(button => button.text === '🔄 刷新订阅').callback_data;
    await invoke(firstRefresh);
    expect(state.misc['node_cache_subscription_cache-first']?.nodes).toEqual([firstNode]);

    await invoke('sub_detail_1');
    detailBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    const secondRefresh = detailBody.reply_markup.inline_keyboard.flat()
      .find(button => button.text === '🔄 刷新订阅').callback_data;
    await invoke(secondRefresh);

    expect(state.misc['node_cache_subscription_cache-first']?.nodes).toEqual([firstNode]);
    expect(state.misc['node_cache_subscription_cache-second']?.nodes).toEqual([secondNode]);
  });

  it('deletes a stored subscription and removes profile references after confirmation', async () => {
    const subscriptionUrl = 'https://airport.example/delete-detail';
    const nodeUrl = 'trojan://password@delete.example.com:443#Delete-Node';
    const { state, adapter } = createState({
      subscriptions: [{
        id: 'airport-delete-detail',
        name: 'Delete Airport',
        url: subscriptionUrl,
        enabled: true
      }],
      profiles: [{
        id: 'profile-delete-detail',
        name: 'Delete Profile',
        subscriptions: ['airport-delete-detail'],
        manualNodes: []
      }]
    });
    createAdapter.mockReturnValue(adapter);
    global.fetch = vi.fn(async url => {
      if (String(url) === subscriptionUrl) {
        return new Response(btoa(`${nodeUrl}\n`), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    const invoke = data => handleTelegramWebhook(createRequest({
      callback_query: {
        id: `delete-action-${data}`,
        data,
        from: { id: 1 },
        message: { message_id: 94, chat: { id: 4007 } }
      }
    }), { MISUB_KV: null });

    await invoke('sub_detail_0');
    const detailBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    const deleteCallback = detailBody.reply_markup.inline_keyboard.flat()
      .find(button => button.text === '🗑️ 删除订阅').callback_data;
    await invoke(deleteCallback);
    const confirmBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    const confirmCallback = confirmBody.reply_markup.inline_keyboard.flat()
      .find(button => button.text === '⚠️ 确认删除').callback_data;
    await invoke(confirmCallback);

    expect(state.subscriptions).toHaveLength(0);
    expect(state.profiles[0].subscriptions).toEqual([]);
    expect(clearAllNodeCaches).toHaveBeenCalledWith(adapter);
    const finalBody = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/editMessageText'))
      .map(([, options]) => JSON.parse(options.body))
      .at(-1);
    expect(finalBody.text).toContain('暂无机场订阅');
  });

  it('opens an airport subscription from an old mixed /list callback index instead of reporting object missing', async () => {
    const subscriptions = Array.from({ length: 29 }, (_, i) => ({
      id: `node-${i + 1}`,
      name: `Node ${i + 1}`,
      url: `vless://uuid@example${i + 1}.com:443#Node-${i + 1}`,
      enabled: true
    }));
    subscriptions.push({
      id: 'airport-30',
      name: '机场订阅 xhj',
      url: 'https://airport.example/sub/token',
      enabled: true
    });

    const { adapter } = createState({
      settings: {
        telegram_push_config: {
          enabled: true,
          bot_token: 'bot-token',
          webhook_secret: 'secret-token',
          allowed_user_ids: ['1', '2'],
          auto_bind: true,
          user_bindings: { '1': 'profile-1' }
        }
      },
      subscriptions
    });
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (String(url) === 'https://airport.example/sub/token') {
        return new Response(btoa('trojan://password@legacy.example.com:443#Legacy-Node\n'), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'callback-1',
        data: 'node_action_sub_29',
        from: { id: 1 },
        message: { message_id: 88, chat: { id: 4002 } }
      }
    }), { MISUB_KV: null });

    const fetchBodies = global.fetch.mock.calls
      .filter(([, options]) => options?.body)
      .map(([, options]) => JSON.parse(options.body));
    expect(fetchBodies).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '对象不存在', show_alert: true })
    ]));
    expect(fetchBodies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        chat_id: 4002,
        message_id: 88,
        text: expect.stringContaining('机场订阅 xhj'),
        reply_markup: expect.objectContaining({
          inline_keyboard: expect.arrayContaining([
            expect.arrayContaining([
              expect.objectContaining({ text: '🔄 刷新订阅' }),
              expect.objectContaining({ text: '🗑️ 删除订阅' })
            ])
          ])
        })
      })
    ]));
  });
});
