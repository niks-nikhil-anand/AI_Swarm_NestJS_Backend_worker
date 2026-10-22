import {
  StagehandAdapter,
  assertManagedEndpoint,
} from '../../src/browser/adapters/stagehand/stagehand.adapter';
import { StagehandConnector } from '../../src/browser/adapters/stagehand/stagehand.connector';
import { stagehandExtensionPath } from '../../src/browser/adapters/stagehand/stagehand-extension';
import {
  ConfigurationService,
  loadConfiguration,
} from '../../src/config/configuration';
import type { ChromiumConnection } from '../../src/browser/chromium/chromium.connection';
import { ModelProviderError } from '../../src/browser/adapters/stagehand/model-provider';

const endpoint = {
  webSocketUrl: 'ws://127.0.0.1:45123/devtools/browser/0b5c',
  extensionId: 'abcdefghijklmnopabcdefghijklmnop',
};
class IncompatibleError extends Error {
  detail = 'protocol 1 is not 2.';
  remediation = 'Upgrade the extension.';
}
// Records the order of lifecycle calls made against the SDK double.
function fakeSdk(calls: string[], overrides: Record<string, unknown> = {}) {
  const browser = {
    close: jest.fn(async () => {
      calls.push('browser.close');
    }),
  };
  const client = {
    close: jest.fn(async () => {
      calls.push('client.close');
    }),
  };
  const sdk = {
    localBrowser: {
      connect: jest.fn(async (options: unknown) => {
        calls.push('connect ' + JSON.stringify(options));
        return browser;
      }),
    },
    Stagehand: {
      create: jest.fn(async (options: { browser: unknown }) => {
        calls.push(
          'create ' + (options.browser === browser ? 'same-browser' : 'other'),
        );
        return client;
      }),
    },
    StagehandRuntimeIncompatibleError: IncompatibleError,
    ...overrides,
  };
  return { sdk, browser, client };
}
const loader = (sdk: unknown) => async () =>
  sdk as unknown as typeof import('@browserbasehq/stagehand');

describe('Stagehand CDP endpoint policy', () => {
  test.each([
    ['missing endpoint', undefined],
    [
      'remote host',
      { ...endpoint, webSocketUrl: 'ws://10.0.0.5:9222/devtools/browser/x' },
    ],
    [
      'localhost alias',
      { ...endpoint, webSocketUrl: 'ws://localhost:9222/devtools/browser/x' },
    ],
    [
      'TLS endpoint',
      { ...endpoint, webSocketUrl: 'wss://127.0.0.1:9222/devtools/browser/x' },
    ],
    [
      'HTTP discovery URL',
      { ...endpoint, webSocketUrl: 'http://127.0.0.1:9222' },
    ],
    [
      'page target',
      { ...endpoint, webSocketUrl: 'ws://127.0.0.1:9222/devtools/page/x' },
    ],
    [
      'credentials',
      {
        ...endpoint,
        webSocketUrl: 'ws://a:b@127.0.0.1:9222/devtools/browser/x',
      },
    ],
    ['malformed URL', { ...endpoint, webSocketUrl: 'not a url' }],
    ['bad extension id', { ...endpoint, extensionId: '../../evil' }],
  ])('rejects %s with STAGEHAND_CDP_UNSUPPORTED', (_name, value) => {
    expect(() => assertManagedEndpoint(value)).toThrow(
      expect.objectContaining({ code: 'STAGEHAND_CDP_UNSUPPORTED' }),
    );
  });
  test('accepts the managed loopback browser endpoint', () => {
    expect(assertManagedEndpoint(endpoint)).toBe(endpoint);
  });
  test('locates the bundled Stagehand 4 extension', () => {
    expect(stagehandExtensionPath()).toMatch(
      /stagehand[\\/]dist[\\/]extension$/,
    );
    expect(() => stagehandExtensionPath([])).toThrow(
      expect.objectContaining({ code: 'STAGEHAND_EXTENSION_MISSING' }),
    );
  });
});

