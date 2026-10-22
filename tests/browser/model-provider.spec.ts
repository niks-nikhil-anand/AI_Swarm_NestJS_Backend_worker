import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import {
  AnthropicModelProvider,
  PAGE_CONTENT_NOTICE,
  createModelProvider,
  structuredSchema,
  type GenerateParams,
} from '../../src/browser/adapters/stagehand/model-provider';
import { loadConfiguration } from '../../src/config/configuration';
import { browserConfiguration } from '../../src/config/browser.config';

const KEY = 'sk-ant-test-' + 'k'.repeat(40);
const browserEnv = {
  DATABASE_URL: 'postgresql://u:p@localhost/db',
  BROWSER_ALLOWED_DOMAINS: 'example.com',
};
// Stagehand's observe request, as captured from Stagehand 4.1.0 in the Linux image.
const observe: GenerateParams = {
  systemPrompt: 'You are helping the user automate the browser.',
  messages: [
    {
      role: 'user',
      content: {
        type: 'text',
        text: 'instruction: find the next link\n[0-11] link: Next',
      },
    },
  ],
  responseFormat: {
    type: 'json_schema',
    name: 'Observation',
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        elements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              elementId: { type: 'string', pattern: '^\\d+-\\d+$' },
              method: { type: 'string', enum: ['click', 'fill'] },
            },
            required: ['elementId', 'method'],
            additionalProperties: false,
          },
        },
      },
      required: ['elements'],
      additionalProperties: false,
    },
  },
};

describe('Model provider configuration', () => {
  test('defaults to no provider, so semantic steps are unavailable', () => {
    const config = loadConfiguration('browser', browserEnv).browser!;
    expect(config.stagehand.model).toMatchObject({
      provider: 'none',
      name: 'claude-opus-5-5',
      effort: 'medium',
    });
    expect(createModelProvider(config.stagehand.model)).toBeNull();
  });
  test.each([
    [
      { STAGEHAND_MODEL_PROVIDER: 'openai' },
      'STAGEHAND_MODEL_PROVIDER must be "none" or "anthropic"',
    ],
    [
      { STAGEHAND_MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY },
      'STAGEHAND_MODEL_PROVIDER requires STAGEHAND_ENABLED=true',
    ],
    [
      { STAGEHAND_ENABLED: 'true', STAGEHAND_MODEL_PROVIDER: 'anthropic' },
      'STAGEHAND_MODEL_PROVIDER=anthropic requires ANTHROPIC_API_KEY',
    ],
    [
      { STAGEHAND_MODEL: 'Claude Opus!' },
      'STAGEHAND_MODEL is not a valid model id',
    ],
    [
      { STAGEHAND_MODEL_EFFORT: 'extreme' },
      'STAGEHAND_MODEL_EFFORT must be one of',
    ],
    [
      { STAGEHAND_MODEL_TIMEOUT_MS: '1' },
      'STAGEHAND_MODEL_TIMEOUT_MS must be an integer',
    ],
    [
      { STAGEHAND_MODEL_MAX_RETRIES: '9' },
      'STAGEHAND_MODEL_MAX_RETRIES must be an integer',
    ],
  ])(
    'rejects invalid settings with an actionable message (%o)',
    (env, message) => {
      expect(() =>
        loadConfiguration('browser', { ...browserEnv, ...env }),
      ).toThrow(message);
    },
  );
  test('never exposes the API key when the configuration is printed or serialized', () => {
    const config = browserConfiguration({
      ...browserEnv,
      STAGEHAND_ENABLED: 'true',
      STAGEHAND_MODEL_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: KEY,
    });
    expect(JSON.stringify(config)).not.toContain(KEY);
    expect(inspect(config, { depth: 10 })).not.toContain(KEY);
    expect(
      String(
        config.stagehand.model.provider === 'anthropic' &&
          config.stagehand.model.apiKey,
      ),
    ).toBe('[redacted]');
    // A rejected key is not echoed either.
    try {
      loadConfiguration('browser', {
        ...browserEnv,
        STAGEHAND_ENABLED: 'true',
        STAGEHAND_MODEL_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'short secret',
      });
    } catch (error) {
      expect((error as Error).message).not.toContain('short secret');
    }
  });
});

