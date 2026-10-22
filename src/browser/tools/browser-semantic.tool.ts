import type { Page } from 'playwright';
import type { Page as StagehandPage } from '@browserbasehq/stagehand';
import type { StagehandAdapter } from '../adapters/stagehand/stagehand.adapter';
import { BrowserError } from '../../common/errors/browser.errors';
import { PolicyError } from '../../common/errors/policy.errors';
import { ServiceError } from '../../common/errors/service.error';
import { assertSafeClick, settle } from './browser-click.tool';
import {
  missingPaths,
  parseExtractionSchema,
  toZod,
} from '../extraction/extraction-schema';

// Methods an observed action may use. press (Enter submits forms), dropdown selection,
// drag-and-drop and double clicks are excluded from the research profile.
export const SEMANTIC_METHODS = ['click', 'fill', 'type', 'scrollTo', 'hover'];
const TEXT_INPUTS = ['', 'text', 'search', 'email', 'url', 'number', 'tel'];
export interface SemanticCandidate {
  selector: string;
  description: string;
  method?: string;
  arguments?: string[];
}

// Stagehand pageId is the CDP target id, so a Playwright tab maps to exactly one page.
async function stagehandPage(
  adapter: StagehandAdapter,
  page: Page,
): Promise<StagehandPage> {
  const cdp = await page.context().newCDPSession(page);
  let targetId: string;
  try {
    targetId = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
  const match = (await adapter.browser.context.pages()).find(
    (candidate) => candidate.pageId === targetId,
  );
  if (!match)
    throw new BrowserError(
      'STAGEHAND_PAGE_NOT_FOUND',
      'Stagehand cannot see this tab',
      409,
    );
  return match;
}

// Stagehand relays schema failures of model output as an Error whose message is the Zod
// issue list; report the failing paths only (never values, which come from the page).
function invalidOutputPaths(error: unknown): string[] | undefined {
  if (!(error instanceof Error)) return undefined;
  try {
    const issues = JSON.parse(error.message) as unknown;
    if (
      !Array.isArray(issues) ||
      !issues.every((i) => i && typeof i.code === 'string')
    )
      return undefined;
    return issues
      .slice(0, 10)
      .map((issue: { path?: unknown[] }) =>
        [
          '$',
          ...(issue.path || []).filter((p) => p !== 'structuredContent'),
        ].join('.'),
      );
  } catch {
    return undefined;
  }
}

async function bounded<T>(
  adapter: StagehandAdapter,
  work: Promise<T>,
  timeoutMs: number,
  invalidOutputCode = 'MODEL_OUTPUT_INVALID',
): Promise<T> {
  adapter.lastModelError = undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new BrowserError(
                'STAGEHAND_ACTION_TIMEOUT',
                'Stagehand did not finish within ' + timeoutMs + 'ms',
                504,
                true,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    // Model failures surface through Stagehand's RPC as plain errors; report the typed one.
    if (adapter.lastModelError) throw adapter.lastModelError;
    const paths = invalidOutputPaths(error);
    if (paths)
      throw new BrowserError(
        invalidOutputCode,
        'Model output does not match the schema at ' + paths.join(', '),
        502,
        true,
      );
    throw new BrowserError(
      'STAGEHAND_ACTION_FAILED',
      'Stagehand action failed: ' +
        (error instanceof Error
          ? error.message.split('\n')[0].slice(0, 200)
          : 'unknown'),
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function semanticObserveTool(
  adapter: StagehandAdapter,
  page: Page,
  instruction: string,
  timeoutMs: number,
) {
  // Snapshot the loaded document, not one a previous navigation is still replacing.
  await settle(page);
  const target = await stagehandPage(adapter, page);
  const result = await bounded(
    adapter,
    adapter.client.observe(instruction, { page: target }),
    timeoutMs,
  );
  const candidates: SemanticCandidate[] = result.data.map((item) => ({
    selector: item.selector,
    description: item.description,
    method: item.method,
    arguments: item.arguments,
  }));
  return { url: page.url(), candidates };
}

/**
 * Natural-language action with the model kept out of execution: Stagehand observe()
 * proposes one action, this policy validates its method and target with Playwright
 * (same risky-click rule as clicks), and Stagehand act() executes exactly that Action.
 * Free-form act(instruction) is never called.
 */
export async function semanticActTool(
  adapter: StagehandAdapter,
  page: Page,
  instruction: string,
  timeoutMs: number,
) {
  const { candidates } = await semanticObserveTool(
    adapter,
    page,
    instruction,
    timeoutMs,
  );
  const action = candidates[0];
  if (!action)
    throw new BrowserError(
      'NO_MATCHING_ELEMENT',
      'No element matched the instruction',
      404,
    );
  const method = action.method || 'click';
  if (!SEMANTIC_METHODS.includes(method))
    throw new PolicyError(
      'ACTION_METHOD_DENIED',
      'Action method "' + method + '" is not allowed in the research profile',
    );
  if (!/^xpath=\/|^\/|^css=/.test(action.selector))
    throw new PolicyError(
      'ACTION_TARGET_DENIED',
      'Unsupported target selector',
    );
  const locator = page.locator(
    action.selector.startsWith('/')
      ? 'xpath=' + action.selector
      : action.selector,
  );
  if ((await locator.count()) !== 1)
    throw new BrowserError(
      'AMBIGUOUS_TARGET',
      'Expected exactly one target',
      409,
    );
  const args = action.arguments || [];
  if (method === 'click') await assertSafeClick(locator);
  if (method === 'fill' || method === 'type') {
    const field = await locator.evaluate((element) => ({
      tag: element.tagName,
      type: (element.getAttribute('type') || '').toLowerCase(),
    }));
    if (!(
      field.tag === 'TEXTAREA' ||
      (field.tag === 'INPUT' && TEXT_INPUTS.includes(field.type))
    ))
      throw new PolicyError(
        'ACTION_TARGET_DENIED',
        'Only plain text fields may be filled',
      );
    if (args.length !== 1 || args[0].length > 10000)
      throw new PolicyError('ACTION_ARGUMENTS_DENIED', 'Invalid text argument');
  }
  const target = await stagehandPage(adapter, page);
  const acted = await bounded(
    adapter,
    adapter.client.act(
      {
        selector: action.selector,
        description: action.description,
        method,
        arguments: args,
      },
      { page: target },
    ),
    timeoutMs,
  );
  // The acted-on page may be navigating; later steps must see the new document.
  await settle(page);
  if (!acted.data.success)
    throw new BrowserError(
      'STAGEHAND_ACTION_FAILED',
      'Stagehand could not perform the action',
      502,
    );
  return {
    action: {
      selector: action.selector,
      description: action.description,
      method,
    },
    url: page.url(),
  };
}

/**
 * Caller-defined structured extraction with Stagehand extract(). Read-only: the page must
 * not change while extracting. Output is validated by Stagehand against the schema, then
 * again here, and bounded in size. Page text is untrusted: it can only become data that
 * fits the schema, never an action or a navigation.
 */
export async function semanticExtractTool(
  adapter: StagehandAdapter,
  page: Page,
  request: { instruction: string; schema: unknown; scope?: string },
  limits: { timeoutMs: number; maxResultBytes: number },
) {
  const node = parseExtractionSchema(request.schema);
  const schema = toZod(node);
  // Snapshot the loaded document, not one a previous navigation is still replacing; the
  // URL baseline for the read-only check is taken after that.
  await settle(page);
  const before = page.url();
  const target = await stagehandPage(adapter, page);
  const extracted = await bounded(
    adapter,
    adapter.client.extract(request.instruction, schema, {
      page: target,
      timeout: limits.timeoutMs,
      ...(request.scope ? { locator: target.locator(request.scope) } : {}),
    }),
    limits.timeoutMs,
    'EXTRACT_OUTPUT_INVALID',
  );
  if (page.url() !== before)
    throw new PolicyError(
      'EXTRACT_PAGE_CHANGED',
      'The page navigated during a read-only extraction',
    );
  const checked = schema.safeParse(extracted.data);
  if (!checked.success)
    throw new BrowserError(
      'EXTRACT_OUTPUT_INVALID',
      'Model output does not match the schema at ' +
        checked.error.issues
          .slice(0, 10)
          .map((issue) => ['$', ...issue.path].join('.'))
          .join(', '),
      502,
      true,
    );
  const bytes = Buffer.byteLength(JSON.stringify(checked.data));
  if (bytes > limits.maxResultBytes)
    throw new BrowserError(
      'EXTRACT_OUTPUT_TOO_LARGE',
      'Extracted data is ' +
        bytes +
        ' bytes; the limit is ' +
        limits.maxResultBytes,
      413,
    );
  return {
    url: page.url(),
    data: checked.data,
    missing: missingPaths(node, checked.data),
    bytes,
    usage: { ...adapter.usage },
  };
}
