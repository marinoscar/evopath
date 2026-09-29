-- CreateTable
CREATE TABLE "workouts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "started_at" TIMESTAMPTZ NOT NULL,
    "ended_at" TIMESTAMPTZ,
    "duration_seconds" INTEGER,
    "gym_id" UUID,
    "notes" TEXT,
    "program_workout_id" UUID,
    "readiness_snapshot" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "workouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workout_exercises" (
    "id" UUID NOT NULL,
    "workout_id" UUID NOT NULL,
    "exercise_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "equipment_type_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workout_exercises_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "set_logs" (
    "id" UUID NOT NULL,
    "workout_exercise_id" UUID NOT NULL,
    "set_number" INTEGER NOT NULL,
    "weight_kg" DECIMAL(7,3),
    "reps" INTEGER,
    "duration_seconds" INTEGER,
    "distance_meters" DECIMAL(9,2),
    "rpe" DECIMAL(3,1),
    "rir" INTEGER,
    "rest_seconds" INTEGER,
    "is_warmup" BOOLEAN NOT NULL DEFAULT false,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "completed_at" TIMESTAMPTZ,
    "pain_flag" BOOLEAN NOT NULL DEFAULT false,
    "pain_note" TEXT,
    "notes" TEXT,

    CONSTRAINT "set_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workouts_user_id_date_idx" ON "workouts"("user_id", "date" DESC);

-- CreateIndex
CREATE INDEX "workouts_user_id_status_idx" ON "workouts"("user_id", "status");

-- CreateIndex
CREATE INDEX "workout_exercises_workout_id_position_idx" ON "workout_exercises"("workout_id", "position");

-- CreateIndex
CREATE INDEX "workout_exercises_exercise_id_idx" ON "workout_exercises"("exercise_id");

-- CreateIndex
CREATE UNIQUE INDEX "set_logs_workout_exercise_id_set_number_key" ON "set_logs"("workout_exercise_id", "set_number");

-- AddForeignKey
ALTER TABLE "workouts" ADD CONSTRAINT "workouts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workouts" ADD CONSTRAINT "workouts_gym_id_fkey" FOREIGN KEY ("gym_id") REFERENCES "gyms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workout_exercises" ADD CONSTRAINT "workout_exercises_workout_id_fkey" FOREIGN KEY ("workout_id") REFERENCES "workouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workout_exercises" ADD CONSTRAINT "workout_exercises_exercise_id_fkey" FOREIGN KEY ("exercise_id") REFERENCES "exercises"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workout_exercises" ADD CONSTRAINT "workout_exercises_equipment_type_id_fkey" FOREIGN KEY ("equipment_type_id") REFERENCES "equipment_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "set_logs" ADD CONSTRAINT "set_logs_workout_exercise_id_fkey" FOREIGN KEY ("workout_exercise_id") REFERENCES "workout_exercises"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Intentional schema drift: Prisma cannot express a partial unique index or a
-- CHECK. At most one in_progress workout per user is decided by this index,
-- never by a findFirst pre-check.
CREATE UNIQUE INDEX "workouts_user_in_progress_uniq_idx" ON "workouts" ("user_id") WHERE "status" = 'in_progress';

ALTER TABLE "workouts" ADD CONSTRAINT "workouts_status_chk" CHECK ("status" IN ('in_progress','completed'));
ALTER TABLE "workouts" ADD CONSTRAINT "workouts_name_len_chk" CHECK (char_length("name") BETWEEN 1 AND 80);
ALTER TABLE "workouts" ADD CONSTRAINT "workouts_duration_chk" CHECK ("duration_seconds" IS NULL OR "duration_seconds" >= 0);
ALTER TABLE "workout_exercises" ADD CONSTRAINT "workout_exercises_position_chk" CHECK ("position" >= 0);
ALTER TABLE "set_logs" ADD CONSTRAINT "set_logs_set_number_chk" CHECK ("set_number" >= 1);
ALTER TABLE "set_logs" ADD CONSTRAINT "set_logs_ranges_chk" CHECK (
  ("weight_kg" IS NULL OR "weight_kg" BETWEEN 0 AND 1000)
  AND ("reps" IS NULL OR "reps" BETWEEN 0 AND 1000)
  AND ("rpe" IS NULL OR "rpe" BETWEEN 1 AND 10)
  AND ("rir" IS NULL OR "rir" BETWEEN 0 AND 10)
  AND ("duration_seconds" IS NULL OR "duration_seconds" BETWEEN 0 AND 86400)
  AND ("distance_meters" IS NULL OR "distance_meters" BETWEEN 0 AND 1000000)
  AND ("rest_seconds" IS NULL OR "rest_seconds" BETWEEN 0 AND 7200)
);
