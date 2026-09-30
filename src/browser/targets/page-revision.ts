import type { Page } from 'playwright';
import { createHash } from 'node:crypto';
import { BrowserError } from '../../common/errors/browser.errors';
export async function pageRevision(page: Page) {
  const snapshot = await page.evaluate(() => {
    let html = document.documentElement?.outerHTML || '';
    const appendShadow = (root: Document | ShadowRoot) => {
      for (const node of root.querySelectorAll('*'))
        if (node.shadowRoot) {
          html += node.shadowRoot.innerHTML;
          appendShadow(node.shadowRoot);
        }
    };
    appendShadow(document);
    return {
      origin: performance.timeOrigin,
      html: html.length <= 2000000 ? html : null,
    };
  });
  if (snapshot.html === null)
    throw new BrowserError('PAGE_TOO_LARGE', 'Page exceeds observation budget');
  return (
    String(snapshot.origin) +
    ':' +
    createHash('sha256').update(snapshot.html).digest('hex')
  );
}
