-- CreateTable
CREATE TABLE "workout_adaptations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "request" JSONB NOT NULL,
    "gym_id" UUID,
    "base_ref" JSONB,
    "context_snapshot" JSONB NOT NULL DEFAULT '{}',
    "proposal" JSONB,
    "guardrail_report" JSONB NOT NULL DEFAULT '{}',
    "critic_report" JSONB,
    "safety" JSONB NOT NULL DEFAULT '{}',
    "models" JSONB NOT NULL DEFAULT '{}',
    "run_id" UUID,
    "job_id" UUID,
    "error_code" TEXT,
    "error_message" TEXT,
    "applied_as" TEXT,
    "applied_workout_id" UUID,
    "applied_plan_version_id" UUID,
    "applied_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "workout_adaptations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workout_adaptations_user_id_created_at_idx" ON "workout_adaptations"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "workout_adaptations_status_idx" ON "workout_adaptations"("status");

-- CreateIndex
CREATE INDEX "workout_adaptations_gym_id_idx" ON "workout_adaptations"("gym_id");

-- CreateIndex
CREATE INDEX "workout_adaptations_expires_at_idx" ON "workout_adaptations"("expires_at");

-- AddForeignKey
ALTER TABLE "workout_adaptations" ADD CONSTRAINT "workout_adaptations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workout_adaptations" ADD CONSTRAINT "workout_adaptations_gym_id_fkey" FOREIGN KEY ("gym_id") REFERENCES "gyms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================
-- Raw-SQL constraints (intentional schema drift: Prisma cannot express these).
-- Never declare workout_adaptations_active_per_user_uniq_idx as @@unique and
-- never replace it with a findFirst pre-check; the database decides concurrent
-- requests (the service maps P2002 to 409 ADAPTATION_IN_PROGRESS). Mirrors
-- training_plan_runs_active_per_user_uniq_idx.
-- =============================================================================

-- At most one ACTIVE adaptation per user. Terminal rows do not count.
CREATE UNIQUE INDEX "workout_adaptations_active_per_user_uniq_idx" ON "workout_adaptations" ("user_id") WHERE "status" IN ('queued', 'running');
