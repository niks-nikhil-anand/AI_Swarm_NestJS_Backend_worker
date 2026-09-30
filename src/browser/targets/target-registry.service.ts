import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Locator } from 'playwright';
import type { ElementReference } from './element-reference';
import { BrowserError } from '../../common/errors/browser.errors';
@Injectable()
export class TargetRegistryService {
  private readonly entries = new Map<string, ElementReference>();
  register(
    sessionId: string,
    tabId: string,
    revision: string,
    locator: Locator,
  ) {
    const id = randomUUID();
    this.entries.set(id, { id, sessionId, tabId, revision, locator });
    return id;
  }
  get(id: string, sessionId: string, tabId: string, revision: string) {
    const value = this.entries.get(id);
    if (
      !value ||
      value.sessionId !== sessionId ||
      value.tabId !== tabId ||
      value.revision !== revision
    )
      throw new BrowserError(
        'STALE_TARGET',
        'Target is stale or belongs to another page',
        409,
      );
    return value.locator;
  }
  clear(sessionId: string) {
    for (const [id, item] of this.entries)
      if (item.sessionId === sessionId) this.entries.delete(id);
  }
}
