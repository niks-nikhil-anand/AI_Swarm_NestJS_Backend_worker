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
  // Stagehand: model-proposed elements (read-only) and validated single actions.
  z
    .object({
      kind: z.literal('semantic_observe'),
      ...tab,
      instruction: z.string().trim().min(1).max(500),
    })
    .strict(),
  z
    .object({
      kind: z.literal('semantic_act'),
      ...tab,
      instruction: z.string().trim().min(1).max(500),
    })
    .strict(),
  // Caller-defined structured extraction; the schema is checked by parseExtractionSchema.
  z
    .object({
      kind: z.literal('semantic_extract'),
      ...tab,
      instruction: z.string().trim().min(1).max(1000),
      schema: z.record(z.string(), z.unknown()),
      scope: z.string().min(1).max(500).optional(),
    })
    .strict(),
  // Consequential actions (Phase 5): fingerprint the target for an approval, and activate
  // it only with the session's single-use authorization for exactly that step and page.
  z
    .object({
      kind: z.literal('fingerprint'),
      ...tab,
      target: BrowserTargetSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('approved_activate'),
      ...tab,
      target: BrowserTargetSchema,
      step: z.number().int().min(0),
      pageHash: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
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
