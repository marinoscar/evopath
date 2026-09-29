-- CreateTable
CREATE TABLE "exercises" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "owner_user_id" UUID,
    "primary_muscles" TEXT[],
    "secondary_muscles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "movement_pattern" TEXT NOT NULL,
    "tracking_mode" TEXT NOT NULL DEFAULT 'weight_reps',
    "is_unilateral" BOOLEAN NOT NULL DEFAULT false,
    "is_bodyweight" BOOLEAN NOT NULL DEFAULT false,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'user',
    "status" TEXT NOT NULL DEFAULT 'active',
    "proposed_by_run_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "exercises_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exercise_requirements" (
    "id" UUID NOT NULL,
    "exercise_id" UUID NOT NULL,
    "group_index" INTEGER NOT NULL,
    "equipment_type_id" UUID,
    "capability_id" UUID,

    CONSTRAINT "exercise_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "exercises_slug_key" ON "exercises"("slug");

-- CreateIndex
CREATE INDEX "exercises_owner_user_id_idx" ON "exercises"("owner_user_id");

-- CreateIndex
CREATE INDEX "exercises_movement_pattern_idx" ON "exercises"("movement_pattern");

-- CreateIndex
CREATE INDEX "exercise_requirements_exercise_id_group_index_idx" ON "exercise_requirements"("exercise_id", "group_index");

-- AddForeignKey
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercise_requirements" ADD CONSTRAINT "exercise_requirements_exercise_id_fkey" FOREIGN KEY ("exercise_id") REFERENCES "exercises"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercise_requirements" ADD CONSTRAINT "exercise_requirements_equipment_type_id_fkey" FOREIGN KEY ("equipment_type_id") REFERENCES "equipment_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercise_requirements" ADD CONSTRAINT "exercise_requirements_capability_id_fkey" FOREIGN KEY ("capability_id") REFERENCES "capabilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Raw-SQL constraints Prisma cannot express.
-- A requirement row targets exactly one of equipment type or capability.
ALTER TABLE "exercise_requirements" ADD CONSTRAINT "exercise_requirements_one_target_chk"
  CHECK (("equipment_type_id" IS NULL) <> ("capability_id" IS NULL));

ALTER TABLE "exercises" ADD CONSTRAINT "exercises_primary_muscles_chk"
  CHECK (array_length("primary_muscles", 1) >= 1);

ALTER TABLE "exercises" ADD CONSTRAINT "exercises_tracking_mode_chk"
  CHECK ("tracking_mode" IN ('weight_reps', 'bodyweight_reps', 'time', 'distance_time'));

ALTER TABLE "exercises" ADD CONSTRAINT "exercises_origin_chk"
  CHECK ("origin" IN ('seed', 'user', 'ai'));

ALTER TABLE "exercises" ADD CONSTRAINT "exercises_status_chk"
  CHECK ("status" IN ('active', 'pending_review'));
