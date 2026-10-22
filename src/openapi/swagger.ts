import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { userApiSchemas } from './user-api.schemas';

export function setupUserSwagger(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('AI Swarm — User & Authentication APIs')
    .setDescription(
      [
        '1. Execute **POST /auth/register** with a fresh email, or **POST /auth/login** for an existing user.',
        '2. Copy **accessToken** from the actual response. Click **Authorize**, paste it into **user-session** without the Bearer prefix, and authorize.',
        '3. Test **GET /auth/me**, **PUT /auth/me**, **POST /auth/logout** and **DELETE /auth/me** with Try it out.',
        'Changing email/password revokes all sessions; log in and authorize again. Logout revokes the presented token. DELETE /auth/me deactivates the account and retains its email.',
        '**Users (admin)** uses the separate **admin-token** from a server-configured AUTH_CREDENTIALS principal with users capability. Login tokens do not grant administrative access.',
        'Authorization is held in memory and is not persisted across page reloads. No real credentials are embedded in this documentation.',
      ].join('\n\n'),
    )
    .setVersion('1.0.0')
    .addServer('/')
    .addTag(
      'Authentication',
      'Register, sign in/out and manage the currently authenticated user.',
    )
    .addTag(
      'Users (admin)',
      'Privileged user CRUD; requires the separate configured users capability.',
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'Opaque session token',
        description:
          'Paste accessToken from register/login. Do not include Bearer.',
      },
      'user-session',
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        description:
          'Server-configured administrative token with users capability. This is not a user login token.',
      },
      'admin-token',
    )
    .build();
  const documentFactory = () => {
    const document = SwaggerModule.createDocument(app, config, {
      include: [AuthModule, UsersModule],
      deepScanRoutes: false,
      autoTagControllers: false,
    });
    document.components = {
      ...document.components,
      schemas: { ...document.components?.schemas, ...userApiSchemas },
    };
    return document;
  };
  SwaggerModule.setup('docs', app, documentFactory, {
    jsonDocumentUrl: '/docs-json',
    raw: ['json'],
    customSiteTitle: 'AI Swarm — User API Explorer',
    swaggerOptions: {
      persistAuthorization: false,
      tryItOutEnabled: true,
      displayRequestDuration: true,
      docExpansion: 'list',
      filter: true,
      validatorUrl: null,
    },
  });
}
