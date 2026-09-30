import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
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
