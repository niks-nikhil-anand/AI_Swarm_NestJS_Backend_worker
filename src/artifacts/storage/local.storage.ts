import { Injectable } from '@nestjs/common';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { ConfigurationService } from '../../config/configuration';
import type { Storage } from './storage.interface';
@Injectable()
export class LocalStorage implements Storage {
  private readonly root: string;
  constructor(config: ConfigurationService) {
    this.root = resolve(config.value.artifactRoot);
  }
  private path(key: string) {
    return join(this.root, z.uuid().parse(key));
  }
  async put(key: string, data: Buffer) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeFile(this.path(key), data, { flag: 'wx', mode: 0o600 });
  }
  async get(key: string) {
    return readFile(this.path(key));
  }
  async remove(key: string) {
    await unlink(this.path(key)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
