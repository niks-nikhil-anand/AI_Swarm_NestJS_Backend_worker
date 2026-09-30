import type { BrowserSession } from '../contracts/browser-session';
export function listTabsTool(session: BrowserSession) {
  return [...session.tabs].map(([id, page]) => ({ id, url: page.url() }));
}
