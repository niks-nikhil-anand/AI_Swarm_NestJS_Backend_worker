import { Injectable } from '@nestjs/common';
import type { BrowserSession } from '../contracts/browser-session';
import type { ExecutionContext } from '../../common/types/execution-context';
import { PolicyError } from '../../common/errors/policy.errors';
import { CapabilityPolicyService } from './capability-policy.service';
import { ResourcePolicyService } from './resource-policy.service';
@Injectable()
export class BrowserPolicyService {
  constructor(
    private readonly capability: CapabilityPolicyService,
    private readonly resources: ResourcePolicyService,
  ) {}
  assert(session: BrowserSession, ctx: ExecutionContext) {
    if (
      session.closed ||
      session.owner.tenantId !== ctx.tenantId ||
      session.owner.projectId !== ctx.projectId
    )
      throw new PolicyError('SESSION_DENIED', 'Session ownership mismatch');
    this.capability.assert(ctx);
    this.resources.assert(session);
  }
}
