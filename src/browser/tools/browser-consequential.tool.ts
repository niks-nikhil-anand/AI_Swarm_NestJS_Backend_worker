import { createHash } from 'node:crypto';
import type { Locator, Page, Request } from 'playwright';
import { BrowserError } from '../../common/errors/browser.errors';
import { PolicyError } from '../../common/errors/policy.errors';
import type { BrowserSession } from '../contracts/browser-session';
import { settle } from './browser-click.tool';

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const withoutFragment = (url: string) => url.split('#')[0];
// One approved write; the allowance is consumed by the session's request policy.
export const WRITE_ALLOWANCE_MS = 30000;

export interface Fingerprint {
  // Hash of the material page state: URL, target, form action/method, field names,
  // types and value hashes. Field values themselves never leave this function.
  pageHash: string;
  pageUrl: string;
  // What an approver reviews: labels and field names only, no values.
  summary: {
    pageUrl: string;
    element: { tag: string; type: string; name: string; text: string };
    form: {
      action: string;
      method: string;
      fields: { name: string; type: string }[];
    } | null;
    href: string | null;
  };
}

/**
 * Fingerprints a consequential target: one submit control of a form (https action) or a
 * link. Anything else cannot be approved, because its effect could not be bound.
 */
export async function fingerprintTool(
  page: Page,
  locator: Locator,
): Promise<Fingerprint> {
  const raw = await locator.evaluate((element) => {
    const control = element as HTMLInputElement;
    const form = control.form || element.closest('form');
    const submitControl =
      (element.tagName === 'BUTTON' &&
        (control.getAttribute('type') || 'submit').toLowerCase() ===
          'submit') ||
      (element.tagName === 'INPUT' &&
        ['submit', 'image'].includes(
          (control.getAttribute('type') || '').toLowerCase(),
        ));
    return {
      tag: element.tagName.toLowerCase(),
      type: (element.getAttribute('type') || '').toLowerCase(),
      name: element.getAttribute('name') || '',
      text: (
        (element as HTMLElement).innerText ||
        control.value ||
        element.getAttribute('aria-label') ||
        ''
      )
        .trim()
        .slice(0, 200),
      href:
        element.tagName === 'A' ? (element as HTMLAnchorElement).href : null,
      submitControl,
      form:
        form && submitControl
          ? {
              action: form.action,
              method: (form.getAttribute('method') || 'get').toUpperCase(),
              fields: Array.from(form.elements)
                .map((field) => field as HTMLInputElement)
                .filter((field) => field.name)
                .map((field) => ({
                  name: field.name,
                  type: (field.type || '').toLowerCase(),
                  value:
                    field.type === 'checkbox' || field.type === 'radio'
                      ? field.checked
                        ? field.value
                        : ''
                      : field.value || '',
                })),
            }
          : null,
    };
  });
  if (!raw.form && !raw.href)
    throw new PolicyError(
      'CONSEQUENTIAL_TARGET_UNSUPPORTED',
      'A consequential step must target a form submit control or a link',
    );
  if (raw.form && !raw.form.action.startsWith('https://'))
    throw new PolicyError(
      'CONSEQUENTIAL_TARGET_UNSUPPORTED',
      'Approved form submissions must use an https action',
    );
  const pageUrl = withoutFragment(page.url());
  const element = {
    tag: raw.tag,
    type: raw.type,
    name: raw.name,
    text: raw.text,
  };
  const form = raw.form
    ? {
        action: withoutFragment(raw.form.action),
        method: raw.form.method,
        fields: raw.form.fields.map((field) => ({
          name: field.name,
          type: field.type,
          valueHash: sha256(field.value),
        })),
      }
    : null;
  return {
    pageHash: sha256(
      JSON.stringify({ pageUrl, element, form, href: raw.href }),
    ),
    pageUrl,
    summary: {
      pageUrl,
      element,
      form: form
        ? {
            action: form.action,
            method: form.method,
            fields: form.fields.map(({ name, type }) => ({ name, type })),
          }
        : null,
      href: raw.href,
    },
  };
}

