import { z } from 'zod';
export const BrowserRequestSchema = z
  .object({
    urls: z.array(z.string().url().max(4096)).min(1).max(5),
    screenshot: z.boolean().default(false),
  })
  .strict();
export type BrowserRequest = z.infer<typeof BrowserRequestSchema>;
