// Verification-only HTTPS fixture (forms.fixture.test) for the Compose acceptance suite.
// It records every request it receives, so tests count real HTTP requests instead of
// trusting the browser's own report. A control API on :8080 (published to the host only)
// sets the page variant and the submission behaviour and returns the recorded requests.
// It never logs request bodies.
import { createServer as createHttps } from 'node:https';
import { createServer as createHttp } from 'node:http';
import { readFileSync } from 'node:fs';

const state = {
  // base | action-changed | value-changed
  variant: 'base',
  // ok | slow | reset | error | refuse
  mode: 'ok',
  delayMs: 0,
  // Number of upcoming GET /slow-read requests to delay (read-only work in progress).
  slowReads: 0,
  slowReadMs: 25000,
  requests: [],
};
const page = (title, body) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const form = () => {
  const action = state.variant === 'action-changed' ? '/submit-v2' : '/submit';
  const account = state.variant === 'value-changed' ? 'acct-2' : 'acct-1';
  return page(
    'Contact',
    '<h1>Contact support</h1>' +
      `<form action="${action}" method="post">` +
      '<textarea name="message" aria-label="Message"></textarea>' +
      `<input type="hidden" name="account" value="${account}">` +
      '<button type="submit">Send message</button></form>',
  );
};
const article = page(
  'Fixture article',
  '<h1>Fixture article</h1><h2>Findings</h2><p>Deterministic evidence paragraph for the verification suite.</p>' +
    '<h2>Method</h2><p>Recorded by a local fixture.</p>',
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const app = async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  const path = (req.url || '/').split('?')[0];
  state.requests.push({
    at: new Date().toISOString(),
    host: req.headers.host || '',
    method: req.method,
    path,
    body,
  });
  const send = (status, html, headers = {}) => {
    if (res.destroyed) return;
    res.writeHead(status, { 'content-type': 'text/html', ...headers });
    res.end(html);
  };
  if (req.method === 'GET' && path === '/form') return send(200, form());
  if (req.method === 'GET' && path === '/read') return send(200, article);
  if (req.method === 'GET' && path === '/slow-read') {
    if (state.slowReads > 0) {
      state.slowReads--;
      await sleep(state.slowReadMs);
    }
    return send(200, article);
  }
  if (req.method === 'POST' && ['/submit', '/submit-v2'].includes(path)) {
    if (state.mode === 'reset') return req.socket.destroy();
    if (state.mode === 'slow') await sleep(state.delayMs);
    if (state.mode === 'error') return send(500, page('Error', 'Server error'));
    if (state.mode === 'refuse') return send(403, page('Refused', 'Refused'));
    return send(
      200,
      page('Submitted', '<h1>Message received</h1><p>Reference 4711.</p>'),
    );
  }
  return send(404, page('Not found', 'Not found'));
};

const tls = {
  cert: readFileSync('/pki/server.crt'),
  key: readFileSync('/pki/server.key'),
};
createHttps(tls, (req, res) => void app(req, res)).listen(443, '0.0.0.0');

createHttp(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const reply = (value) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (req.method === 'GET' && req.url === '/requests')
    return reply(state.requests);
  if (req.method === 'POST' && req.url === '/state') {
    Object.assign(state, JSON.parse(Buffer.concat(chunks).toString() || '{}'));
    return reply({ ok: true });
  }
  if (req.method === 'POST' && req.url === '/reset') {
    Object.assign(state, {
      variant: 'base',
      mode: 'ok',
      delayMs: 0,
      slowReads: 0,
      slowReadMs: 25000,
      requests: [],
    });
    return reply({ ok: true });
  }
  res.writeHead(404);
  res.end();
}).listen(8080, '0.0.0.0', () => console.log('verification fixture ready'));
