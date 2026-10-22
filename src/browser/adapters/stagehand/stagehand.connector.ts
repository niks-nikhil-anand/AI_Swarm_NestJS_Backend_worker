import { Inject, Injectable } from '@nestjs/common';
import {
  MODEL_PROVIDER,
  ModelProviderError,
  providerError,
  type GenerateParams,
  type ModelProvider,
} from './model-provider';
import { ConfigurationService } from '../../../config/configuration';
import { BrowserError } from '../../../common/errors/browser.errors';
import type { ChromiumConnection } from '../../chromium/chromium.connection';
import { StagehandAdapter } from './stagehand.adapter';

// Creates one StagehandAdapter per session, attached to that session's own Chromium.
@Injectable()
export class StagehandConnector {
  constructor(
    private readonly config: ConfigurationService,
    @Inject(MODEL_PROVIDER) private readonly model: ModelProvider | null,
  ) {}
  get semantic() {
    return this.model !== null;
  }
  get enabled() {
    return this.config.value.browser?.stagehand.enabled ?? false;
  }
  connect(connection: ChromiumConnection) {
    const settings = this.config.value.browser?.stagehand;
    if (!settings?.enabled)
      throw new BrowserError(
        'STAGEHAND_DISABLED',
        'Stagehand is disabled; set STAGEHAND_ENABLED=true for the browser worker',
        409,
      );
    if (connection.closed)
      throw new BrowserError(
        'SESSION_DISCONNECTED',
        'Session browser is no longer running',
        409,
      );
    const failures: { adapter?: StagehandAdapter } = {};
    const attached = StagehandAdapter.connect(
      connection.stagehand,
      {
        logging: { level: 'warn' },
        // The extension exports traces from inside Chromium, where the egress proxy cannot
        // see the method of a TLS tunnel. The 4.1.0 default (https://example.com) would be
        // reachable whenever example.com is allowlisted; a reserved .invalid host never is.
        telemetry: {
          traces: { endpoint: 'https://telemetry.invalid/v1/traces' },
        },
        // Client-side model: the extension asks this process, which calls the provider.
        // Per-call model configs (which would make the extension call out) are never passed.
        ...(this.model
          ? {
              model: {
                generate: async (params: GenerateParams) => {
                  const adapter = failures.adapter;
                  try {
                    // Per-step budget: refuse the call that would exceed it, and fail once
                    // the token total is over, rather than letting Stagehand keep paging.
                    if (
                      adapter?.budget &&
                      adapter.usage.calls >= adapter.budget.calls
                    )
                      throw new ModelProviderError(
                        'MODEL_BUDGET_EXCEEDED',
                        'Model call budget for this step is exhausted (' +
                          adapter.budget.calls +
                          ' calls)',
                        false,
                      );
                    if (adapter) adapter.usage.calls++;
                    const result = await this.model!.generate(params, {
                      signal: adapter?.aborts.signal,
                    });
                    if (adapter) {
                      adapter.usage.tokens += result.usage?.totalTokens ?? 0;
                      if (
                        adapter.budget &&
                        adapter.usage.tokens > adapter.budget.tokens
                      )
                        throw new ModelProviderError(
                          'MODEL_BUDGET_EXCEEDED',
                          'Model token budget for this step is exhausted (' +
                            adapter.budget.tokens +
                            ' tokens)',
                          false,
                        );
                    }
                    return result;
                  } catch (error: unknown) {
                    const typed = providerError(error);
                    if (adapter) adapter.lastModelError = typed;
                    throw typed;
                  }
                },
              },
            }
          : {}),
      },
      settings.connectTimeoutMs,
    );
    return attached.then((adapter) => {
      adapter.budget = {
        calls: settings.stepMaxModelCalls,
        tokens: settings.stepMaxModelTokens,
      };
      return (failures.adapter = adapter);
    });
  }
}
