import { Injectable } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { ConfigurationService } from '../config/configuration';
import { ServiceError } from '../common/errors/service.error';

// Only this known parameter set is accepted; stored text cannot request unbounded work.
const format = /^scrypt\$32768\$8\$3\$([a-f0-9]{32})\$([a-f0-9]{128})$/;
const dummy = `scrypt$32768$8$3$${'00'.repeat(16)}$${'00'.repeat(64)}`;

@Injectable()
export class PasswordService {
  private active = 0;
  constructor(private readonly config: ConfigurationService) {}
  private async derive(password: string, salt: Buffer): Promise<Buffer> {
    if (this.active >= this.config.value.auth.hashConcurrency)
      throw new ServiceError(
        'AUTH_CAPACITY',
        'Authentication capacity exceeded',
        503,
        true,
        1000,
      );
    this.active++;
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        scrypt(
          password,
          salt,
          64,
          { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
          (error, key) => (error ? reject(error) : resolve(key)),
        );
      });
    } finally {
      this.active--;
    }
  }
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await this.derive(password, salt);
    return `scrypt$32768$8$3$${salt.toString('hex')}$${key.toString('hex')}`;
  }
  async verify(password: string, stored: string | null): Promise<boolean> {
    const match = format.exec(stored ?? '');
    const parsed = match ?? format.exec(dummy)!;
    const key = await this.derive(password, Buffer.from(parsed[1], 'hex'));
    return (
      timingSafeEqual(key, Buffer.from(parsed[2], 'hex')) && match !== null
    );
  }
}
