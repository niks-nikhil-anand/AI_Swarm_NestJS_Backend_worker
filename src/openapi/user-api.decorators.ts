import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { schemaRef } from './user-api.schemas';

export const noStoreHeaders = {
  'Cache-Control': {
    description: 'Authentication responses must not be cached.',
    schema: { type: 'string' as const, example: 'no-store' },
  },
};
export const errorResponse = (status: number, description: string) =>
  ApiResponse({ status, description, schema: schemaRef('ApiError') });
export const authUnauthorized = () =>
  errorResponse(
    401,
    'Invalid, expired or revoked session; incorrect credentials or current-password confirmation.',
  );
export const emailConflict = () =>
  errorResponse(
    409,
    'EMAIL_IN_USE: normalized email is already registered. No partial changes are committed.',
  );
export function authCommonErrors() {
  return applyDecorators(
    errorResponse(
      400,
      'Invalid body, unsupported fields or oversized authorization header.',
    ),
    errorResponse(403, 'ORIGIN_DENIED: browser origin is not allowed.'),
    ApiResponse({
      status: 429,
      description: 'RATE_LIMITED: wait before retrying.',
      schema: schemaRef('ApiError'),
      headers: {
        ...noStoreHeaders,
        'Retry-After': {
          schema: { type: 'integer', minimum: 1, maximum: 60 },
          description: 'Seconds until this rate-limit window resets.',
        },
      },
    }),
    errorResponse(
      500,
      'Database or internal dependency failure. Details are redacted.',
    ),
    errorResponse(
      503,
      'AUTH_CAPACITY: bounded authentication capacity is temporarily exhausted.',
    ),
  );
}
