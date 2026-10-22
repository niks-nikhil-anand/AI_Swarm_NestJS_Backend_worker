import type {
  Stagehand,
  StagehandBrowser,
  StagehandCreateOptions,
} from '@browserbasehq/stagehand';
import { BrowserError } from '../../../common/errors/browser.errors';
import type { ServiceError } from '../../../common/errors/service.error';
import type { StagehandEndpoint } from '../../chromium/chromium.connection';

type StagehandSdk = typeof import('@browserbasehq/stagehand');
export type StagehandOptions = Omit<StagehandCreateOptions, 'browser'>;
const loadSdk = () => import('@browserbasehq/stagehand');
const DETACH_GRACE_MS = 1000;

const unsupported = (message: string) =>
  new BrowserError('STAGEHAND_CDP_UNSUPPORTED', message, 409);

// Stagehand may only attach to the loopback endpoint of a Chromium this process launched.
export function assertManagedEndpoint(
  endpoint: StagehandEndpoint | undefined,
): StagehandEndpoint {
  if (!endpoint)
    throw unsupported(
      'Session Chromium was launched without the Stagehand extension; set STAGEHAND_ENABLED=true',
    );
  let url: URL;
  try {
    url = new URL(endpoint.webSocketUrl);
  } catch {
    throw unsupported('Stagehand CDP endpoint is not a valid URL');
  }
  if (
    url.protocol !== 'ws:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    !url.pathname.startsWith('/devtools/browser/')
  )
    throw unsupported(
      'Stagehand only connects to the loopback browser endpoint of a managed session',
    );
  if (!/^[a-p]{32}$/.test(endpoint.extensionId))
    throw unsupported('Stagehand extension id is not a Chromium extension id');
  return endpoint;
}

/**
 * Stagehand client attached to one session's Chromium. The adapter never owns the
 * Chromium process: ChromiumConnection launches and stops it.
 */
export class StagehandAdapter {
  private closing?: Promise<void>;
  // Typed failure of the latest model call; Stagehand's RPC only relays its message.
  lastModelError?: ServiceError;
  // Model usage of the current semantic step and its limits (set by the connector).
  usage = { calls: 0, tokens: 0 };
  // Aborted when the session closes, so an in-flight model request stops with it.
  readonly aborts = new AbortController();
  budget?: { calls: number; tokens: number };
  beginStep() {
    this.lastModelError = undefined;
    this.usage = { calls: 0, tokens: 0 };
  }
  private constructor(
    readonly browser: StagehandBrowser,
    readonly client: Stagehand,
  ) {}

  static async connect(
    endpoint: StagehandEndpoint | undefined,
    options: StagehandOptions,
    timeoutMs: number,
    sdkLoader: () => Promise<StagehandSdk> = loadSdk,
  ) {
    const target = assertManagedEndpoint(endpoint);
    const sdk = await sdkLoader();
    const attempt = (async () => {
      // Stagehand 4.1.0: connect accepts only { cdpUrl, extensionId }.
      const browser = await sdk.localBrowser.connect({
        cdpUrl: target.webSocketUrl,
        extensionId: target.extensionId,
      });
      return new StagehandAdapter(
        browser,
        await sdk.Stagehand.create({ ...options, browser }),
      );
    })();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        attempt,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new BrowserError(
                  'STAGEHAND_CONNECT_TIMEOUT',
                  'Stagehand did not attach to the session browser within ' +
                    timeoutMs +
                    'ms',
                  503,
                  true,
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      // A late attachment is detached; the caller stops the browser itself.
      void attempt.then((late) => late.detach()).catch(() => undefined);
      if (error instanceof BrowserError) throw error;
      if (error instanceof sdk.StagehandRuntimeIncompatibleError)
        throw new BrowserError(
          'STAGEHAND_INCOMPATIBLE',
          'Stagehand extension runtime is incompatible: ' +
            error.detail +
            ' ' +
            error.remediation,
          500,
        );
      throw new BrowserError(
        'STAGEHAND_CONNECT_FAILED',
        'Stagehand could not attach to the session browser: ' +
          (error instanceof Error
            ? error.message.split('\n')[0]
            : 'unknown error'),
        503,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // Ends the Stagehand session; the browser keeps running (Stagehand 4 close semantics).
  detach() {
    this.closing ??= this.client.close();
    return this.closing;
  }

  /**
   * Teardown order: detach Stagehand, let the owner stop Chromium, then release the
   * CDP socket. StagehandBrowser.close() sends Browser.close for connected local browsers,
   * so it runs only after the process is already gone.
   */
  async close(stopBrowser: () => Promise<void>) {
    this.aborts.abort();
    let timer: NodeJS.Timeout | undefined;
    try {
      // The extension flushes traces on close and retries the (deliberately unreachable)
      // exporter for seconds; Chromium is stopped next anyway, so bound the graceful part.
      await Promise.race([
        this.detach(),
        new Promise((resolve) => {
          timer = setTimeout(resolve, DETACH_GRACE_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      try {
        await stopBrowser();
      } finally {
        await this.browser.close().catch(() => undefined);
      }
    }
  }
}
