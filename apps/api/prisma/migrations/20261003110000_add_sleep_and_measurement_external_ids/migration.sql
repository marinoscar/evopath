-- AlterTable
ALTER TABLE "measurements" ADD COLUMN     "external_id" TEXT,
ADD COLUMN     "external_provider" TEXT,
ADD COLUMN     "health_sync_device_id" UUID;

-- CreateTable
CREATE TABLE "sleep_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "start_at" TIMESTAMPTZ NOT NULL,
    "end_at" TIMESTAMPTZ NOT NULL,
    "local_date" DATE NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "awake_minutes" INTEGER,
    "light_minutes" INTEGER,
    "deep_minutes" INTEGER,
    "rem_minutes" INTEGER,
    "unknown_minutes" INTEGER,
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "provider" TEXT,
    "external_id" TEXT,
    "health_sync_device_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sleep_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sleep_sessions_user_id_local_date_idx" ON "sleep_sessions"("user_id", "local_date");

-- CreateIndex
CREATE INDEX "sleep_sessions_health_sync_device_id_idx" ON "sleep_sessions"("health_sync_device_id");

-- CreateIndex
CREATE INDEX "measurements_health_sync_device_id_idx" ON "measurements"("health_sync_device_id");

-- AddForeignKey
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_health_sync_device_id_fkey" FOREIGN KEY ("health_sync_device_id") REFERENCES "health_sync_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_sessions" ADD CONSTRAINT "sleep_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_sessions" ADD CONSTRAINT "sleep_sessions_health_sync_device_id_fkey" FOREIGN KEY ("health_sync_device_id") REFERENCES "health_sync_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Intentional drift (Prisma cannot express partial unique indexes): one
-- device-synced measurement / sleep session per (user, provider, external id).
CREATE UNIQUE INDEX "measurements_provider_external_uniq_idx"
  ON "measurements" ("user_id", "external_provider", "external_id")
  WHERE "external_provider" IS NOT NULL;

CREATE UNIQUE INDEX "sleep_sessions_provider_external_uniq_idx"
  ON "sleep_sessions" ("user_id", "provider", "external_id")
  WHERE "provider" IS NOT NULL;

ALTER TABLE "sleep_sessions"
  ADD CONSTRAINT "sleep_sessions_end_after_start_chk" CHECK ("end_at" > "start_at"),
  ADD CONSTRAINT "sleep_sessions_minutes_chk" CHECK (
    "duration_minutes" >= 0 AND "duration_minutes" <= 1440
    AND COALESCE("awake_minutes", 0) >= 0
    AND COALESCE("light_minutes", 0) >= 0
    AND COALESCE("deep_minutes", 0) >= 0
    AND COALESCE("rem_minutes", 0) >= 0
    AND COALESCE("unknown_minutes", 0) >= 0
  );
