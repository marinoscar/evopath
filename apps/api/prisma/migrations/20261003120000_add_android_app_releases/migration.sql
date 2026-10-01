-- Android APK releases (#285, epic #276).

-- AlterTable
ALTER TABLE "health_sync_devices" ADD COLUMN "app_version_code" INTEGER;

-- CreateTable
CREATE TABLE "android_app_releases" (
    "id" UUID NOT NULL,
    "package_name" TEXT NOT NULL,
    "version_name" VARCHAR(50) NOT NULL,
    "version_code" INTEGER NOT NULL,
    "signing_sha256" TEXT NOT NULL,
    "file_sha256" CHAR(64) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "notes" VARCHAR(2000),
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "android_app_releases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "android_app_releases_created_at_idx" ON "android_app_releases"("created_at");

-- CreateIndex
CREATE INDEX "android_app_releases_uploaded_by_id_idx" ON "android_app_releases"("uploaded_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "android_app_releases_package_name_version_code_key" ON "android_app_releases"("package_name", "version_code");

-- AddForeignKey
ALTER TABLE "android_app_releases" ADD CONSTRAINT "android_app_releases_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================
-- Raw-SQL constraints (intentional schema drift: Prisma cannot express these).
-- Never declare android_app_releases_one_current_uniq_idx as @@unique and never
-- replace it with a findFirst pre-check; make-current clears the old flag and
-- sets the new one in one transaction, and the database rejects a second
-- current row (P2002).
-- =============================================================================

-- At most one current release deployment-wide.
CREATE UNIQUE INDEX "android_app_releases_one_current_uniq_idx" ON "android_app_releases" ((true)) WHERE "is_current";
