import { z } from 'zod';

// Messages name the variable and the accepted values, never the supplied value.
export class ConfigurationError extends Error {}

export const flag = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
) => {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ConfigurationError(name + ' must be "true" or "false"');
};
export const bounded = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
) => {
  const parsed = z.coerce
    .number()
    .int()
    .min(min)
    .max(max)
    .safeParse(env[name] ?? fallback);
  if (!parsed.success)
    throw new ConfigurationError(
      name + ' must be an integer between ' + min + ' and ' + max,
    );
  return parsed.data;
};

export function browserConfiguration(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
) {
  const list = (env.BROWSER_ALLOWED_DOMAINS || '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length)
    throw new ConfigurationError(
      'BROWSER_ALLOWED_DOMAINS must be explicitly configured',
    );
  for (const host of list)
    if (!/^[a-z0-9.-]+$/.test(host))
      throw new ConfigurationError(
        'BROWSER_ALLOWED_DOMAINS contains an invalid host name',
      );
  // Every session owns its Chromium process; a shared external browser would break tenant isolation.
  for (const name of ['BROWSER_CDP_URL', 'STAGEHAND_CDP_URL'])
    if (env[name])
      throw new ConfigurationError(
        name +
          ' is not supported: Stagehand connects only to the managed per-session Chromium',
      );
  const headless = flag(env, 'BROWSER_HEADLESS', true);
  if (!headless && platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY)
    throw new ConfigurationError(
      'BROWSER_HEADLESS=false requires a DISPLAY or WAYLAND_DISPLAY',
    );
  return {
    allowedDomains: list,
    maxActions: bounded(env, 'BROWSER_MAX_ACTIONS', 30, 1, 100),
    maxTabs: bounded(env, 'BROWSER_MAX_TABS', 5, 1, 10),
    timeoutMs: bounded(env, 'BROWSER_TIMEOUT_MS', 600000, 1000, 600000),
    launchTimeoutMs: bounded(
      env,
      'BROWSER_LAUNCH_TIMEOUT_MS',
      30000,
      5000,
      120000,
    ),
    actionTimeoutMs: 15000,
    concurrency: 1,
    // Headless mode is independent of the sandbox; only CHROMIUM_SANDBOX=false disables it.
    headless,
    chromiumSandbox: env.CHROMIUM_SANDBOX !== 'false',
    stagehand: {
      enabled: flag(env, 'STAGEHAND_ENABLED', false),
      connectTimeoutMs: bounded(
        env,
        'STAGEHAND_CONNECT_TIMEOUT_MS',
        30000,
        5000,
        60000,
      ),
      // Bounds one semantic observe/act step, including its model calls.
      actionTimeoutMs: bounded(
        env,
        'STAGEHAND_ACTION_TIMEOUT_MS',
        120000,
        5000,
        300000,
      ),
      model: modelConfiguration(env),
      // Model usage per semantic step (observe, act, extract). Extraction makes two calls
      // per page chunk, so long pages are bounded here rather than by Stagehand.
      stepMaxModelCalls: bounded(
        env,
        'STAGEHAND_STEP_MAX_MODEL_CALLS',
        12,
        1,
        50,
      ),
      stepMaxModelTokens: bounded(
        env,
        'STAGEHAND_STEP_MAX_MODEL_TOKENS',
        300000,
        1000,
        2000000,
      ),
      extractMaxResultBytes: bounded(
        env,
        'EXTRACT_MAX_RESULT_BYTES',
        65536,
        1024,
        1048576,
      ),
    },
  };
}

// Never serialized or printed: logging the configuration cannot leak the key.
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal() {
    return this.#value;
  }
  toJSON() {
    return '[redacted]';
  }
  toString() {
    return '[redacted]';
  }
  [Symbol.for('nodejs.util.inspect.custom')]() {
    return '[redacted]';
  }
}

const MODEL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
// Model calls for Stagehand run in this worker process (Stagehand's client-side `generate`
// hook), never from the browser, so model egress does not widen page egress.
function modelConfiguration(env: NodeJS.ProcessEnv) {
  const provider = env.STAGEHAND_MODEL_PROVIDER || 'none';
  if (provider !== 'none' && provider !== 'anthropic')
    throw new ConfigurationError(
      'STAGEHAND_MODEL_PROVIDER must be "none" or "anthropic"',
    );
  const name = env.STAGEHAND_MODEL || 'claude-opus-5-5';
  if (!/^[a-z0-9][a-z0-9.-]{1,99}$/.test(name))
    throw new ConfigurationError('STAGEHAND_MODEL is not a valid model id');
  const effort = env.STAGEHAND_MODEL_EFFORT || 'medium';
  if (!(MODEL_EFFORTS as readonly string[]).includes(effort))
    throw new ConfigurationError(
      'STAGEHAND_MODEL_EFFORT must be one of ' + MODEL_EFFORTS.join(', '),
    );
  const settings = {
    name,
    effort: effort as (typeof MODEL_EFFORTS)[number],
    timeoutMs: bounded(env, 'STAGEHAND_MODEL_TIMEOUT_MS', 60000, 5000, 300000),
    maxRetries: bounded(env, 'STAGEHAND_MODEL_MAX_RETRIES', 2, 0, 5),
  };
  if (provider === 'none') return { provider: 'none' as const, ...settings };
  if (!flag(env, 'STAGEHAND_ENABLED', false))
    throw new ConfigurationError(
      'STAGEHAND_MODEL_PROVIDER requires STAGEHAND_ENABLED=true',
    );
  const key = (env.ANTHROPIC_API_KEY || '').trim();
  if (key.length < 20 || /\s/.test(key))
    throw new ConfigurationError(
      'STAGEHAND_MODEL_PROVIDER=anthropic requires ANTHROPIC_API_KEY',
    );
  return {
    provider: 'anthropic' as const,
    ...settings,
    apiKey: new Secret(key),
  };
}
export type ModelConfiguration = ReturnType<typeof modelConfiguration>;
export type BrowserConfiguration = ReturnType<typeof browserConfiguration>;
