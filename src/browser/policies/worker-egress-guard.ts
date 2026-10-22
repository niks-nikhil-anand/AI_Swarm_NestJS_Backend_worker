import { BrowserError } from '../../common/errors/browser.errors';

export type EgressPredicate = (url: string, method: string) => boolean;
export interface WorkerEgressGuard {
  close(): void;
}
type Message = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
  sessionId?: string;
};
// Worker-like targets that Playwright's page routing does not cover.
const GUARDED_TYPES = [
  'service_worker',
  'shared_worker',
  'background_page',
  'worker',
];

/**
 * Applies the session's request policy to extension and worker targets.
 *
 * Playwright's context.route only sees page traffic. The Stagehand extension's service
 * worker and offscreen document make their own requests, which reach the egress proxy as
 * opaque HTTPS tunnels whose method the proxy cannot check. Every such target is
 * auto-attached paused, given Fetch interception, and only then released, so none of its
 * requests escape the predicate. If the guard's CDP connection is lost, `onLost` fires and
 * the caller must stop the browser (fail closed).
 */
export async function guardWorkerEgress(
  webSocketUrl: string,
  allow: EgressPredicate,
  onLost: () => void,
  timeoutMs: number,
): Promise<WorkerEgressGuard> {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const enabling: Promise<unknown>[] = [];
  const guarded: string[] = [];
  let nextId = 0;
  let closing = false;
  const send = (
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const attach = async (sessionId: string, url: string) => {
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId);
    guarded.push(url);
    await send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  };
  const decide = (params: Record<string, unknown>, sessionId?: string) => {
    const request = params.request as { url: string; method: string };
    const permitted =
      /^(chrome-extension|data|blob):/.test(request.url) ||
      allow(request.url, request.method);
    return send(
      permitted ? 'Fetch.continueRequest' : 'Fetch.failRequest',
      permitted
        ? { requestId: params.requestId }
        : { requestId: params.requestId, errorReason: 'BlockedByClient' },
      sessionId,
    ).catch(() => undefined);
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as Message;
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error.message));
      else waiter?.resolve(message.result);
    } else if (message.method === 'Target.attachedToTarget') {
      const params = message.params as {
        sessionId: string;
        targetInfo: { url: string };
      };
      // A target whose interception cannot be enabled stays paused (fail closed).
      enabling.push(
        attach(params.sessionId, params.targetInfo.url).catch(() => undefined),
      );
    } else if (message.method === 'Fetch.requestPaused')
      void decide(message.params!, message.sessionId);
  };
  socket.onclose = () => {
    for (const waiter of pending.values())
      waiter.reject(new Error('CDP connection closed'));
    pending.clear();
    if (!closing) onLost();
  };

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      (async () => {
        await new Promise<void>((resolve, reject) => {
          socket.onopen = () => resolve();
          socket.onerror = () => reject(new Error('CDP connection failed'));
        });
        await send('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
          filter: [
            ...GUARDED_TYPES.map((type) => ({ type, exclude: false })),
            { exclude: true },
          ],
        });
        await Promise.all(enabling);
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
      }),
    ]);
    // The Stagehand extension worker exists from launch; it must be guarded before use.
    if (!guarded.some((url) => url.startsWith('chrome-extension://')))
      throw new Error('extension worker was not intercepted');
  } catch (error) {
    closing = true;
    socket.close();
    throw new BrowserError(
      'WORKER_EGRESS_GUARD_FAILED',
      'Could not apply the request policy to extension workers: ' +
        (error instanceof Error ? error.message : 'unknown error'),
      503,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
  return {
    close() {
      closing = true;
      socket.close();
    },
  };
}