describe('Structured output schema', () => {
  test('keeps the supported subset and closes every object', () => {
    expect(structuredSchema(observe.responseFormat!.schema)).toEqual({
      type: 'object',
      properties: {
        elements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              elementId: { type: 'string' },
              method: { type: 'string', enum: ['click', 'fill'] },
            },
            required: ['elementId', 'method'],
            additionalProperties: false,
          },
        },
      },
      required: ['elements'],
      additionalProperties: false,
    });
  });
});

describe('Anthropic model provider (real SDK, local mock API)', () => {
  let server: Server;
  let reply: (
    req: IncomingMessage,
    body: Record<string, unknown>,
  ) => { status: number; body: unknown; delayMs?: number };
  const requests: {
    headers: IncomingMessage['headers'];
    body: Record<string, unknown>;
  }[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        requests.push({ headers: req.headers, body });
        const answer = reply(req, body);
        setTimeout(() => {
          res.writeHead(answer.status, {
            'content-type': 'application/json',
            'request-id': 'req_test',
          });
          res.end(JSON.stringify(answer.body));
        }, answer.delayMs || 0);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => (requests.length = 0));
  const provider = (model = 'claude-opus-5-5', timeout = 2000) =>
    new AnthropicModelProvider(
      browserConfiguration({
        ...browserEnv,
        STAGEHAND_ENABLED: 'true',
        STAGEHAND_MODEL_PROVIDER: 'anthropic',
        STAGEHAND_MODEL: model,
        ANTHROPIC_API_KEY: KEY,
      }).stagehand.model as never,
      new Anthropic({
        apiKey: KEY,
        baseURL: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
        timeout,
        maxRetries: 0,
      }),
    );
  const message = (
    content: unknown[],
    stop_reason = 'end_turn',
    extra = {},
  ) => ({
    status: 200,
    body: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content,
      stop_reason,
      stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 30 },
      ...extra,
    },
  });

  test('sends structured observe requests with effort, fallback and no sampling parameters', async () => {
    reply = () =>
      message([
        { type: 'thinking', thinking: '', signature: 's' },
        {
          type: 'text',
          text: '{"elements":[{"elementId":"0-11","method":"click"}]}',
        },
      ]);
    const result = await provider().generate(observe);
    const sent = requests[0];
    expect(sent.headers['x-api-key']).toBe(KEY);
    expect(sent.headers['anthropic-beta']).toContain(
      'server-side-fallback-2026-07-01',
    );
    expect(sent.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
      messages: [{ role: 'user', content: [{ type: 'text' }] }],
    });
    expect(sent.body).not.toHaveProperty('temperature');
    // Stagehand's prompt first, then the untrusted-page notice.
    expect(sent.body.system).toBe(
      'You are helping the user automate the browser.' + PAGE_CONTENT_NOTICE,
    );
    expect(JSON.stringify(sent.body)).not.toContain('pattern');
    expect(result).toMatchObject({
      role: 'assistant',
      outputFormat: 'json_schema',
      structuredContent: { elements: [{ elementId: '0-11', method: 'click' }] },
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    });
    // Thinking blocks are not part of Stagehand's message schema and are dropped.
    expect(result.content).toEqual([
      {
        type: 'text',
        text: '{"elements":[{"elementId":"0-11","method":"click"}]}',
      },
    ]);
  });

  test('omits the fallback beta for models without server-side fallback', async () => {
    reply = () => message([{ type: 'text', text: 'ok' }]);
    await provider('claude-haiku-5-5').generate({
      messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
    });
    expect(requests[0].body).not.toHaveProperty('fallbacks');
    expect(requests[0].headers['anthropic-beta'] || '').not.toContain(
      'server-side-fallback',
    );
  });

  test('maps tool use and tool results in both directions', async () => {
    reply = () =>
      message(
        [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'click',
            input: { id: '0-11' },
          },
        ],
        'tool_use',
      );
    const result = await provider().generate({
      messages: [
        { role: 'user', content: { type: 'text', text: 'go' } },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_0', name: 'look', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolUseId: 'toolu_0',
              content: [{ type: 'text', text: 'page' }],
              isError: false,
            },
          ],
        },
      ],
      tools: [
        {
          name: 'click',
          description: 'Click',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        },
      ],
      toolChoice: { mode: 'required' },
    });
    expect(requests[0].body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_0', name: 'look', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_0',
            is_error: false,
            content: [{ type: 'text', text: 'page' }],
          },
        ],
      },
    ]);
    // Forced tool choice is rejected by current models; it is steered by the prompt instead.
    expect(requests[0].body).not.toHaveProperty('tool_choice');
    expect(requests[0].body.system).toContain(
      'calling one of the provided tools',
    );
    expect(requests[0].body.tools).toEqual([
      {
        name: 'click',
        description: 'Click',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
    ]);
    expect(result).toMatchObject({
      outputFormat: 'text',
      stopReason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'click',
          input: { id: '0-11' },
        },
      ],
    });
  });

  test.each([
    [
      401,
      {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      },
      'MODEL_AUTH_FAILED',
      false,
    ],
    [
      403,
      {
        type: 'error',
        error: { type: 'permission_error', message: 'no access' },
      },
      'MODEL_AUTH_FAILED',
      false,
    ],
    [
      429,
      {
        type: 'error',
        error: { type: 'rate_limit_error', message: 'slow down' },
      },
      'MODEL_RATE_LIMITED',
      true,
    ],
    [
      400,
      {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'bad schema' },
      },
      'MODEL_REQUEST_REJECTED',
      false,
    ],
    [
      529,
      {
        type: 'error',
        error: { type: 'overloaded_error', message: 'overloaded' },
      },
      'MODEL_UNAVAILABLE',
      true,
    ],
  ])(
    'maps HTTP %i to a typed, secret-free error',
    async (status, body, code, retryable) => {
      reply = () => ({ status, body });
      const error = await provider()
        .generate(observe)
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code, retryable });
      expect(JSON.stringify(error) + String(error)).not.toContain(KEY);
    },
  );

  test('aborting a slow request ends it at once as MODEL_ABORTED', async () => {
    reply = () => ({
      ...message([{ type: 'text', text: 'late' }]),
      delayMs: 5000,
    });
    const controller = new AbortController();
    const started = Date.now();
    const pending = provider('claude-opus-5-5', 30000).generate(observe, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toMatchObject({
      code: 'MODEL_ABORTED',
      retryable: false,
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('reports a timeout as retryable MODEL_TIMEOUT', async () => {
    reply = () => ({
      ...message([{ type: 'text', text: 'late' }]),
      delayMs: 1000,
    });
    await expect(
      provider('claude-opus-5-5', 200).generate(observe),
    ).rejects.toMatchObject({ code: 'MODEL_TIMEOUT', retryable: true });
  });

  test('reports refusals and invalid structured output', async () => {
    reply = () =>
      message([], 'refusal', {
        stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' },
      });
    await expect(provider().generate(observe)).rejects.toMatchObject({
      code: 'MODEL_REFUSED',
      message: expect.stringContaining('cyber'),
    });
    reply = () => message([{ type: 'text', text: 'not json' }]);
    await expect(provider().generate(observe)).rejects.toMatchObject({
      code: 'MODEL_OUTPUT_INVALID',
    });
  });

  test('rejects image types the API does not accept before sending', async () => {
    await expect(
      provider().generate({
        messages: [
          {
            role: 'user',
            content: { type: 'image', data: 'AAAA', mimeType: 'image/bmp' },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'MODEL_REQUEST_REJECTED' });
    expect(requests).toHaveLength(0);
  });
});
