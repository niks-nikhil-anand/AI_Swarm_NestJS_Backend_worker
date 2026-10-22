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
  // With an idempotency key, a replayed step gets its existing artifact back.
  async save(
    run: Run,
    data: Buffer,
    mimeType = 'image/png',
    idempotencyKey?: string,
  ) {
    if (data.length > 10000000)
      throw new ServiceError(
        'ARTIFACT_TOO_LARGE',
        'Artifact size limit exceeded',
      );
    const existing = async () =>
      idempotencyKey
        ? (
            await this.db.query<{
              id: string;
              mime_type: string;
              size: string;
              checksum: string;
            }>(
              'SELECT id,mime_type,size,checksum FROM artifacts WHERE run_id=$1 AND idempotency_key=$2',
              [run.id, idempotencyKey],
            )
          ).map((row) => ({
            id: row.id,
            mimeType: row.mime_type,
            size: Number(row.size),
            checksum: row.checksum,
          }))[0]
        : undefined;
    const stored = await existing();
    if (stored) return stored;
    const id = randomUUID(),
      checksum = createHash('sha256').update(data).digest('hex');
    await this.storage.put(id, data);
    let inserted: unknown[];
    try {
      inserted = await this.db.query(
        'INSERT INTO artifacts(id,run_id,object_key,mime_type,size,checksum,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (run_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id',
        [
          id,
          run.id,
          id,
          mimeType,
          data.length,
          checksum,
          idempotencyKey ?? null,
        ],
      );
    } catch (error) {
      await this.storage.remove(id);
      throw error;
    }
    if (!inserted.length) {
      // A concurrent attempt stored the same artifact first.
      await this.storage.remove(id);
      return (await existing())!;
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
