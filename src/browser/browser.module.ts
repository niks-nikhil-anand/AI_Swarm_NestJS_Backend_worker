import { SessionCleanupJob } from '../jobs/cleanup/session-cleanup.job';
import { Module } from '@nestjs/common';
import { ChromiumService } from './chromium/chromium.service';
import { DomainPolicyService } from './policies/domain-policy.service';
import { NetworkPolicyService } from './policies/network-policy.service';
import { CapabilityPolicyService } from './policies/capability-policy.service';
import { ResourcePolicyService } from './policies/resource-policy.service';
import { BrowserPolicyService } from './policies/browser-policy.service';
import { SessionManagerService } from './services/session-manager.service';
import { TabManagerService } from './services/tab-manager.service';
import { BrowserService } from './services/browser.service';
import { TargetRegistryService } from './targets/target-registry.service';
import { PlaywrightAdapter } from './adapters/playwright/playwright.adapter';
@Module({
  providers: [
    SessionCleanupJob,
    ChromiumService,
    DomainPolicyService,
    NetworkPolicyService,
    CapabilityPolicyService,
    ResourcePolicyService,
    BrowserPolicyService,
    SessionManagerService,
    TabManagerService,
    BrowserService,
    TargetRegistryService,
    PlaywrightAdapter,
  ],
  exports: [BrowserService, SessionManagerService],
})
export class BrowserModule {}
