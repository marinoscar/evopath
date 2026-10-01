-- AlterTable: cardio prescriptions (duration and/or distance) beside reps.
ALTER TABLE "program_exercises" ADD COLUMN "target_duration_seconds" INTEGER,
ADD COLUMN "target_distance_meters" DECIMAL(9,2),
ALTER COLUMN "target_sets" DROP NOT NULL,
ALTER COLUMN "rep_min" DROP NOT NULL,
ALTER COLUMN "rep_max" DROP NOT NULL;

-- Replace the rep-only CHECK with a shape CHECK. Existing rows are all reps
-- shape with both new targets NULL, so they stay valid.
ALTER TABLE "program_exercises" DROP CONSTRAINT "program_exercises_ranges_chk";
ALTER TABLE "program_exercises" ADD CONSTRAINT "program_exercises_shape_chk"
  CHECK (
    "rest_seconds" BETWEEN 0 AND 900
    AND ("target_rpe" IS NULL OR "target_rpe" BETWEEN 1 AND 10)
    AND (
      -- reps shape
      (
        "target_sets" IS NOT NULL AND "rep_min" IS NOT NULL AND "rep_max" IS NOT NULL
        AND "target_duration_seconds" IS NULL AND "target_distance_meters" IS NULL
        AND "target_sets" BETWEEN 1 AND 20
        AND "rep_min" >= 1 AND "rep_min" <= "rep_max" AND "rep_max" <= 100
      )
      OR
      -- cardio shape
      (
        "rep_min" IS NULL AND "rep_max" IS NULL
        AND ("target_duration_seconds" IS NOT NULL OR "target_distance_meters" IS NOT NULL)
        AND ("target_sets" IS NULL OR "target_sets" BETWEEN 1 AND 20)
        AND ("target_duration_seconds" IS NULL OR "target_duration_seconds" BETWEEN 60 AND 36000)
        AND ("target_distance_meters" IS NULL OR "target_distance_meters" BETWEEN 100 AND 100000)
      )
    )
  );
