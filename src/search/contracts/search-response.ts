import { z } from 'zod';
export const SearxngResponseSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            url: z.string().max(4096),
            title: z.string().max(2000).optional(),
            content: z.string().max(20000).optional(),
            engine: z.string().max(100).optional(),
            engines: z.array(z.string().max(100)).max(100).optional(),
          })
          .passthrough(),
      )
      .max(1000),
    unresponsive_engines: z.array(z.unknown()).max(100).optional(),
  })
  .passthrough();
export type SearxngResponse = z.infer<typeof SearxngResponseSchema>;
