import { ProjectAccessGuard } from '../../src/common/guards/project-access.guard';
import {
  ConfigurationService,
  loadConfiguration,
} from '../../src/config/configuration';
import type { ExecutionContext } from '@nestjs/common';
describe('Project authorization', () => {
  const token = 'a'.repeat(40);
  const config = new ConfigurationService(
    loadConfiguration('api', {
      DATABASE_URL: 'postgresql://u:p@localhost/db',
      AUTH_CREDENTIALS: JSON.stringify([
        {
          token,
          tenantId: 'tenant',
          userId: 'user',
          projectIds: ['allowed'],
          capabilities: ['search'],
        },
      ]),
    }),
  );
  const guard = new ProjectAccessGuard(config);
  const context = (projectId: string, bearer = token) => {
    const req = {
      headers: { authorization: 'Bearer ' + bearer },
      params: { projectId },
    };
    return {
      req,
      nest: {
        switchToHttp: () => ({ getRequest: () => req }),
      } as unknown as ExecutionContext,
    };
  };
  test('denies wrong token and project', () => {
    expect(() => guard.canActivate(context('allowed', 'bad').nest)).toThrow();
    expect(() => guard.canActivate(context('other').nest)).toThrow();
  });
  test('identity is derived from verified server configuration', () => {
    const item = context('allowed');
    guard.canActivate(item.nest);
    expect(item.req).toMatchObject({
      execution: { tenantId: 'tenant', userId: 'user', projectId: 'allowed' },
    });
    expect(item.req).not.toHaveProperty('token');
  });
});
