import { z } from 'zod';
export const SearchRequestSchema = z
  .object({
    queries: z.array(z.string().trim().min(1).max(500)).min(1).max(3),
    language: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
      .optional(),
    safeSearch: z.number().int().min(0).max(2).default(1),
    maxCandidates: z.number().int().min(1).max(5).default(5),
  })
  .strict();
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
