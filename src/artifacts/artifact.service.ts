import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LocalStorage } from './storage/local.storage';
import { DatabaseService } from '../persistence/database.service';
import type { Run } from '../persistence/run.repository';
import type { ExecutionContext } from '../common/types/execution-context';
import { ServiceError } from '../common/errors/service.error';
@Injectable()
export class ArtifactService {
  constructor(
    private readonly storage: LocalStorage,
    private readonly db: DatabaseService,
  ) {}
  async save(run: Run, data: Buffer, mimeType = 'image/png') {
    if (data.length > 10000000)
      throw new ServiceError(
        'ARTIFACT_TOO_LARGE',
        'Artifact size limit exceeded',
      );
    const id = randomUUID(),
      checksum = createHash('sha256').update(data).digest('hex');
    await this.storage.put(id, data);
    try {
      await this.db.query(
        'INSERT INTO artifacts(id,run_id,object_key,mime_type,size,checksum) VALUES($1,$2,$3,$4,$5,$6)',
        [id, run.id, id, mimeType, data.length, checksum],
      );
    } catch (error) {
      await this.storage.remove(id);
      throw error;
    }
    return { id, mimeType, size: data.length, checksum };
  }
  async get(ctx: ExecutionContext, id: string) {
    z.uuid().parse(id);
    const rows = await this.db.query(
      'SELECT a.* FROM artifacts a JOIN runs r ON r.id=a.run_id WHERE a.id=$1 AND r.tenant_id=$2 AND r.project_id=$3',
      [id, ctx.tenantId, ctx.projectId],
    );
    if (!rows[0])
      throw new ServiceError('ARTIFACT_NOT_FOUND', 'Artifact not found', 404);
    return {
      data: await this.storage.get(rows[0].object_key as string),
      mimeType: rows[0].mime_type as string,
    };
  }
}
