// Verification-only stand-in for the Anthropic Messages API (POST /v1/messages).
// Answers Stagehand's Observation requests by picking the accessibility-tree line that
// shares the most words with the instruction. Logs request shape, never header values.
const { createServer } = require('node:http');
let count = 0;
createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    let answered = false;
    // The caller gave up (aborted on cancellation) before this request was answered.
    res.on('close', () => { if (!answered) console.log('ABORTED request ' + count); });
    const send = (status, body, headers = {}) => {
      answered = true;
      res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_mock_' + count, ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) return send(404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } });
    count++;
    const body = JSON.parse(raw);
    const text = body.messages.at(-1).content.map((b) => b.text || '').join('');
    const instruction = (/instruction: (.*)/.exec(text) || [])[1] || '';
    console.log(JSON.stringify({
      request: count,
      model: body.model,
      apiKeyPresent: typeof req.headers['x-api-key'] === 'string' && req.headers['x-api-key'].length > 20,
      beta: req.headers['anthropic-beta'] || null,
      fallbacks: body.fallbacks || null,
      effort: body.output_config?.effort || null,
      structured: body.output_config?.format?.type || null,
      hasTemperature: 'temperature' in body,
      instruction,
    }));
    const reply = (answer) =>
      send(200, {
        id: 'msg_mock_' + count,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: JSON.stringify(answer) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 500, output_tokens: 40 },
      });
    // Stagehand extract(): a Metadata (progress) request after each Extraction request.
    const system = typeof body.system === 'string' ? body.system : '';
    if (/evaluating the progress/.test(system))
      return reply({ progress: 'done', completed: true });
    if (/extracting content/.test(system)) {
      // 'slowly' in the instruction: answer after 15 s, so a worker can be killed or a run
      // cancelled while the model request is in flight.
      if (/slowly/i.test(text)) await new Promise((r) => setTimeout(r, 15000));
      if (res.writableEnded || res.destroyed) return;
      // Schema-driven filler from the page's real headings (deterministic stand-in).
      const headings = [...text.matchAll(/\[\d+-\d+\] heading: (.*)/g)].map((m) => m[1].trim());
      const fill = (node) => {
        const type = node.type || (node.anyOf || []).map((x) => x.type).find((t) => t !== 'null');
        const nullable = (node.anyOf || []).some((x) => x.type === 'null');
        if (type === 'object') return Object.fromEntries(Object.entries(node.properties || {}).map(([k, v]) => [k, fill(v)]));
        if (type === 'array') return headings.slice(0, 5).map(() => fill(node.items));
        if (type === 'string') return nullable ? null : headings.shift() || '';
        if (type === 'number' || type === 'integer') return nullable ? null : 0;
        if (type === 'boolean') return false;
        return null;
      };
      return reply(fill(body.output_config.format.schema));
    }
    if (/rate limit/i.test(instruction))
      return send(429, { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }, { 'retry-after': '0' });
    if (/invalid key/i.test(instruction))
      return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    const lines = [...text.matchAll(/\[(\d+-\d+)\] (\w+): (.*)/g)];
    const words = instruction.toLowerCase();
    // Word overlap, plus a strong preference for the element role the instruction names.
    const score = (l) =>
      l[3].toLowerCase().split(/\W+/).filter((w) => w.length > 2 && words.includes(w)).length +
      (words.includes(l[2].toLowerCase()) ? 10 : 0) +
      (words.includes(l[3].toLowerCase()) ? 5 : 0);
    const best = lines.sort((a, b) => score(b) - score(a))[0];
    reply({ elements: best ? [{ elementId: best[1], description: best[2] + ': ' + best[3], method: 'click', arguments: [] }] : [] });
  });
}).listen(8080, '0.0.0.0', () => console.log('mock messages API listening'));
