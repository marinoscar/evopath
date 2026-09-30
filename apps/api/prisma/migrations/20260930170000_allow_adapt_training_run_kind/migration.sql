-- =============================================================================
-- E6.1 quick adaptation: a training run of kind 'adapt'
-- =============================================================================
--
-- `ai.training.adapt.run` hosts its graph on the E5.3 runtime kit (persisted
-- events and SSE replay, cancel, checkpoints, usage attribution), which keys
-- all of that on a `training_plan_runs` row. The adaptation's row is that
-- run's owner (`workout_adaptations.run_id`); this migration only lets the
-- kit's table hold it.
--
-- 1. The kind CHECK gains 'adapt'.
-- 2. The one-active-run index stops counting 'adapt' runs. A quick adaptation
--    must not wait behind (or block) a plan run: an evaluation can sit in
--    `awaiting_approval` for 14 days. Adaptations have their own one-active
--    index (`workout_adaptations_active_per_user_uniq_idx`).
--
-- Raw SQL (intentional schema drift, as in the migration that created them):
-- never declare training_plan_runs_active_per_user_uniq_idx as @@unique and
-- never replace it with a findFirst pre-check.
-- =============================================================================

ALTER TABLE "training_plan_runs" DROP CONSTRAINT "training_plan_runs_kind_check";

ALTER TABLE "training_plan_runs" ADD CONSTRAINT "training_plan_runs_kind_check"
  CHECK ("kind" IN ('create', 'revise', 'evaluate', 'adapt'));

DROP INDEX "training_plan_runs_active_per_user_uniq_idx";

-- At most one ACTIVE plan run per user. Terminal, interrupted and 'adapt' runs do not count.
CREATE UNIQUE INDEX "training_plan_runs_active_per_user_uniq_idx" ON "training_plan_runs" ("user_id")
  WHERE "status" IN ('queued', 'running', 'awaiting_approval') AND "kind" <> 'adapt';
