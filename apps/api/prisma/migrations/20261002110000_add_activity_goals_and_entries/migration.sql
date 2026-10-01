-- CreateEnum
CREATE TYPE "ActivityKind" AS ENUM ('walk', 'run', 'cardio_any', 'workout_any', 'custom', 'steps');

-- CreateEnum
CREATE TYPE "GoalMetric" AS ENUM ('sessions', 'minutes', 'steps', 'distance_m');

-- CreateEnum
CREATE TYPE "GoalPeriod" AS ENUM ('week', 'day');

-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('active', 'paused', 'archived');

-- CreateEnum
CREATE TYPE "ActivitySource" AS ENUM ('manual', 'workout', 'integration');

-- CreateTable
CREATE TABLE "activity_goals" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "activity_kind" "ActivityKind" NOT NULL,
    "custom_label" TEXT,
    "metric" "GoalMetric" NOT NULL,
    "target" INTEGER NOT NULL,
    "period" "GoalPeriod" NOT NULL,
    "status" "GoalStatus" NOT NULL DEFAULT 'active',
    "starts_on" DATE NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "activity_goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_entries" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "occurred_on" DATE NOT NULL,
    "occurred_at" TIMESTAMPTZ,
    "activity_kind" "ActivityKind" NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT true,
    "duration_seconds" INTEGER,
    "steps" INTEGER,
    "distance_meters" DECIMAL(9,2),
    "source" "ActivitySource" NOT NULL DEFAULT 'manual',
    "workout_id" UUID,
    "provider" TEXT,
    "external_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "activity_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_goals_user_id_status_idx" ON "activity_goals"("user_id", "status");

-- CreateIndex
CREATE INDEX "activity_entries_user_id_occurred_on_idx" ON "activity_entries"("user_id", "occurred_on");

-- CreateIndex
CREATE INDEX "activity_entries_workout_id_idx" ON "activity_entries"("workout_id");

-- AddForeignKey
ALTER TABLE "activity_goals" ADD CONSTRAINT "activity_goals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_entries" ADD CONSTRAINT "activity_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_entries" ADD CONSTRAINT "activity_entries_workout_id_fkey" FOREIGN KEY ("workout_id") REFERENCES "workouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Raw SQL, intentional schema drift (Prisma cannot express a partial unique
-- index; never replace with `@@unique` or a findFirst pre-check).
-- Idempotent re-send of imported rows: one row per (user, provider, externalId).
CREATE UNIQUE INDEX "activity_entries_provider_external_uniq_idx"
  ON "activity_entries" ("user_id", "provider", "external_id")
  WHERE "provider" IS NOT NULL;
-- One workout-derived entry per workout per kind; makes auto-credit idempotent.
CREATE UNIQUE INDEX "activity_entries_workout_kind_uniq_idx"
  ON "activity_entries" ("workout_id", "activity_kind")
  WHERE "workout_id" IS NOT NULL;

-- Ranges the database enforces even for writers that bypass Zod.
ALTER TABLE "activity_goals" ADD CONSTRAINT "activity_goals_target_chk"
  CHECK ("target" > 0);
ALTER TABLE "activity_goals" ADD CONSTRAINT "activity_goals_sessions_week_chk"
  CHECK ("metric" <> 'sessions' OR "period" = 'week');
ALTER TABLE "activity_goals" ADD CONSTRAINT "activity_goals_kind_chk"
  CHECK ("activity_kind" <> 'steps');
ALTER TABLE "activity_entries" ADD CONSTRAINT "activity_entries_steps_chk"
  CHECK ("steps" IS NULL OR "steps" BETWEEN 0 AND 200000);
ALTER TABLE "activity_entries" ADD CONSTRAINT "activity_entries_duration_chk"
  CHECK ("duration_seconds" IS NULL OR "duration_seconds" BETWEEN 0 AND 86400);
ALTER TABLE "activity_entries" ADD CONSTRAINT "activity_entries_distance_chk"
  CHECK ("distance_meters" IS NULL OR "distance_meters" BETWEEN 0 AND 1000000);
