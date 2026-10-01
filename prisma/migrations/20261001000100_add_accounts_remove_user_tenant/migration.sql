-- Apply atomically; conflicting legacy users must be reconciled explicitly.
BEGIN;
LOCK TABLE "users" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "users" WHERE "email" IS NULL)
       OR EXISTS (SELECT "id" FROM "users" GROUP BY "id" HAVING COUNT(*) > 1)
       OR EXISTS (SELECT "email" FROM "users" GROUP BY "email" HAVING COUNT(*) > 1) THEN
        RAISE EXCEPTION 'Cannot remove user tenant scope: resolve missing emails or duplicate IDs/emails first';
    END IF;
END $$;

-- CreateEnum
CREATE TYPE "AccountProvider" AS ENUM ('google', 'github');

-- DropIndex
DROP INDEX "users_tenant_id_email_key";

-- AlterTable
ALTER TABLE "users" DROP CONSTRAINT "users_pkey",
DROP COLUMN "tenant_id",
ADD COLUMN     "avatar" TEXT,
ADD COLUMN     "password_hash" TEXT,
ALTER COLUMN "email" SET NOT NULL,
ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" "AccountProvider" NOT NULL,
    "provider_id" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "token_type" TEXT,
    "scope" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accounts_user_id_idx" ON "accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_provider_id_key" ON "accounts"("provider", "provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
