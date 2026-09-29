-- array_length() of an empty array is NULL, and a CHECK that evaluates to NULL
-- passes, so the original constraint accepted `primary_muscles = '{}'`.
-- cardinality() is 0 for an empty array, which the check rejects.
ALTER TABLE "exercises" DROP CONSTRAINT "exercises_primary_muscles_chk";
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_primary_muscles_chk"
  CHECK (cardinality("primary_muscles") >= 1);
