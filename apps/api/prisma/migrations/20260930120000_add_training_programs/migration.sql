-- CreateTable
CREATE TABLE "programs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "start_date" DATE,
    "autonomy" TEXT NOT NULL DEFAULT 'autonomous',
    "gym_id" UUID,
    "intake" JSONB,
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "rationale" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_blocks" (
    "id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "focus" TEXT,
    "rationale" TEXT,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "program_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_weeks" (
    "id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "block_id" UUID NOT NULL,
    "week_number" INTEGER NOT NULL,
    "is_deload" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "program_weeks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_workouts" (
    "id" UUID NOT NULL,
    "week_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "weekday" INTEGER,
    "name" TEXT NOT NULL,
    "estimated_minutes" INTEGER,
    "rationale" TEXT,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "program_workouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_exercises" (
    "id" UUID NOT NULL,
    "program_workout_id" UUID NOT NULL,
    "exercise_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "is_priority" BOOLEAN NOT NULL DEFAULT false,
    "target_sets" INTEGER NOT NULL,
    "rep_min" INTEGER NOT NULL,
    "rep_max" INTEGER NOT NULL,
    "target_load_kg" DECIMAL(7,3),
    "target_rpe" DECIMAL(3,1),
    "rest_seconds" INTEGER NOT NULL,
    "load_guidance" TEXT NOT NULL DEFAULT 'choose_start',
    "rationale" TEXT,
    "evidence_refs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "equipmentTypeId" UUID,

    CONSTRAINT "program_exercises_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_versions" (
    "id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "origin" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "rationale" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "run_id" UUID,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "program_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_change_log" (
    "id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'applied',
    "from_version" INTEGER,
    "to_version" INTEGER,
    "run_id" UUID,
    "summary" TEXT NOT NULL,
    "rationale" TEXT,
    "operations" JSONB NOT NULL DEFAULT '[]',
    "citations" JSONB NOT NULL DEFAULT '[]',
    "reverts_log_id" UUID,
    "seen_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ,

    CONSTRAINT "program_change_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "programs_user_id_status_idx" ON "programs"("user_id", "status");

-- CreateIndex
CREATE INDEX "program_blocks_program_id_position_idx" ON "program_blocks"("program_id", "position");

-- CreateIndex
CREATE INDEX "program_weeks_program_id_week_number_idx" ON "program_weeks"("program_id", "week_number");

-- CreateIndex
CREATE INDEX "program_weeks_block_id_idx" ON "program_weeks"("block_id");

-- CreateIndex
CREATE INDEX "program_workouts_week_id_position_idx" ON "program_workouts"("week_id", "position");

-- CreateIndex
CREATE INDEX "program_exercises_program_workout_id_position_idx" ON "program_exercises"("program_workout_id", "position");

-- CreateIndex
CREATE INDEX "program_exercises_exercise_id_idx" ON "program_exercises"("exercise_id");

-- CreateIndex
CREATE UNIQUE INDEX "program_versions_program_id_version_number_key" ON "program_versions"("program_id", "version_number");

-- CreateIndex
CREATE INDEX "program_change_log_program_id_created_at_idx" ON "program_change_log"("program_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "workouts" ADD CONSTRAINT "workouts_program_workout_id_fkey" FOREIGN KEY ("program_workout_id") REFERENCES "program_workouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programs" ADD CONSTRAINT "programs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programs" ADD CONSTRAINT "programs_gym_id_fkey" FOREIGN KEY ("gym_id") REFERENCES "gyms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_blocks" ADD CONSTRAINT "program_blocks_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_weeks" ADD CONSTRAINT "program_weeks_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_weeks" ADD CONSTRAINT "program_weeks_block_id_fkey" FOREIGN KEY ("block_id") REFERENCES "program_blocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_workouts" ADD CONSTRAINT "program_workouts_week_id_fkey" FOREIGN KEY ("week_id") REFERENCES "program_weeks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_exercises" ADD CONSTRAINT "program_exercises_program_workout_id_fkey" FOREIGN KEY ("program_workout_id") REFERENCES "program_workouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_exercises" ADD CONSTRAINT "program_exercises_exercise_id_fkey" FOREIGN KEY ("exercise_id") REFERENCES "exercises"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_exercises" ADD CONSTRAINT "program_exercises_equipmentTypeId_fkey" FOREIGN KEY ("equipmentTypeId") REFERENCES "equipment_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_versions" ADD CONSTRAINT "program_versions_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_change_log" ADD CONSTRAINT "program_change_log_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_change_log" ADD CONSTRAINT "program_change_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- Raw SQL (intentional schema drift; Prisma cannot express these)
-- =============================================================================

-- At most one ACTIVE program per user. A partial unique index is the only
-- race-free way to say it: a findFirst pre-check lets two concurrent
-- activations both pass. Never replace with @@unique (it would also forbid
-- several draft/paused/archived programs) or a service-side check.
CREATE UNIQUE INDEX "programs_one_active_per_user_uniq_idx" ON "programs" ("user_id") WHERE "status" = 'active';

-- Value sets and ranges the database enforces even for writers that bypass Zod.
ALTER TABLE "programs" ADD CONSTRAINT "programs_status_chk"
  CHECK ("status" IN ('draft', 'active', 'paused', 'archived', 'completed'));
ALTER TABLE "programs" ADD CONSTRAINT "programs_goal_chk"
  CHECK ("goal" IN ('strength', 'hypertrophy', 'fat_loss', 'general', 'endurance', 'custom'));
ALTER TABLE "programs" ADD CONSTRAINT "programs_autonomy_chk"
  CHECK ("autonomy" IN ('autonomous', 'ask_first'));
ALTER TABLE "program_workouts" ADD CONSTRAINT "program_workouts_weekday_chk"
  CHECK ("weekday" IS NULL OR "weekday" BETWEEN 1 AND 7);
ALTER TABLE "program_exercises" ADD CONSTRAINT "program_exercises_ranges_chk"
  CHECK (
    "rep_min" >= 1 AND "rep_min" <= "rep_max" AND "rep_max" <= 100
    AND "target_sets" BETWEEN 1 AND 20
    AND ("target_rpe" IS NULL OR "target_rpe" BETWEEN 1 AND 10)
    AND "rest_seconds" BETWEEN 0 AND 900
  );
