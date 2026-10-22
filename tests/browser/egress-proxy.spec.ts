import { createServer, request } from 'node:http';
import {
  createServer as tcpServer,
  type AddressInfo,
  type Socket,
} from 'node:net';
import { createEgressProxy } from '../../src/browser/policies/egress-proxy';
import type { NetworkPolicyService } from '../../src/browser/policies/network-policy.service';

test('proxy keeps a completed request open until the upstream response arrives', async () => {
  const fixture = createServer((_req, res) => {
    setTimeout(() => res.end('delayed response'), 30);
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const port = (fixture.address() as AddressInfo).port;
  // A test-only resolver permits the local fixture; production uses public-IP validation.
  const policy = {
    resolve: async () => ({
      url: new URL('http://fixture.test:' + port + '/'),
      address: '127.0.0.1',
      family: 4,
    }),
  } as unknown as NetworkPolicyService;
  const proxy = await createEgressProxy(policy);
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(
        proxy.url,
        { path: 'http://fixture.test/', method: 'GET' },
        (res) => {
          let text = '';
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () => resolve(text));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(body).toBe('delayed response');
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
});

// Sends CONNECT through the proxy and returns the proxy's status line.
const tunnel = (proxyUrl: string, target: string) =>
  new Promise<number>((resolve, reject) => {
    const req = request(proxyUrl, { method: 'CONNECT', path: target });
    req.on('connect', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode || 0);
    });
    req.on('error', reject);
    req.end();
  });

test('only the allowed session debugger port is tunnelled to loopback, and only via CONNECT', async () => {
  const debuggerServer = createServer((_req, res) => res.end('cdp'));
  await new Promise<void>((resolve) =>
    debuggerServer.listen(0, '127.0.0.1', resolve),
  );
  const port = (debuggerServer.address() as AddressInfo).port;
  const policy = {
    resolve: async () => {
      throw new Error('denied');
    },
  } as unknown as NetworkPolicyService;
  const proxy = await createEgressProxy(policy);
  try {
    expect(await tunnel(proxy.url, '127.0.0.1:' + port)).toBe(403);
    proxy.allowDebuggerTunnel(port);
    expect(await tunnel(proxy.url, '127.0.0.1:' + port)).toBe(200);
    expect(await tunnel(proxy.url, '127.0.0.1:' + (port + 1))).toBe(403);
    expect(await tunnel(proxy.url, 'localhost:' + port)).toBe(403);
    const plain = await new Promise<number>((resolve, reject) => {
      const req = request(
        proxy.url,
        { path: 'http://127.0.0.1:' + port + '/json/version', method: 'GET' },
        (res) => {
          res.resume();
          resolve(res.statusCode || 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(plain).toBe(403);
    expect(() => proxy.allowDebuggerTunnel(0)).toThrow('Invalid debugger port');
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => debuggerServer.close(() => resolve()));
  }
});

test('a client vanishing mid-tunnel does not crash the process', async () => {
  // Upstream keeps streaming, like an open CDP WebSocket when Chromium exits.
  const peers = new Set<Socket>();
  const streaming = tcpServer((socket) => {
    peers.add(socket);
    const timer = setInterval(() => socket.write(Buffer.alloc(64 * 1024)), 1);
    socket.on('error', () => undefined);
    socket.on('close', () => clearInterval(timer));
  });
  await new Promise<void>((resolve) =>
    streaming.listen(0, '127.0.0.1', resolve),
  );
  const port = (streaming.address() as AddressInfo).port;
  const proxy = await createEgressProxy({
    resolve: async () => {
      throw new Error('denied');
    },
  } as unknown as NetworkPolicyService);
  proxy.allowDebuggerTunnel(port);
  const uncaught: Error[] = [];
  const record = (error: Error) => uncaught.push(error);
  process.on('uncaughtException', record);
  try {
    for (let round = 0; round < 5; round++) {
      const socket = await new Promise<Socket>((resolve, reject) => {
        const req = request(proxy.url, {
          method: 'CONNECT',
          path: '127.0.0.1:' + port,
        });
        req.on('connect', (_res, tunnel) => resolve(tunnel));
        req.on('error', reject);
        req.end();
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      socket.resetAndDestroy();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(uncaught).toEqual([]);
  } finally {
    process.off('uncaughtException', record);
    for (const peer of peers) peer.destroy();
    await proxy.close();
    await new Promise<void>((resolve) => streaming.close(() => resolve()));
  }
});

// Phase 6: an unavailable or failing destination policy must deny, never allow.
test('the proxy fails closed when the destination policy fails, and refuses writes and upgrades', async () => {
  const policy = {
    resolve: async () => {
      throw new Error('policy unavailable');
    },
  } as unknown as NetworkPolicyService;
  const proxy = await createEgressProxy(policy);
  const plain = (method: string, headers: Record<string, string> = {}) =>
    new Promise<number>((resolve) => {
      const req = request(proxy.url, {
        path: 'http://example.com/',
        method,
        headers,
      });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode || 0);
      });
      // An upgrade the proxy does not serve ends the connection.
      req.on('error', () => resolve(0));
      req.on('upgrade', (_res, socket) => {
        socket.destroy();
        resolve(101);
      });
      req.end(method === 'POST' ? 'x' : undefined);
    });
  try {
    expect(await plain('GET')).toBe(403);
    expect(await plain('POST')).toBe(403);
    expect(
      await plain('GET', { connection: 'Upgrade', upgrade: 'websocket' }),
    ).not.toBe(101);
    expect(await tunnel(proxy.url, 'example.com:443')).toBe(403);
  } finally {
    await proxy.close();
  }
});