describe('StagehandAdapter connection', () => {
  test('connects with the 4.1.0 options and binds Stagehand to that browser', async () => {
    const calls: string[] = [];
    const { sdk } = fakeSdk(calls);
    const adapter = await StagehandAdapter.connect(
      endpoint,
      {},
      1000,
      loader(sdk),
    );
    expect(calls).toEqual([
      'connect ' +
        JSON.stringify({
          cdpUrl: endpoint.webSocketUrl,
          extensionId: endpoint.extensionId,
        }),
      'create same-browser',
    ]);
    expect(adapter).toBeInstanceOf(StagehandAdapter);
  });
  test('never loads the SDK for an unsupported endpoint', async () => {
    const sdkLoader = jest.fn();
    await expect(
      StagehandAdapter.connect(undefined, {}, 1000, sdkLoader),
    ).rejects.toMatchObject({ code: 'STAGEHAND_CDP_UNSUPPORTED' });
    expect(sdkLoader).not.toHaveBeenCalled();
  });
  test('maps connection failures to retryable STAGEHAND_CONNECT_FAILED', async () => {
    const { sdk } = fakeSdk([], {
      localBrowser: {
        connect: async () => {
          throw new Error('ECONNREFUSED 127.0.0.1:45123\nstack');
        },
      },
    });
    await expect(
      StagehandAdapter.connect(endpoint, {}, 1000, loader(sdk)),
    ).rejects.toMatchObject({
      code: 'STAGEHAND_CONNECT_FAILED',
      message:
        'Stagehand could not attach to the session browser: ECONNREFUSED 127.0.0.1:45123',
      retryable: true,
    });
  });
  test('reports an incompatible extension runtime with its remediation', async () => {
    const { sdk } = fakeSdk([], {
      Stagehand: {
        create: async () => {
          throw new IncompatibleError('incompatible');
        },
      },
    });
    await expect(
      StagehandAdapter.connect(endpoint, {}, 1000, loader(sdk)),
    ).rejects.toMatchObject({
      code: 'STAGEHAND_INCOMPATIBLE',
      message: expect.stringContaining('Upgrade the extension.'),
      retryable: false,
    });
  });
  test('times out and detaches a late attachment without stopping the browser', async () => {
    const calls: string[] = [];
    let finish: () => void = () => undefined;
    const { sdk, browser, client } = fakeSdk(calls);
    sdk.localBrowser.connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(browser);
        }),
    );
    await expect(
      StagehandAdapter.connect(endpoint, {}, 20, loader(sdk)),
    ).rejects.toMatchObject({
      code: 'STAGEHAND_CONNECT_TIMEOUT',
      retryable: true,
    });
    finish();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(browser.close).not.toHaveBeenCalled();
  });
});

