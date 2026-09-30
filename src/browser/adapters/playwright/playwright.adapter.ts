import { Injectable } from '@nestjs/common';
import type { Page } from 'playwright';
import { z } from 'zod';
export const ArticleSchema = z
  .object({
    url: z.string().url(),
    title: z.string().max(2000),
    text: z.string().max(20000),
  })
  .strict();
@Injectable()
export class PlaywrightAdapter {
  async article(page: Page) {
    return ArticleSchema.parse({
      url: page.url(),
      title: await page.title(),
      text: (await page.locator('body').innerText()).slice(0, 20000),
    });
  }
}
