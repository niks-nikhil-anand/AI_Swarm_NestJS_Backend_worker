import { z } from 'zod';
import { BrowserStepsRequestSchema } from './browser-step';
export const BrowserRequestSchema = z
  .object({
    urls: z.array(z.string().url().max(4096)).min(1).max(5),
    screenshot: z.boolean().default(false),
  })
  .strict();
export type BrowserRequest = z.infer<typeof BrowserRequestSchema>;
// A browser run either captures URLs or executes agent steps; both are strict objects.
export const BrowserRunRequestSchema = z.union([
  BrowserRequestSchema,
  BrowserStepsRequestSchema,
]);
export type BrowserRunRequest = z.infer<typeof BrowserRunRequestSchema>;
