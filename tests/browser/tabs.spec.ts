import { randomUUID } from 'node:crypto';
import { TargetRegistryService } from '../../src/browser/targets/target-registry.service';
import type { Locator } from 'playwright';
test('element references cannot cross sessions, tabs or revisions', () => {
  const targets = new TargetRegistryService(),
    locator = {} as Locator;
  const id = targets.register('session', 'tab', 'revision', locator);
  expect(targets.get(id, 'session', 'tab', 'revision')).toBe(locator);
  for (const args of [
    [randomUUID(), 'tab', 'revision'],
    ['session', 'other', 'revision'],
    ['session', 'tab', 'new'],
  ])
    expect(() => targets.get(id, args[0], args[1], args[2])).toThrow();
  targets.clear('session');
  expect(() => targets.get(id, 'session', 'tab', 'revision')).toThrow();
});
