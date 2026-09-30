import { Injectable } from '@nestjs/common';
import type { BrowserSession } from '../contracts/browser-session';
import { BrowserError } from '../../common/errors/browser.errors';
@Injectable()
export class TabManagerService {
  get(session: BrowserSession, id: string) {
    const page = session.tabs.get(id);
    if (!page || page.isClosed())
      throw new BrowserError('TAB_NOT_FOUND', 'Tab not found', 404);
    return page;
  }
}
