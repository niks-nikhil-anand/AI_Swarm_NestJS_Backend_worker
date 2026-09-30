import type {
  Stagehand,
  StagehandBrowser,
  StagehandCreateOptions,
} from '@browserbasehq/stagehand';

// Not registered in BrowserModule until the semantic compatibility gate passes.
export class StagehandAdapter {
  private constructor(
    readonly browser: StagehandBrowser,
    readonly client: Stagehand,
  ) {}
  static async connect(
    cdpUrl: string,
    extensionId: string,
    options: Omit<StagehandCreateOptions, 'browser'>,
  ) {
    const sdk = await import('@browserbasehq/stagehand');
    const browser = await sdk.localBrowser.connect({ cdpUrl, extensionId });
    try {
      return new StagehandAdapter(
        browser,
        await sdk.Stagehand.create({ ...options, browser }),
      );
    } catch (error) {
      await browser.close();
      throw error;
    }
  }
  async close() {
    try {
      await this.client.close();
    } finally {
      await this.browser.close();
    }
  }
}
