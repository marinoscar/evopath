-- CreateEnum
CREATE TYPE "HealthSyncDeviceStatus" AS ENUM ('active', 'revoked');

-- CreateEnum
CREATE TYPE "HealthSyncTrigger" AS ENUM ('periodic', 'manual', 'initial', 'app_open');

-- CreateEnum
CREATE TYPE "HealthSyncRunStatus" AS ENUM ('ok', 'partial', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "health_sync_devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "manufacturer" TEXT,
    "model" TEXT,
    "android_version" TEXT,
    "sdk_int" INTEGER,
    "app_version" TEXT,
    "health_connect_version" TEXT,
    "package_name" TEXT,
    "signing_sha256" TEXT,
    "timezone" TEXT,
    "pat_id" UUID,
    "status" "HealthSyncDeviceStatus" NOT NULL DEFAULT 'active',
    "last_seen_at" TIMESTAMPTZ,
    "last_sync_at" TIMESTAMPTZ,
    "last_sync_status" "HealthSyncRunStatus",
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "health_sync_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_sync_runs" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "trigger" "HealthSyncTrigger" NOT NULL,
    "status" "HealthSyncRunStatus" NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL,
    "finished_at" TIMESTAMPTZ NOT NULL,
    "window_from" DATE,
    "window_to" DATE,
    "records_read" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "deleted" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "error_message" TEXT,
    "details" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_sync_diagnostic_reports" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "summary" TEXT,
    "report" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_sync_diagnostic_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "health_sync_devices_user_id_status_idx" ON "health_sync_devices"("user_id", "status");

-- CreateIndex
CREATE INDEX "health_sync_devices_pat_id_idx" ON "health_sync_devices"("pat_id");

-- CreateIndex
CREATE UNIQUE INDEX "health_sync_devices_user_id_installation_id_key" ON "health_sync_devices"("user_id", "installation_id");

-- CreateIndex
CREATE INDEX "health_sync_runs_device_id_created_at_idx" ON "health_sync_runs"("device_id", "created_at");

-- CreateIndex
CREATE INDEX "health_sync_runs_user_id_created_at_idx" ON "health_sync_runs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "health_sync_diagnostic_reports_device_id_created_at_idx" ON "health_sync_diagnostic_reports"("device_id", "created_at");

-- CreateIndex
CREATE INDEX "health_sync_diagnostic_reports_user_id_idx" ON "health_sync_diagnostic_reports"("user_id");

-- AddForeignKey
ALTER TABLE "health_sync_devices" ADD CONSTRAINT "health_sync_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_sync_devices" ADD CONSTRAINT "health_sync_devices_pat_id_fkey" FOREIGN KEY ("pat_id") REFERENCES "personal_access_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_sync_runs" ADD CONSTRAINT "health_sync_runs_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "health_sync_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_sync_runs" ADD CONSTRAINT "health_sync_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_sync_diagnostic_reports" ADD CONSTRAINT "health_sync_diagnostic_reports_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "health_sync_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_sync_diagnostic_reports" ADD CONSTRAINT "health_sync_diagnostic_reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CHECK constraints (Prisma cannot express them)
ALTER TABLE "health_sync_devices"
  ADD CONSTRAINT "health_sync_devices_name_length_chk" CHECK (char_length("name") BETWEEN 1 AND 100);

ALTER TABLE "health_sync_runs"
  ADD CONSTRAINT "health_sync_runs_counts_chk" CHECK (
    "records_read" >= 0 AND "created" >= 0 AND "updated" >= 0 AND "deleted" >= 0
  );
