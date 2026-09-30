-- CreateTable
CREATE TABLE "training_plan_runs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'user',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "stage" TEXT,
    "program_id" UUID,
    "job_id" UUID,
    "job_ids" JSONB NOT NULL DEFAULT '[]',
    "input" JSONB NOT NULL,
    "context_snapshot" JSONB,
    "role_models" JSONB NOT NULL DEFAULT '{}',
    "token_cap" INTEGER NOT NULL,
    "usage" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "pending_decision" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "cancel_requested_at" TIMESTAMPTZ,
    "resume_count" INTEGER NOT NULL DEFAULT 0,
    "event_seq" INTEGER NOT NULL DEFAULT 0,
    "heartbeat_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "training_plan_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_run_events" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "stage" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "training_run_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "training_plan_runs_user_id_created_at_idx" ON "training_plan_runs"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "training_plan_runs_program_id_idx" ON "training_plan_runs"("program_id");

-- CreateIndex
CREATE UNIQUE INDEX "training_run_events_run_id_seq_key" ON "training_run_events"("run_id", "seq");

-- AddForeignKey
ALTER TABLE "training_plan_runs" ADD CONSTRAINT "training_plan_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_run_events" ADD CONSTRAINT "training_run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "training_plan_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- Raw-SQL constraints (intentional schema drift: Prisma cannot express these).
-- Never declare training_plan_runs_active_per_user_uniq_idx as @@unique and
-- never replace it with a findFirst pre-check; the database decides concurrent
-- requests. The CHECKs keep the state-machine columns (plain strings, so a new
-- value needs no Prisma change) inside the value sets the service knows.
-- =============================================================================

-- At most one ACTIVE run per user. Terminal and interrupted runs do not count.
CREATE UNIQUE INDEX "training_plan_runs_active_per_user_uniq_idx" ON "training_plan_runs" ("user_id") WHERE "status" IN ('queued', 'running', 'awaiting_approval');

ALTER TABLE "training_plan_runs" ADD CONSTRAINT "training_plan_runs_kind_check"
  CHECK ("kind" IN ('create', 'revise', 'evaluate'));

ALTER TABLE "training_plan_runs" ADD CONSTRAINT "training_plan_runs_status_check"
  CHECK ("status" IN ('queued', 'running', 'awaiting_approval', 'interrupted', 'succeeded', 'failed', 'cancelled', 'blocked_safety'));

ALTER TABLE "training_plan_runs" ADD CONSTRAINT "training_plan_runs_trigger_check"
  CHECK ("trigger" IN ('user', 'weekly', 'workout_finished', 'manual', 'resume', 'system'));

ALTER TABLE "training_plan_runs" ADD CONSTRAINT "training_plan_runs_token_cap_check"
  CHECK ("token_cap" BETWEEN 10000 AND 2000000);
