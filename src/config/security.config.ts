import { z } from 'zod';

export const PrincipalSchema = z
  .object({
    token: z.string().min(32),
    tenantId: z.string().min(1).max(100),
    userId: z.string().min(1).max(100),
    projectIds: z.array(z.string().min(1).max(100)).min(1).max(100),
    capabilities: z.array(z.enum(['search', 'browser', 'research'])).min(1),
  })
  .strict();
export type Credential = z.infer<typeof PrincipalSchema>;
export function securityConfiguration(env: NodeJS.ProcessEnv): Credential[] {
  const credentials = z
    .array(PrincipalSchema)
    .min(1)
    .parse(JSON.parse(env.AUTH_CREDENTIALS || '[]'));
  if (new Set(credentials.map((x) => x.token)).size !== credentials.length)
    throw new Error('Duplicate credentials');
  if(credentials.some(item=>/^(replace_|change_me)/.test(item.token)))throw new Error('Placeholder credentials are not allowed');
  return credentials;
}
