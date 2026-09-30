import { z } from 'zod';

export function browserConfiguration(env: NodeJS.ProcessEnv) {
  const list = (env.BROWSER_ALLOWED_DOMAINS || '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length)
    throw new Error('BROWSER_ALLOWED_DOMAINS must be explicitly configured');
  for (const host of list)
    if (!/^[a-z0-9.-]+$/.test(host)) throw new Error('Invalid allowed domain');
  return {
    allowedDomains: list,
    maxActions: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(env.BROWSER_MAX_ACTIONS ?? 30),
    maxTabs: z.coerce
      .number()
      .int()
      .min(1)
      .max(10)
      .parse(env.BROWSER_MAX_TABS ?? 5),
    timeoutMs: z.coerce
      .number()
      .int()
      .min(1000)
      .max(600000)
      .parse(env.BROWSER_TIMEOUT_MS ?? 600000),
    actionTimeoutMs: 15000,
    concurrency: 1,
    chromiumSandbox: env.CHROMIUM_SANDBOX !== 'false',
  };
}
