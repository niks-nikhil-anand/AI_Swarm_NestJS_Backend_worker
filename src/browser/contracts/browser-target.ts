import { z } from 'zod';
export const BrowserTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reference'), id: z.uuid() }).strict(),
  z
    .object({ kind: z.literal('css'), selector: z.string().min(1).max(500) })
    .strict(),
  z
    .object({
      kind: z.literal('role'),
      role: z.enum(['button', 'link', 'textbox', 'heading']),
      name: z.string().max(200),
    })
    .strict(),
]);
export type BrowserTarget = z.infer<typeof BrowserTargetSchema>;
