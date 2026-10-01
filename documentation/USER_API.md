# User CRUD API

The NestJS API now supports managing users through Prisma 7. Users have globally unique email addresses, optional names/avatars, and securely hashed passwords. Their linked OAuth accounts are removed when a user is deleted. OAuth login and account creation endpoints are separate future work.

## Setup and authorization

Apply the existing Prisma migrations to the intended database and build the app:

```powershell
npm run db:migrate:prisma
npm run build
npm run start:prod
```

Every user endpoint requires `Authorization: Bearer <token>`. Add `users` to the capabilities of the designated user administrator in the existing AUTH_CREDENTIALS configuration. Preserve the other principal fields and permissions. This grants management of all users globally; it is separate from project access. Existing search/browser/research tokens without this capability receive 403. These are administrative CRUD endpoints, not public signup or user login endpoints.

The current Compose migration job runs the legacy research SQL migrations only. Run the Prisma migration command with a connection to the same PostgreSQL database before using user routes in that deployment. Existing populated databases without Prisma migration history need reviewed onboarding before `migrate deploy`; do not reset them. Image builds generate the client automatically.

## Endpoints

| Method | Route                 | Result                                            |
| ------ | --------------------- | ------------------------------------------------- |
| POST   | /users                | Create a user; 201                                |
| GET    | /users/:id            | Fetch one user; 200                               |
| GET    | /users?skip=0&take=20 | Fetch a page of users; 200                        |
| PUT    | /users/:id            | Update supplied fields; 200                       |
| DELETE | /users/:id            | Delete user and linked accounts; 204 with no body |

POST requires `email` and `password`. `name` and `avatar` are optional. Passwords must contain 8 to 128 characters and are stored as salted scrypt hashes. Email addresses are trimmed and lowercased. Names are trimmed and limited to 100 characters; avatar URLs must use HTTP or HTTPS and are limited to 2048 characters. The API stores the avatar URL; it does not upload or fetch images.

Example POST body:

```json
{
  "email": "person@example.com",
  "password": "A strong example password",
  "name": "Example User",
  "avatar": "https://example.com/avatar.png"
}
```

PUT accepts any nonempty subset of those fields. Omitted fields remain unchanged; `name` and `avatar` can be cleared with null. Password cannot be cleared with null. IDs, timestamps, tenant fields and accounts cannot be set through the user body.

Create/get/update responses contain only `id`, `email`, `name`, `avatar`, `createdAt` and `updatedAt`. Password hashes and OAuth tokens are never selected for responses. List returns `{ "data": [...], "total": 0, "skip": 0, "take": 20 }`; take is 1 to 100, skip is 0 to 1000000, and ordering is newest first with an ID tie-breaker. Continue requesting pages to retrieve all users.

Missing users return 404, duplicate emails return 409, invalid bodies/query parameters return 400, missing/invalid tokens return 401, and tokens without users capability return 403. Errors use the existing `{ "error": { "code", "message", "retryable" } }` response format.

## Verification

The real PostgreSQL HTTP test suite covers authorization, validation, password hashing, CRUD, pagination, concurrent duplicate-email creation, conflicting updates, secret-free responses and linked-account cleanup. It creates and drops a unique temporary schema, leaving application tables untouched. The test database role must be able to create schemas.

```powershell
$env:USER_API_TEST_DATABASE_URL = 'postgresql://user:password@localhost:5432/test_database'
npm run test:users
```

Without USER_API_TEST_DATABASE_URL the live suite is skipped. Build and type checking can run without a database connection.
