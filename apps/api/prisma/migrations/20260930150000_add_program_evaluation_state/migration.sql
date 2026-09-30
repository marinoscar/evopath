-- AlterTable
ALTER TABLE "programs" ADD COLUMN     "autonomy_paused_at" TIMESTAMPTZ,
ADD COLUMN     "autonomy_paused_reason" TEXT,
ADD COLUMN     "evaluation_requested_at" TIMESTAMPTZ,
ADD COLUMN     "last_evaluated_at" TIMESTAMPTZ,
ADD COLUMN     "last_weekly_evaluation_at" TIMESTAMPTZ;

-- CreateIndex
CREATE INDEX "programs_status_last_evaluated_at_idx" ON "programs"("status", "last_evaluated_at");

-- =============================================================================
-- Raw-SQL constraints (Prisma cannot express CHECKs). The pause reason is a
-- plain string whose value set the service owns; the pair is set and cleared
-- together, so a reason never outlives its pause.
-- =============================================================================
ALTER TABLE "programs" ADD CONSTRAINT "programs_autonomy_paused_reason_chk"
  CHECK ("autonomy_paused_reason" IS NULL OR "autonomy_paused_reason" IN ('safety_text', 'pain_pattern', 'user_paused'));
ALTER TABLE "programs" ADD CONSTRAINT "programs_autonomy_paused_pair_chk"
  CHECK (("autonomy_paused_at" IS NULL) = ("autonomy_paused_reason" IS NULL));

-- The sweep's `missed_sessions` trigger is a new run trigger. The change log's
-- new `reviewed` kind and `system` actor need no DDL: those columns carry no
-- CHECK (the service owns their vocabulary).
ALTER TABLE "training_plan_runs" DROP CONSTRAINT "training_plan_runs_trigger_check";
ALTER TABLE "training_plan_runs" ADD CONSTRAINT "training_plan_runs_trigger_check"
  CHECK ("trigger" IN ('user', 'weekly', 'workout_finished', 'missed_sessions', 'manual', 'resume', 'system'));
