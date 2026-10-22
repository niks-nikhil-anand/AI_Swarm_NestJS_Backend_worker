import { z } from 'zod';
import type { SchemaObject } from '@nestjs/swagger';
import {
  RegisterSchema,
  LoginSchema,
  UpdateMeSchema,
  DeleteMeSchema,
} from '../auth/contracts/auth-request';
import { UpdateUserSchema } from '../users/contracts/user-request';

export const schemaRef = (name: string) => ({
  $ref: `#/components/schemas/${name}`,
});
export const demoCredentials = {
  email: 'person@example.com',
  password: 'ExamplePassword123!',
};

// Derive field types/limits from the actual Zod validators, rather than separate DTO validation.
function requestSchema(schema: z.ZodType): SchemaObject {
  const result = z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io: 'input',
  }) as SchemaObject;
  for (const name of ['password', 'newPassword', 'currentPassword']) {
    const property = result.properties?.[name] as SchemaObject | undefined;
    if (property) {
      property.format = 'password';
      property.writeOnly = true;
    }
  }
  const avatar = result.properties?.avatar as SchemaObject | undefined;
  if (avatar) {
    avatar.pattern = '^[Hh][Tt][Tt][Pp][Ss]?://';
    avatar.description =
      'HTTP/HTTPS avatar URL. Stored as a URL; the API does not fetch or upload it.';
  }
  return result;
}
const updateMe = requestSchema(UpdateMeSchema);
updateMe.minProperties = 1;
updateMe.anyOf = ['email', 'name', 'avatar', 'newPassword'].map((name) => ({
  required: [name],
}));
updateMe.description =
  'Partial update. Omitted fields stay unchanged. Effective email/password changes require currentPassword and revoke every session.';
const adminUpdate = requestSchema(UpdateUserSchema);
adminUpdate.minProperties = 1;

export const userApiSchemas: Record<string, SchemaObject> = {
  RegisterRequest: {
    ...requestSchema(RegisterSchema),
    example: { ...demoCredentials, name: 'Example User', avatar: null },
  },
  LoginRequest: { ...requestSchema(LoginSchema), example: demoCredentials },
  UpdateMeRequest: updateMe,
  UpdateUserRequest: { ...adminUpdate, example: { name: 'Updated User' } },
  DeleteAccountRequest: {
    ...requestSchema(DeleteMeSchema),
    example: { currentPassword: demoCredentials.password },
  },
  PublicUser: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'email', 'name', 'avatar', 'createdAt', 'updatedAt'],
    properties: {
      id: { type: 'string', example: '0477a242-e351-4b37-8e23-dcda99509653' },
      email: {
        type: 'string',
        format: 'email',
        example: demoCredentials.email,
      },
      name: { type: 'string', nullable: true, example: 'Example User' },
      avatar: { type: 'string', nullable: true, example: null },
      createdAt: {
        type: 'string',
        format: 'date-time',
        example: '2026-10-22T00:00:00.000Z',
      },
      updatedAt: {
        type: 'string',
        format: 'date-time',
        example: '2026-10-22T00:00:00.000Z',
      },
    },
  },
  AuthSessionResponse: {
    type: 'object',
    additionalProperties: false,
    required: ['user', 'accessToken', 'tokenType', 'expiresAt'],
    properties: {
      user: schemaRef('PublicUser'),
      accessToken: {
        type: 'string',
        pattern: '^swu_[A-Za-z0-9_-]{43}$',
        description:
          'Copy this actual response token into Authorize → user-session, without the Bearer prefix.',
        example: `swu_${'a'.repeat(43)}`,
      },
      tokenType: { type: 'string', enum: ['Bearer'] },
      expiresAt: { type: 'string', format: 'date-time' },
    },
  },
  UpdateMeResponse: {
    type: 'object',
    additionalProperties: false,
    required: ['user', 'reauthenticationRequired'],
    properties: {
      user: schemaRef('PublicUser'),
      reauthenticationRequired: {
        type: 'boolean',
        description:
          'If true, every prior token is invalid. Log in again with the updated credentials.',
      },
    },
  },
  UserPage: {
    type: 'object',
    additionalProperties: false,
    required: ['data', 'total', 'skip', 'take'],
    properties: {
      data: { type: 'array', items: schemaRef('PublicUser') },
      total: { type: 'integer', minimum: 0 },
      skip: { type: 'integer', minimum: 0 },
      take: { type: 'integer', minimum: 1, maximum: 100 },
    },
  },
  ApiError: {
    type: 'object',
    required: ['error'],
    additionalProperties: false,
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message', 'retryable'],
        additionalProperties: false,
        properties: {
          code: { type: 'string', example: 'SESSION_INVALID' },
          message: { type: 'string', example: 'Invalid session' },
          retryable: { type: 'boolean', example: false },
        },
      },
    },
  },
};
