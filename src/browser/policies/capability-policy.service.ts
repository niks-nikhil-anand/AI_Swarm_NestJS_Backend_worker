import { Injectable } from '@nestjs/common';
import type { ExecutionContext } from '../../common/types/execution-context';
import { PolicyError } from '../../common/errors/policy.errors';
@Injectable()
export class CapabilityPolicyService {
  assert(ctx: ExecutionContext) {
    if (
      !ctx.capabilities.includes('browser') &&
      !ctx.capabilities.includes('research')
    )
      throw new PolicyError('CAPABILITY_DENIED', 'Browser capability required');
  }
}
