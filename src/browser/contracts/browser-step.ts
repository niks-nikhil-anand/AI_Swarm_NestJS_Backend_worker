import { z } from 'zod';

// Agent-facing targets. Element references from inspect are session-scoped and cannot be
// known when a run is submitted, so steps address elements by role/name or CSS.
const StepTargetSchema = z.discriminatedUnion('kind', [
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
const instruction = z.string().trim().min(1).max(500);
// Rejected at the API boundary; the domain policy still checks every request at runtime.
const webUrl = z
  .string()
  .url()
  .max(4096)
  .refine((value) => /^https?:\/\//i.test(value), 'Only http(s) URLs');

/**
 * One sequential step of an agent browser run. Steps act on the current tab; new_tab
 * opens a Playwright tab and makes it current. Typing never submits, and there is no
 * key-press step, so forms cannot be sent.
 */
export const BrowserStepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), url: webUrl }).strict(),
  z.object({ kind: z.literal('inspect') }).strict(),
  z
    .object({ kind: z.literal('read'), screenshot: z.boolean().default(false) })
    .strict(),
  z.object({ kind: z.literal('click'), target: StepTargetSchema }).strict(),
  z
    .object({
      kind: z.literal('type'),
      target: StepTargetSchema,
      text: z.string().max(10000),
      mode: z.enum(['fill', 'append']).default('fill'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('scroll'),
      pixels: z.number().int().min(-3000).max(3000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('wait_for'),
      target: StepTargetSchema,
      state: z.enum(['visible', 'hidden']).default('visible'),
      timeoutMs: z.number().int().min(100).max(15000).default(5000),
    })
    .strict(),
  z.object({ kind: z.literal('go_back') }).strict(),
  z
    .object({
      kind: z.literal('new_tab'),
      url: webUrl.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('switch_tab'),
      index: z.number().int().min(0).max(9),
    })
    .strict(),
  z.object({ kind: z.literal('observe'), instruction }).strict(),
  z.object({ kind: z.literal('act'), instruction }).strict(),
  // Consequential (Phase 5): activates one form submit control or link that the risky-click
  // check refuses. Runs only after an approver approved exactly this action on this page.
  z
    .object({
      kind: z.literal('submit'),
      target: StepTargetSchema,
      description: z.string().trim().min(1).max(300),
    })
    .strict(),
  // Caller-defined structured extraction (Stagehand extract). The schema is a bounded
  // JSON Schema subset, checked by parseExtractionSchema when the run is submitted.
  z
    .object({
      kind: z.literal('extract'),
      instruction: z.string().trim().min(1).max(1000),
      schema: z.record(z.string(), z.unknown()),
      // Optional CSS selector limiting extraction to one part of the page.
      scope: z.string().min(1).max(500).optional(),
    })
    .strict(),
]);
export type BrowserStep = z.infer<typeof BrowserStepSchema>;

export const BrowserStepsRequestSchema = z
  .object({
    steps: z.array(BrowserStepSchema).min(1).max(25),
    // Attempts per step for transient failures within one session (navigation timeouts,
    // model rate limits). Policy denials are never retried.
    maxStepAttempts: z.number().int().min(1).max(3).default(2),
  })
  .strict()
  // One consequential step per run: resuming after its approval replays only earlier,
  // non-consequential steps.
  .refine(
    (request) =>
      request.steps.filter((step) => step.kind === 'submit').length <= 1,
    { message: 'At most one submit step per run', path: ['steps'] },
  );
export type BrowserStepsRequest = z.infer<typeof BrowserStepsRequestSchema>;

/**
 * Steps whose repetition cannot change remote or page state beyond what a fresh session
 * would reach anyway. A retried run replays these; anything else that already completed
 * is never replayed.
 */
export const REPLAYABLE_STEPS: ReadonlySet<BrowserStep['kind']> = new Set([
  'navigate',
  'inspect',
  'read',
  'scroll',
  'wait_for',
  'go_back',
  'new_tab',
  'switch_tab',
  'observe',
  'extract',
]);
