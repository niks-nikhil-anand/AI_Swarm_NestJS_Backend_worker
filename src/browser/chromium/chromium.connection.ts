import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { BrowserError } from '../../common/errors/browser.errors';
import {
  RESEARCH_CHROMIUM_ARGS,
  stagehandChromiumArgs,
} from './chromium.options';
import {
  stagehandExtensionPath,
  unpackedExtensionId,
} from '../adapters/stagehand/stagehand-extension';

export interface ChromiumLaunchOptions {
  headless: boolean;
  sandbox: boolean;
  proxyUrl: string;
  timeoutMs: number;
  stagehand: boolean;
}
// Loopback CDP endpoint of one managed Chromium, plus the Stagehand extension it loaded.
export interface StagehandEndpoint {
  webSocketUrl: string;
  extensionId: string;
}
export type PersistentLauncher = (
  profileDir: string,
  options: Parameters<typeof chromium.launchPersistentContext>[1],
) => Promise<BrowserContext>;

const launchTimeout = (message: string) =>
  new BrowserError('BROWSER_LAUNCH_TIMEOUT', message, 503, true);

/**
 * One Chromium process with one persistent context and a private, temporary profile.
 * The connection owns the process and the profile directory; close() is idempotent and
 * removes both. Sessions never share a connection, so cookies, storage and pages are
 * isolated per process.
 */
export class ChromiumConnection {
  private closing?: Promise<void>;
  private disconnected = false;
  private readonly listeners = new Set<() => void>();
  private constructor(
    readonly context: BrowserContext,
    readonly profileDir: string,
    readonly stagehand: StagehandEndpoint | undefined,
  ) {
    context.once('close', () => {
      this.disconnected = true;
      for (const listener of this.listeners) listener();
      this.listeners.clear();
    });
  }
  get closed() {
    return this.disconnected || this.closing !== undefined;
  }

  static async launch(
    options: ChromiumLaunchOptions,
    launch: PersistentLauncher = (dir, settings) =>
      chromium.launchPersistentContext(dir, settings),
  ) {
    const until = Date.now() + options.timeoutMs;
    const profileDir = await mkdtemp(join(tmpdir(), 'swarm-chromium-'));
    let context: BrowserContext | undefined;
    try {
      const extension = options.stagehand
        ? stagehandExtensionPath()
        : undefined;
      const extensionId = extension && unpackedExtensionId(extension);
      context = await launch(profileDir, {
        headless: options.headless,
        chromiumSandbox: options.sandbox,
        // The headless shell cannot load extensions; Stagehand needs full Chromium.
        ...(extension
          ? { channel: 'chromium', ignoreDefaultArgs: ['--disable-extensions'] }
          : {}),
        args: [
          ...RESEARCH_CHROMIUM_ARGS,
          ...(extension && extensionId
            ? stagehandChromiumArgs(extension, extensionId)
            : []),
        ],
        proxy: { server: options.proxyUrl, bypass: '<-loopback>' },
        serviceWorkers: 'block',
        acceptDownloads: false,
        timeout: options.timeoutMs,
        // Playwright would otherwise kill every browser on the first SIGTERM/SIGINT/SIGHUP,
        // failing in-flight steps mid-action. The worker's own shutdown (Temporal's grace
        // period, then module teardown closing each session) decides when browsers stop.
        handleSIGTERM: false,
        handleSIGINT: false,
        handleSIGHUP: false,
      });
      const endpoint = extensionId
        ? await ChromiumConnection.endpoint(
            context,
            profileDir,
            extensionId,
            until,
          )
        : undefined;
      return new ChromiumConnection(context, profileDir, endpoint);
    } catch (error) {
      await context?.close().catch(() => undefined);
      await rm(profileDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
      if (error instanceof BrowserError) throw error;
      const reason =
        error instanceof Error ? error.message.split('\n')[0] : 'unknown error';
      if (error instanceof Error && error.name === 'TimeoutError')
        throw launchTimeout('Chromium did not start in time: ' + reason);
      throw new BrowserError(
        'BROWSER_LAUNCH_FAILED',
        'Chromium failed to start: ' + reason,
        503,
        true,
      );
    }
  }

  // Reads the port Chromium picked for --remote-debugging-port=0 from its own profile,
  // so no port is reserved ahead of time and no HTTP discovery request is needed.
  private static async endpoint(
    context: BrowserContext,
    profileDir: string,
    expectedId: string,
    until: number,
  ): Promise<StagehandEndpoint> {
    const isExtension = (url: string) =>
      url.startsWith('chrome-extension://') &&
      url.endsWith('/service-worker.js');
    const worker =
      context.serviceWorkers().find((item) => isExtension(item.url())) ||
      (await context
        .waitForEvent('serviceworker', {
          predicate: (item) => isExtension(item.url()),
          timeout: Math.max(1, until - Date.now()),
        })
        .catch(() => {
          throw launchTimeout(
            'Chromium did not load the Stagehand extension in time',
          );
        }));
    const extensionId = new URL(worker.url()).hostname;
    if (extensionId !== expectedId)
      throw new BrowserError(
        'STAGEHAND_EXTENSION_MISMATCH',
        'Chromium assigned an unexpected id to the Stagehand extension; the CDP origin allowlist would not match',
        500,
      );
    while (Date.now() < until) {
      const active = await readFile(
        join(profileDir, 'DevToolsActivePort'),
        'utf8',
      ).catch(() => '');
      const [port, path] = active.split('\n').map((line) => line.trim());
      if (/^\d+$/.test(port) && path?.startsWith('/devtools/browser/'))
        return { webSocketUrl: 'ws://127.0.0.1:' + port + path, extensionId };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw launchTimeout(
      'Chromium did not expose its debugging endpoint in time',
    );
  }

  // Fires once when Chromium exits or the context closes, whether or not close() was called.
  onDisconnect(listener: () => void) {
    if (this.disconnected) listener();
    else this.listeners.add(listener);
  }

  close() {
    this.closing ??= (async () => {
      try {
        await this.context.close();
      } finally {
        await rm(this.profileDir, { recursive: true, force: true });
      }
    })();
    return this.closing;
  }
}
