import { z } from 'zod';
import { BrowserTargetSchema } from './browser-target';
const tab = { tabId: z.uuid() };
export const BrowserActionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('open'),
      ...tab,
      url: z.string().url().max(4096),
    })
    .strict(),
  z.object({ kind: z.literal('observe'), ...tab }).strict(),
  z
    .object({ kind: z.literal('click'), ...tab, target: BrowserTargetSchema })
    .strict(),
  z
    .object({
      kind: z.literal('type'),
      ...tab,
      target: BrowserTargetSchema,
      text: z.string().max(10000),
      mode: z.enum(['fill', 'append']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('scroll'),
      ...tab,
      pixels: z.number().int().min(-3000).max(3000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('extract'),
      ...tab,
      schemaId: z.literal('article'),
    })
    .strict(),
  z.object({ kind: z.literal('screenshot'), ...tab }).strict(),
  z.object({ kind: z.literal('new_tab') }).strict(),
  z.object({ kind: z.literal('close_tab'), ...tab }).strict(),
  z.object({ kind: z.literal('list_tabs') }).strict(),
  z.object({ kind: z.literal('go_back'), ...tab }).strict(),
  z
    .object({
      kind: z.literal('wait_for'),
      ...tab,
      target: BrowserTargetSchema,
      state: z.enum(['visible', 'hidden']),
      timeoutMs: z.number().int().min(100).max(15000),
    })
    .strict(),
]);
export type BrowserAction = z.infer<typeof BrowserActionSchema>;
