import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { NetworkPolicyService } from './network-policy.service';

// Connects to the validated IP, rather than resolving the hostname again.
export async function createEgressProxy(policy: NetworkPolicyService) {
  const sockets = new Set<Socket>();
  // The session's own CDP port, tunnelled for the Stagehand extension only. Plain HTTP to
  // it (the /json discovery endpoints) stays denied; Chromium additionally rejects any
  // WebSocket whose Origin is not the extension.
  let debuggerPort: number | undefined;
  const server = createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method || '')) {
        res.writeHead(403);
        res.end();
        return;
      }
      const target = await policy.resolve(req.url || '');
      if (target.url.protocol !== 'http:')
        throw new Error('HTTPS requires CONNECT');
      const headers: Record<string, string | string[] | undefined> = {
        ...req.headers,
        host: target.url.host,
      };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const upstream = httpRequest(
        {
          hostname: target.address,
          family: target.family,
          port: Number(target.url.port || 80),
          path: target.url.pathname + target.url.search,
          method: req.method,
          headers,
          timeout: 15000,
        },
        (reply) => {
          res.writeHead(reply.statusCode || 502, reply.headers);
          reply.pipe(res);
        },
      );
      upstream.on('socket', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => {
        if (!res.writableEnded) upstream.destroy();
      });
      req.pipe(upstream);
    } catch {
      res.writeHead(403);
      res.end();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('connect', (req, client, head) => {
    // Chromium can drop its side at any time (e.g. exiting with the CDP tunnel open).
    // Unhandled, the resulting EPIPE/ECONNRESET would crash the worker process; the
    // close handler below then tears down the upstream side.
    client.on('error', () => client.destroy());
    void (async () => {
      try {
        const url = new URL('https://' + req.url);
        const local =
          debuggerPort !== undefined && req.url === '127.0.0.1:' + debuggerPort;
        if (!local && url.port && url.port !== '443')
          throw new Error('Port denied');
        const target = local
          ? { address: '127.0.0.1', family: 4 }
          : await policy.resolve(url.toString());
        const upstream = connect({
          host: target.address,
          port: local ? debuggerPort! : 443,
          family: target.family,
        });
        sockets.add(upstream);
        upstream.on('close', () => sockets.delete(upstream));
        upstream.setTimeout(30000, () => upstream.destroy());
        upstream.on('connect', () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) upstream.write(head);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on('error', () => client.destroy());
        client.on('close', () => upstream.destroy());
      } catch {
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Proxy bind failed');
  return {
    url: 'http://127.0.0.1:' + address.port,
    allowDebuggerTunnel: (port: number) => {
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('Invalid debugger port');
      debuggerPort = port;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
