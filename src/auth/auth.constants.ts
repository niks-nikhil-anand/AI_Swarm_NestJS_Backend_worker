import { createHash } from 'node:crypto';
import { Prisma } from '../generated/prisma/client';
export const publicUser = {
  id: true,
  email: true,
  name: true,
  avatar: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;
export const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export function bearer(header: string | undefined): string | undefined {
  if (!header || !/^Bearer swu_[A-Za-z0-9_-]{43}$/.test(header))
    return undefined;
  return header.slice(7);
}
export interface AuthIdentity {
  userId: string;
  sessionId: string;
  credentialVersion: number;
}