const uncertain = (reason: string) =>
  new BrowserError(
    'APPROVED_ACTION_UNCERTAIN',
    'The approved action may have taken effect; its outcome is unknown: ' +
      reason.split('\n')[0].slice(0, 120),
    502,
  );

/**
 * Executes an approved consequential action. The caller has consumed the approval; this
 * re-checks that the page is still the approved one and activates the target without the
 * risky-click refusal.
 *
 * A non-GET form gets a write allowance for exactly one request: the approved method and
 * action URL, sent as this page's own top-level navigation (no script request, frame or
 * other tab can use it). The outcome comes from that request, not from the page:
 * - never sent (the allowance is still unused when withdrawn) → APPROVED_REQUEST_NOT_SENT;
 * - 4xx → APPROVED_REQUEST_REJECTED (the server refused it);
 * - network failure, timeout or 5xx → APPROVED_ACTION_UNCERTAIN (it may have taken effect);
 * - 2xx/3xx → success. This reports what the server answered, not what it did.
 */
export async function activateApprovedTool(
  session: BrowserSession,
  page: Page,
  locator: Locator,
  approvedPageHash: string,
  responseTimeoutMs = 15000,
) {
  const current = await fingerprintTool(page, locator);
  if (current.pageHash !== approvedPageHash)
    throw new PolicyError(
      'APPROVAL_PAGE_CHANGED',
      'The page or target changed after approval',
    );
  const form = current.summary.form;
  if (!form || form.method === 'GET') {
    // A link or GET form is a navigation the read policy already allows.
    try {
      await locator.click();
      await settle(page);
    } catch (error) {
      throw uncertain(error instanceof Error ? error.message : 'unknown');
    }
    return { url: page.url() };
  }
  const grant = {
    method: form.method,
    url: form.action,
    remaining: 1,
    expiresAt: Date.now() + WRITE_ALLOWANCE_MS,
    page,
  };
  let approved: Request | undefined;
  const watch = (request: Request) => {
    if (
      !approved &&
      request.method() === grant.method &&
      withoutFragment(request.url()) === grant.url &&
      request.isNavigationRequest() &&
      request.frame() === page.mainFrame()
    )
      approved = request;
  };
  page.on('request', watch);
  session.writeAllowance = grant;
  let clickError: unknown;
  try {
    await locator.click();
    // A slow server keeps the old document loaded: wait until the request policy has let
    // the approved request out (the route decides after Playwright's 'request' event, so
    // seeing the request is not enough), or give up and withdraw the allowance unused.
    const deadline = Date.now() + responseTimeoutMs;
    while (grant.remaining > 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
  } catch (error) {
    clickError = error;
  }
  const sent = grant.remaining < 1;
  // Withdrawn before anything else: a request not yet sent can no longer be.
  session.writeAllowance = undefined;
  page.off('request', watch);
  if (!sent)
    throw new BrowserError(
      'APPROVED_REQUEST_NOT_SENT',
      'The approved request was not sent; nothing was submitted',
      409,
    );
  if (clickError || !approved)
    throw uncertain(
      clickError instanceof Error ? clickError.message : 'request not observed',
    );
  const response = await Promise.race([
    approved.response(),
    new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), Math.max(1000, responseTimeoutMs)),
    ),
  ]).catch(() => null);
  if (response === 'timeout') throw uncertain('no response before the timeout');
  if (!response) throw uncertain('the request failed in the network');
  const status = response.status();
  if (status >= 500) throw uncertain('server error ' + status);
  if (status >= 400)
    throw new BrowserError(
      'APPROVED_REQUEST_REJECTED',
      'The server refused the approved request (' + status + ')',
      409,
    );
  await settle(page).catch(() => undefined);
  return { url: page.url(), status };
}
