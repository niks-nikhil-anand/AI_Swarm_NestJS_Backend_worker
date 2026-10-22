import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import {
  ChromiumConnection,
  type ChromiumLaunchOptions,
  type PersistentLauncher,
} from '../../src/browser/chromium/chromium.connection';
import {
  extensionIdForPath,
  stagehandExtensionPath,
  unpackedExtensionId,
} from '../../src/browser/adapters/stagehand/stagehand-extension';

const EXTENSION_ID = unpackedExtensionId(stagehandExtensionPath());
const options = (overrides: Partial<ChromiumLaunchOptions> = {}) => ({
  headless: true,
  sandbox: true,
  proxyUrl: 'http://127.0.0.1:1',
  timeoutMs: 5000,
  stagehand: false,
  ...overrides,
});
// Minimal persistent-context double: emits 'close' once, like Playwright.
function fakeContext(workers: string[] = []) {
  const events = new EventEmitter();
  const context = {
    once: events.once.bind(events),
    on: events.on.bind(events),
    emit: events.emit.bind(events),
    serviceWorkers: () => workers.map((url) => ({ url: () => url })),
    waitForEvent: jest.fn(() => new Promise(() => undefined)),
    close: jest.fn(async () => {
      events.emit('close');
    }),
  };
  return context as unknown as BrowserContext & {
    close: jest.Mock;
    waitForEvent: jest.Mock;
  };
}

describe('ChromiumConnection', () => {
  test('passes sandbox, headless mode and proxy to Playwright without extension flags by default', async () => {
    const context = fakeContext();
    let settings: Parameters<PersistentLauncher>[1];
    const connection = await ChromiumConnection.launch(
      options({ headless: false }),
      async (_dir, launchOptions) => {
        settings = launchOptions;
        return context;
      },
    );
    expect(settings!).toMatchObject({
      headless: false,
      chromiumSandbox: true,
      proxy: { server: 'http://127.0.0.1:1', bypass: '<-loopback>' },
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    expect(settings!.channel).toBeUndefined();
    expect(settings!.args?.join(' ')).not.toContain('remote-debugging');
    expect(connection.stagehand).toBeUndefined();
    await connection.close();
  });

  test('discovers the loopback CDP endpoint and extension id for Stagehand', async () => {
    const context = fakeContext([
      'chrome-extension://' + EXTENSION_ID + '/service-worker.js',
    ]);
    let settings: Parameters<PersistentLauncher>[1];
    const connection = await ChromiumConnection.launch(
      options({ stagehand: true }),
      async (dir, launchOptions) => {
        settings = launchOptions;
        await writeFile(
          join(dir, 'DevToolsActivePort'),
          '45123\n/devtools/browser/0b5c\n',
        );
        return context;
      },
    );
    expect(connection.stagehand).toEqual({
      webSocketUrl: 'ws://127.0.0.1:45123/devtools/browser/0b5c',
      extensionId: EXTENSION_ID,
    });
    expect(settings!.channel).toBe('chromium');
    expect(settings!.chromiumSandbox).toBe(true);
    expect(settings!.args).toEqual(
      expect.arrayContaining([
        '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1',
        '--remote-allow-origins=chrome-extension://' + EXTENSION_ID,
      ]),
    );
    expect(settings!.args?.join(' ')).not.toContain('--remote-allow-origins=*');
    await connection.close();
  });

  test('refuses an extension whose id differs from the CDP origin allowlist', async () => {
    const context = fakeContext([
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/service-worker.js',
    ]);
    await expect(
      ChromiumConnection.launch(
        options({ stagehand: true }),
        async () => context,
      ),
    ).rejects.toMatchObject({ code: 'STAGEHAND_EXTENSION_MISMATCH' });
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  test('derives the id Chromium assigns to an unpacked extension', () => {
    // Id reported by Chromium 153 for this path in the Linux test container.
    expect(
      extensionIdForPath(
        '/deps/node_modules/@browserbasehq/stagehand/dist/extension',
        'linux',
      ),
    ).toBe('phimejpcknbfklafnfpnminabcholhkb');
    expect(extensionIdForPath('c:\\ext', 'win32')).toBe(
      extensionIdForPath('C:\\ext', 'win32'),
    );
    expect(extensionIdForPath('C:\\ext', 'win32')).not.toBe(
      extensionIdForPath('C:\\ext', 'linux'),
    );
  });

  test('startup failure closes the browser and removes the profile', async () => {
    let profile = '';
    await expect(
      ChromiumConnection.launch(options(), async (dir) => {
        profile = dir;
        throw new Error('spawn UNKNOWN\ncall log');
      }),
    ).rejects.toMatchObject({
      code: 'BROWSER_LAUNCH_FAILED',
      message: 'Chromium failed to start: spawn UNKNOWN',
      retryable: true,
    });
    expect(existsSync(profile)).toBe(false);
  });

  test('a launch timeout is reported as retryable BROWSER_LAUNCH_TIMEOUT', async () => {
    const timeout = Object.assign(new Error('Timeout 5000ms exceeded'), {
      name: 'TimeoutError',
    });
    await expect(
      ChromiumConnection.launch(options(), async () => {
        throw timeout;
      }),
    ).rejects.toMatchObject({
      code: 'BROWSER_LAUNCH_TIMEOUT',
      retryable: true,
    });
  });

  test('a browser that never exposes the extension is stopped after the deadline', async () => {
    const context = fakeContext();
    context.waitForEvent.mockRejectedValue(new Error('Timeout'));
    let profile = '';
    await expect(
      ChromiumConnection.launch(
        options({ stagehand: true, timeoutMs: 100 }),
        async (dir) => {
          profile = dir;
          return context;
        },
      ),
    ).rejects.toMatchObject({ code: 'BROWSER_LAUNCH_TIMEOUT' });
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(existsSync(profile)).toBe(false);
  });

  test('a browser that never writes its debugging port is stopped after the deadline', async () => {
    const context = fakeContext([
      'chrome-extension://' + EXTENSION_ID + '/service-worker.js',
    ]);
    await expect(
      ChromiumConnection.launch(
        options({ stagehand: true, timeoutMs: 200 }),
        async () => context,
      ),
    ).rejects.toMatchObject({
      code: 'BROWSER_LAUNCH_TIMEOUT',
      message: 'Chromium did not expose its debugging endpoint in time',
    });
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  test('close is idempotent, removes the profile and notifies disconnect listeners', async () => {
    const context = fakeContext();
    const connection = await ChromiumConnection.launch(
      options(),
      async () => context,
    );
    const disconnected = jest.fn();
    connection.onDisconnect(disconnected);
    await Promise.all([connection.close(), connection.close()]);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(existsSync(connection.profileDir)).toBe(false);
    expect(connection.closed).toBe(true);
    expect(disconnected).toHaveBeenCalledTimes(1);
    const late = jest.fn();
    connection.onDisconnect(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  test('an unexpected browser exit marks the connection closed', async () => {
    const context = fakeContext();
    const connection = await ChromiumConnection.launch(
      options(),
      async () => context,
    );
    const disconnected = jest.fn();
    connection.onDisconnect(disconnected);
    (context as unknown as Pick<EventEmitter, 'emit'>).emit('close');
    expect(connection.closed).toBe(true);
    expect(disconnected).toHaveBeenCalledTimes(1);
    await connection.close();
  });
});
