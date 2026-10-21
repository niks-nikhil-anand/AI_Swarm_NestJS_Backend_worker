import request from 'supertest';
import type {
  OpenAPIObject,
  SchemaObject,
  ReferenceObject,
  OperationObject,
  ResponseObject,
} from '@nestjs/swagger';
import {
  RegisterSchema,
  LoginSchema,
  UpdateMeSchema,
  DeleteMeSchema,
} from '../src/auth/contracts/auth-request';
import {
  CreateUserSchema,
  UpdateUserSchema,
} from '../src/users/contracts/user-request';
import {
  UserApiFixture,
  headers,
  publicFields,
} from './helpers/user-api-test-app';

const live = process.env.AUTH_API_TEST_DATABASE_URL ? describe : describe.skip;
live('Swagger user/auth API explorer', () => {
  const f = new UserApiFixture();
  let document: OpenAPIObject;
  beforeAll(async () => {
    await f.start(process.env.AUTH_API_TEST_DATABASE_URL, false, {
      swagger: true,
    });
    document = (
      await request(f.app.getHttpServer()).get('/docs-json').expect(200)
    ).body;
  }, 60000);
  beforeEach(() => f.reset());
  afterAll(() => f.close());
  function schema(name: string) {
    return document.components!.schemas![name] as SchemaObject;
  }
  test('serves Swagger UI and its local scripts without persisting authorization', async () => {
    const html = await request(f.app.getHttpServer()).get('/docs').expect(200);
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.text).toContain('swagger-ui');
    const init = await request(f.app.getHttpServer())
      .get('/docs/swagger-ui-init.js')
      .expect(200);
    expect(init.text).toMatch(/"persistAuthorization":\s*false/);
    expect(init.text).toMatch(/"tryItOutEnabled":\s*true/);
    await request(f.app.getHttpServer())
      .get('/docs/swagger-ui-bundle.js')
      .expect(200);
    await request(f.app.getHttpServer())
      .get('/docs/swagger-ui.css')
      .expect(200);
  });
  test('documents exactly the 12 user/auth operations and two separate bearer schemes', () => {
    expect(document.openapi).toMatch(/^3\.0\./);
    const operations = Object.entries(document.paths).flatMap(([path, item]) =>
      Object.keys(item!)
        .filter((method) => ['get', 'post', 'put', 'delete'].includes(method))
        .map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(operations.sort()).toEqual(
      [
        'POST /auth/register',
        'POST /auth/login',
        'POST /auth/logout',
        'POST /auth/logout-all',
        'GET /auth/me',
        'PUT /auth/me',
        'DELETE /auth/me',
        'POST /users',
        'GET /users',
        'GET /users/{id}',
        'PUT /users/{id}',
        'DELETE /users/{id}',
      ].sort(),
    );
    expect(document.components!.securitySchemes).toMatchObject({
      'user-session': { type: 'http', scheme: 'bearer' },
      'admin-token': { type: 'http', scheme: 'bearer' },
    });
    expect(document.paths['/auth/register']!.post!.security).toEqual([]);
    expect(document.paths['/auth/login']!.post!.security).toEqual([]);
    expect(document.paths['/auth/logout']!.post!.security).toEqual([
      {},
      { 'user-session': [] },
    ]);
    for (const method of ['get', 'put', 'delete'] as const)
      expect(document.paths['/auth/me']![method]!.security).toEqual([
        { 'user-session': [] },
      ]);
    for (const path of ['/users', '/users/{id}'])
      for (const operation of Object.values(document.paths[path]!))
        expect((operation as OperationObject).security).toEqual([
          { 'admin-token': [] },
        ]);
  });
  test('all schema references resolve and public response models cannot expose credentials', () => {
    function visit(value: unknown) {
      if (!value || typeof value !== 'object') return;
      if ('$ref' in value) {
        const ref = (value as ReferenceObject).$ref;
        expect(ref.startsWith('#/components/schemas/')).toBe(true);
        expect(document.components!.schemas).toHaveProperty(
          ref.split('/').at(-1)!,
        );
      }
      for (const child of Object.values(value)) visit(child);
    }
    visit(document.paths);
    visit(document.components!.schemas);
    expect(schema('PublicUser').required!.slice().sort()).toEqual(publicFields);
    expect(Object.keys(schema('PublicUser').properties!).sort()).toEqual(
      publicFields,
    );
    expect(JSON.stringify(schema('PublicUser'))).not.toMatch(
      /password|tokenHash|accounts|sessions|credentialVersion/,
    );
  });
  test('request limits, required fields, write-only passwords and strict partial updates match the validators', () => {
    expect(schema('RegisterRequest').required).toEqual(['email', 'password']);
    expect(schema('RegisterRequest').properties!.password).toMatchObject({
      minLength: 8,
      maxLength: 128,
      writeOnly: true,
      format: 'password',
    });
    expect(schema('RegisterRequest').properties!.email).toMatchObject({
      format: 'email',
      maxLength: 254,
    });
    expect(schema('UpdateMeRequest').additionalProperties).toBe(false);
    expect(schema('UpdateMeRequest').anyOf).toEqual(
      ['email', 'name', 'avatar', 'newPassword'].map((name) => ({
        required: [name],
      })),
    );
    expect(schema('UpdateMeRequest').properties!.name).toMatchObject({
      nullable: true,
    });
    expect(schema('UpdateMeRequest').properties!.currentPassword).toMatchObject(
      { writeOnly: true },
    );
    expect(schema('DeleteAccountRequest').required).toEqual([
      'currentPassword',
    ]);
    expect(schema('UpdateUserRequest').properties).toHaveProperty('password');
    expect(schema('UpdateUserRequest').properties).not.toHaveProperty(
      'newPassword',
    );
    const take = document.paths['/users']!.get!.parameters!.find(
      (p) => 'name' in p && p.name === 'take',
    );
    expect(take).toMatchObject({
      required: false,
      schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    });
  });
  test('every documented JSON request example passes the real endpoint validator', () => {
    for (const [name, validator] of [
      ['RegisterRequest', RegisterSchema],
      ['LoginRequest', LoginSchema],
      ['DeleteAccountRequest', DeleteMeSchema],
      ['UpdateUserRequest', UpdateUserSchema],
    ] as const)
      expect(validator.safeParse(schema(name).example).success).toBe(true);
    expect(
      CreateUserSchema.safeParse(schema('RegisterRequest').example).success,
    ).toBe(true);
    const body = document.paths['/auth/me']!.put!.requestBody as {
      content: {
        'application/json': { examples: Record<string, { value: unknown }> };
      };
    };
    for (const example of Object.values(
      body.content['application/json'].examples,
    ))
      expect(UpdateMeSchema.safeParse(example.value).success).toBe(true);
  });
  test('documented examples execute register/login, authorized GET/PUT, logout and DELETE against PostgreSQL', async () => {
    const register = await request(f.app.getHttpServer())
      .post('/auth/register')
      .send(schema('RegisterRequest').example)
      .expect(201);
    const login = await request(f.app.getHttpServer())
      .post('/auth/login')
      .send(schema('LoginRequest').example)
      .expect(200);
    const token = login.body.accessToken as string;
    expect((await f.me(token).expect(200)).body.id).toBe(register.body.user.id);
    await request(f.app.getHttpServer())
      .put('/auth/me')
      .set(headers(token))
      .send({ name: 'Swagger Updated' })
      .expect(200);
    expect((await f.me(token).expect(200)).body.name).toBe('Swagger Updated');
    const raw = JSON.stringify(
      (await request(f.app.getHttpServer()).get('/docs-json').expect(200)).body,
    );
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(f.adminToken);
    await request(f.app.getHttpServer())
      .post('/auth/logout')
      .set(headers(token))
      .expect(204);
    await f.me(token).expect(401);
    const reLogin = await request(f.app.getHttpServer())
      .post('/auth/login')
      .send(schema('LoginRequest').example)
      .expect(200);
    await request(f.app.getHttpServer())
      .delete('/auth/me')
      .set(headers(reLogin.body.accessToken))
      .send(schema('DeleteAccountRequest').example)
      .expect(204);
    await f.me(reLogin.body.accessToken).expect(401);
  });
  test('documents empty 204 responses and the same error envelope as the APIs', () => {
    for (const operation of [
      document.paths['/auth/logout']!.post!,
      document.paths['/auth/logout-all']!.post!,
      document.paths['/auth/me']!.delete!,
      document.paths['/users/{id}']!.delete!,
    ])
      expect(operation.responses['204']).not.toHaveProperty('content');
    const error = document.paths['/auth/me']!.get!.responses[
      '401'
    ] as ResponseObject;
    expect(error.content?.['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/ApiError',
    });
    expect(schema('ApiError').properties!.error).toMatchObject({
      required: ['code', 'message', 'retryable'],
    });
    expect(document.paths['/auth/login']!.post!.responses).toHaveProperty(
      '429',
    );
    expect(document.paths['/auth/me']!.put!.responses).toHaveProperty('409');
  });
});
