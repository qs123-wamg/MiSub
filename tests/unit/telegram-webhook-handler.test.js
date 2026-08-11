import { beforeEach, describe, expect, it, vi } from 'vitest';

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
      get: vi.fn(async key => key.startsWith('tg_subscription_preview:') ? state.misc[key] || null : state.settings),
      put: vi.fn(async (key, value) => {
        if (key.startsWith('tg_subscription_preview:')) state.misc[key] = value;
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

      expect(state.settings.telegram_push_config.user_bindings).toEqual({
        '1': 'profile-1',
        '2': 'profile-2'
      });
      expect(state.subscriptions).toHaveLength(1);
      expect(state.profiles[0].manualNodes).toEqual([state.subscriptions[0].id]);
      expect(state.profiles[1].manualNodes).toEqual([]);
      expect(clearAllNodeCaches).toHaveBeenCalledTimes(1);
      expect(clearAllNodeCaches).toHaveBeenCalledWith(adapter);
      expect(infoSpy).toHaveBeenCalledWith('[Telegram Push] Cleared 1 node caches after node import');
      expect(infoSpy).toHaveBeenCalledWith('[Telegram Push] User 1 added 1 items (Ignored 0)');
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
    expect(card.text).toContain('节点总数:</b> 1');
    expect(card.text).toMatch(/使用进度:<\/b> [▰▱]{10} 3\.0%/);
    expect(card.text).toContain('Test-Node');
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
    expect(await documentCall[1].body.get('document').text()).toContain('proxies:');

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
    expect(body.text).toContain('获取订阅失败');
  });
  it('parses Base64 subscription text sent as a plain message', async () => {
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

    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions[0].url).toBe(nodeUrl);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.text).toContain('节点添加成功');
  });
  it('extracts node links from ordinary text messages', async () => {
    const nodeUrl = 'ss://YWVzLTI1Ni1nY206cGFzc0BleGFtcGxlLmNvbTo0NDM=#Node-A';
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      message: {
        text: `请导入这个节点：${nodeUrl}`,
        chat: { id: 2102 },
        from: { id: 1 }
      }
    }), { MISUB_KV: null });

    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions[0].url).toBe(nodeUrl);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.text).toContain('节点添加成功');
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

    expect(state.subscriptions).toHaveLength(1);
    expect(state.subscriptions[0].url).toBe(directNode);
    const sentBodies = global.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, options]) => JSON.parse(options.body));
    expect(sentBodies.some(body => body.text?.includes('Mixed'))).toBe(true);
    expect(sentBodies.some(body => body.text?.includes('节点添加成功'))).toBe(true);
  });
  it('refreshes a saved preview in place without creating a duplicate subscription', async () => {
    const subscriptionUrl = 'https://sub.example.com/refresh';
    const firstNode = 'trojan://password@one.example.com:443?security=tls#Node-One';
    const secondNode = 'trojan://password@two.example.com:443?security=tls#Node-Two';
    let responseNodes = [firstNode];
    let total = 1000;
    const { state, adapter } = createState();
    createAdapter.mockReturnValue(adapter);

    global.fetch = vi.fn(async url => {
      if (url === subscriptionUrl) {
        return new Response(btoa(`${responseNodes.join('\n')}\n`), {
          status: 200,
          headers: {
            'Content-Disposition': 'attachment; filename=Refresh.yaml',
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

    responseNodes = [firstNode, secondNode];
    total = 2000;
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
      url: subscriptionUrl,
      nodeCount: 2,
      userInfo: expect.objectContaining({ total: 2000 })
    });
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

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.text).toContain('/delete');
    expect(body.text).toContain('/search');
    expect(body.text).toContain('/sort');
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

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
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

    const { handleTelegramWebhook } = await import('../../functions/modules/handlers/telegram-webhook-handler.js');
    await handleTelegramWebhook(createRequest({
      callback_query: {
        id: 'callback-1',
        data: 'node_action_sub_29',
        from: { id: 1 },
        message: { message_id: 88, chat: { id: 4002 } }
      }
    }), { MISUB_KV: null });

    const fetchBodies = global.fetch.mock.calls.map(call => JSON.parse(call[1].body));
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
              expect.objectContaining({ callback_data: 'link_sub_0' })
            ])
          ])
        })
      })
    ]));
  });
});
