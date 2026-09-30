import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalStorage } from '../../src/artifacts/storage/local.storage';
import {
  ConfigurationService,
  loadConfiguration,
} from '../../src/config/configuration';
test('local artifacts are restricted to generated keys and survive read/delete', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-artifacts-'));
  const storage = new LocalStorage(
    new ConfigurationService(
      loadConfiguration('search', {
        DATABASE_URL: 'postgresql://u:p@localhost/db',
        ARTIFACT_ROOT: directory,
      }),
    ),
  );
  try {
    const key = randomUUID();
    await storage.put(key, Buffer.from('artifact'));
    expect((await storage.get(key)).toString()).toBe('artifact');
    await expect(storage.get('../../secrets')).rejects.toThrow();
    await storage.remove(key);
    await expect(storage.get(key)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