describe('StagehandAdapter teardown', () => {
  test('detaches Stagehand, then stops Chromium, then releases the CDP socket', async () => {
    const calls: string[] = [];
    const { sdk } = fakeSdk(calls);
    const adapter = await StagehandAdapter.connect(
      endpoint,
      {},
      1000,
      loader(sdk),
    );
    calls.length = 0;
    await adapter.close(async () => {
      calls.push('stop chromium');
    });
    expect(calls).toEqual(['client.close', 'stop chromium', 'browser.close']);
  });
  test('still stops Chromium when detaching fails', async () => {
    const calls: string[] = [];
    const { sdk, client } = fakeSdk(calls);
    client.close.mockRejectedValue(new Error('rpc failed'));
    const adapter = await StagehandAdapter.connect(
      endpoint,
      {},
      1000,
      loader(sdk),
    );
    const stop = jest.fn(async () => undefined);
    await expect(adapter.close(stop)).rejects.toThrow('rpc failed');
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('StagehandConnector', () => {
  const config = (env: Record<string, string>) =>
    new ConfigurationService(
      loadConfiguration('browser', {
        DATABASE_URL: 'postgresql://u:p@localhost/db',
        BROWSER_ALLOWED_DOMAINS: 'example.com',
        ...env,
      }),
    );
  const connection = {
    closed: false,
    stagehand: endpoint,
  } as unknown as ChromiumConnection;
  afterEach(() => jest.restoreAllMocks());
  test('is disabled unless STAGEHAND_ENABLED=true', async () => {
    const connector = new StagehandConnector(config({}), null);
    expect(connector.enabled).toBe(false);
    expect(connector.semantic).toBe(false);
    expect(() => connector.connect(connection)).toThrow(
      expect.objectContaining({ code: 'STAGEHAND_DISABLED' }),
    );
  });
  test('without a model provider, Stagehand gets no model configuration', async () => {
    const connect = jest
      .spyOn(StagehandAdapter, 'connect')
      .mockResolvedValue({} as StagehandAdapter);
    await new StagehandConnector(
      config({ STAGEHAND_ENABLED: 'true' }),
      null,
    ).connect(connection);
    expect(connect.mock.calls[0][1]).not.toHaveProperty('model');
  });
  test('closing the session aborts the in-flight model request', async () => {
    const adapter = Object.assign(
      Object.create(StagehandAdapter.prototype) as StagehandAdapter,
      { usage: { calls: 0, tokens: 0 }, aborts: new AbortController() },
    );
    const connect = jest
      .spyOn(StagehandAdapter, 'connect')
      .mockResolvedValue(adapter);
    let seen: AbortSignal | undefined;
    const generate = jest.fn(
      (_params: unknown, options?: { signal?: AbortSignal }) => {
        seen = options?.signal;
        return new Promise<never>(() => undefined);
      },
    );
    await new StagehandConnector(config({ STAGEHAND_ENABLED: 'true' }), {
      generate,
    }).connect(connection);
    const hook = (
      connect.mock.calls[0][1] as {
        model: { generate: (params: unknown) => Promise<unknown> };
      }
    ).model.generate;
    void hook({ messages: [] });
    expect(seen?.aborted).toBe(false);
    adapter.aborts.abort();
    expect(seen?.aborted).toBe(true);
  });
  test('routes model calls to the provider in this process and keeps typed failures', async () => {
    const adapter = Object.assign(
      Object.create(StagehandAdapter.prototype) as StagehandAdapter,
      { usage: { calls: 0, tokens: 0 }, aborts: new AbortController() },
    );
    const connect = jest
      .spyOn(StagehandAdapter, 'connect')
      .mockResolvedValue(adapter);
    const generate = jest
      .fn()
      .mockResolvedValueOnce({
        role: 'assistant',
        content: [],
        outputFormat: 'text',
      })
      .mockRejectedValueOnce(
        new ModelProviderError('MODEL_RATE_LIMITED', 'rate limited', true),
      )
      .mockRejectedValueOnce(new Error('socket hang up'));
    const connector = new StagehandConnector(
      config({ STAGEHAND_ENABLED: 'true' }),
      { generate },
    );
    expect(connector.semantic).toBe(true);
    await connector.connect(connection);
    const options = connect.mock.calls[0][1] as {
      model: { generate: (params: unknown) => Promise<unknown> };
    };
    // Only a client-side generate hook: no model name or key reaches the extension.
    expect(Object.keys(options.model)).toEqual(['generate']);
    await expect(
      options.model.generate({ messages: [] }),
    ).resolves.toMatchObject({
      outputFormat: 'text',
    });
    await expect(
      options.model.generate({ messages: [] }),
    ).rejects.toMatchObject({
      code: 'MODEL_RATE_LIMITED',
    });
    expect(adapter.lastModelError).toMatchObject({
      code: 'MODEL_RATE_LIMITED',
    });
    await expect(
      options.model.generate({ messages: [] }),
    ).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE',
    });
  });
  test('enforces the per-step model call and token budget', async () => {
    const adapter = Object.assign(
      Object.create(StagehandAdapter.prototype) as StagehandAdapter,
      { usage: { calls: 0, tokens: 0 }, aborts: new AbortController() },
    );
    const connect = jest
      .spyOn(StagehandAdapter, 'connect')
      .mockResolvedValue(adapter);
    const generate = jest.fn(async () => ({
      role: 'assistant' as const,
      content: [],
      outputFormat: 'text' as const,
      usage: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 },
    }));
    await new StagehandConnector(
      config({
        STAGEHAND_ENABLED: 'true',
        STAGEHAND_STEP_MAX_MODEL_CALLS: '2',
        STAGEHAND_STEP_MAX_MODEL_TOKENS: '2500',
      }),
      { generate },
    ).connect(connection);
    expect(adapter.budget).toEqual({ calls: 2, tokens: 2500 });
    const hook = (
      connect.mock.calls[0][1] as {
        model: { generate: (params: unknown) => Promise<unknown> };
      }
    ).model.generate;
    adapter.beginStep();
    await hook({ messages: [] });
    await hook({ messages: [] });
    // The third call is refused before it reaches the provider.
    await expect(hook({ messages: [] })).rejects.toMatchObject({
      code: 'MODEL_BUDGET_EXCEEDED',
      retryable: false,
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(adapter.lastModelError).toMatchObject({
      code: 'MODEL_BUDGET_EXCEEDED',
    });
    // A new step starts with a fresh budget; crossing the token ceiling also fails.
    adapter.beginStep();
    expect(adapter.usage).toEqual({ calls: 0, tokens: 0 });
    adapter.budget = { calls: 10, tokens: 1500 };
    await hook({ messages: [] });
    await expect(hook({ messages: [] })).rejects.toMatchObject({
      code: 'MODEL_BUDGET_EXCEEDED',
      message: expect.stringContaining('token budget'),
    });
  });
  test('refuses a browser that has already disconnected', () => {
    const connector = new StagehandConnector(
      config({ STAGEHAND_ENABLED: 'true' }),
      null,
    );
    expect(() =>
      connector.connect({
        closed: true,
        stagehand: endpoint,
      } as unknown as ChromiumConnection),
    ).toThrow(expect.objectContaining({ code: 'SESSION_DISCONNECTED' }));
  });
});
