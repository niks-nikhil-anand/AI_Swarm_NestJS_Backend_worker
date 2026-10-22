import { guardWorkerEgress } from '../../src/browser/policies/worker-egress-guard';

const WORKER =
  'chrome-extension://phimejpcknbfklafnfpnminabcholhkb/service-worker.js';
type Sent = {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
};

// Scripted CDP endpoint: answers commands and lets the test push events.
class FakeCdp {
  static current: FakeCdp;
  static targets: string[] = [WORKER];
  sent: Sent[] = [];
  onopen?: () => void;
  onerror?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor(readonly url: string) {
    FakeCdp.current = this;
    setTimeout(() => this.onopen?.(), 0);
  }
  send(raw: string) {
    const message = JSON.parse(raw) as Sent;
    this.sent.push(message);
    if (message.method === 'Target.setAutoAttach')
      FakeCdp.targets.forEach((url, index) =>
        this.emit('Target.attachedToTarget', {
          sessionId: 'session-' + index,
          targetInfo: { url },
        }),
      );
    setTimeout(() => this.reply(message.id), 0);
  }
  reply(id: number) {
    this.onmessage?.({ data: JSON.stringify({ id, result: {} }) });
  }
  emit(method: string, params: unknown, sessionId?: string) {
    this.onmessage?.({ data: JSON.stringify({ method, params, sessionId }) });
  }
  close() {
    setTimeout(() => this.onclose?.(), 0);
  }
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
const allowGet = (url: string, method: string) =>
  new URL(url).hostname === 'example.com' && method === 'GET';

describe('Worker egress guard', () => {
  const realWebSocket = globalThis.WebSocket;
  beforeEach(() => {
    FakeCdp.targets = [WORKER];
    (globalThis as { WebSocket: unknown }).WebSocket = FakeCdp;
  });
  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  });

  test('pauses worker targets, enables interception, then releases them', async () => {
    const guard = await guardWorkerEgress(
      'ws://127.0.0.1:1/devtools/browser/x',
      allowGet,
      jest.fn(),
      1000,
    );
    const methods = FakeCdp.current.sent.map(
      (m) => m.method + (m.sessionId ? '@' + m.sessionId : ''),
    );
    expect(methods).toEqual([
      'Target.setAutoAttach',
      'Fetch.enable@session-0',
      'Runtime.runIfWaitingForDebugger@session-0',
    ]);
    expect(FakeCdp.current.sent[0].params).toMatchObject({
      autoAttach: true,
      waitForDebuggerOnStart: true,
      filter: expect.arrayContaining([
        { type: 'service_worker', exclude: false },
        { exclude: true },
      ]),
    });
    guard.close();
  });

  test('applies the session predicate to worker requests', async () => {
    const guard = await guardWorkerEgress(
      'ws://127.0.0.1:1/devtools/browser/x',
      allowGet,
      jest.fn(),
      1000,
    );
    const cdp = FakeCdp.current;
    cdp.sent.length = 0;
    for (const [requestId, url, method] of [
      ['1', 'https://example.com/', 'GET'],
      ['2', 'https://example.com/', 'POST'],
      ['3', 'https://telemetry.invalid/v1/traces', 'POST'],
      ['4', WORKER, 'GET'],
    ])
      cdp.emit(
        'Fetch.requestPaused',
        { requestId, request: { url, method } },
        'session-0',
      );
    await flush();
    expect(
      cdp.sent.map((m) => [m.params.requestId, m.method, m.params.errorReason]),
    ).toEqual([
      ['1', 'Fetch.continueRequest', undefined],
      ['2', 'Fetch.failRequest', 'BlockedByClient'],
      ['3', 'Fetch.failRequest', 'BlockedByClient'],
      ['4', 'Fetch.continueRequest', undefined],
    ]);
    guard.close();
  });

  test('fails closed when the extension worker is not intercepted', async () => {
    FakeCdp.targets = [];
    await expect(
      guardWorkerEgress(
        'ws://127.0.0.1:1/devtools/browser/x',
        allowGet,
        jest.fn(),
        1000,
      ),
    ).rejects.toMatchObject({ code: 'WORKER_EGRESS_GUARD_FAILED' });
  });

  test('reports a lost CDP connection but not a requested close', async () => {
    const lost = jest.fn();
    const guard = await guardWorkerEgress(
      'ws://127.0.0.1:1/devtools/browser/x',
      allowGet,
      lost,
      1000,
    );
    FakeCdp.current.onclose?.();
    expect(lost).toHaveBeenCalledTimes(1);
    const second = jest.fn();
    const other = await guardWorkerEgress(
      'ws://127.0.0.1:1/devtools/browser/x',
      allowGet,
      second,
      1000,
    );
    other.close();
    await flush();
    expect(second).not.toHaveBeenCalled();
    guard.close();
  });

  test('times out when the browser never answers', async () => {
    class Silent extends FakeCdp {
      send() {}
    }
    (globalThis as { WebSocket: unknown }).WebSocket = Silent;
    await expect(
      guardWorkerEgress(
        'ws://127.0.0.1:1/devtools/browser/x',
        allowGet,
        jest.fn(),
        50,
      ),
    ).rejects.toMatchObject({
      code: 'WORKER_EGRESS_GUARD_FAILED',
      message: expect.stringContaining('timed out'),
    });
  });
});
