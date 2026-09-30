-- CreateTable
CREATE TABLE "program_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "program_workout_id" UUID,
    "workout_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "planned_snapshot" JSONB NOT NULL,
    "planned_for" DATE NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "program_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "program_sessions_workout_id_key" ON "program_sessions"("workout_id");

-- CreateIndex
CREATE INDEX "program_sessions_program_id_planned_for_idx" ON "program_sessions"("program_id", "planned_for");

-- CreateIndex
CREATE INDEX "program_sessions_program_workout_id_idx" ON "program_sessions"("program_workout_id");

-- CreateIndex
CREATE INDEX "program_sessions_user_id_idx" ON "program_sessions"("user_id");

-- AddForeignKey
ALTER TABLE "program_sessions" ADD CONSTRAINT "program_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_sessions" ADD CONSTRAINT "program_sessions_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_sessions" ADD CONSTRAINT "program_sessions_program_workout_id_fkey" FOREIGN KEY ("program_workout_id") REFERENCES "program_workouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_sessions" ADD CONSTRAINT "program_sessions_workout_id_fkey" FOREIGN KEY ("workout_id") REFERENCES "workouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
