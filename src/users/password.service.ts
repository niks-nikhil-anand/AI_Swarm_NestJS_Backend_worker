import { Injectable } from '@nestjs/common';
import { randomBytes, scrypt } from 'node:crypto';

@Injectable()
export class PasswordService {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password,
        salt,
        64,
        { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
        (error, derived) => {
          if (error) reject(error);
          else resolve(derived);
        },
      );
    });
    return `scrypt$32768$8$3$${salt.toString('hex')}$${key.toString('hex')}`;
  }
}
