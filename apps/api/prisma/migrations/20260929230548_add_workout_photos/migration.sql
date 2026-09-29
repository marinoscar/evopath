-- CreateTable
CREATE TABLE "workout_photos" (
    "id" UUID NOT NULL,
    "workout_id" UUID NOT NULL,
    "storage_object_id" UUID NOT NULL,
    "caption" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workout_photos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workout_photos_storage_object_id_key" ON "workout_photos"("storage_object_id");

-- CreateIndex
CREATE INDEX "workout_photos_workout_id_idx" ON "workout_photos"("workout_id");

-- AddForeignKey
ALTER TABLE "workout_photos" ADD CONSTRAINT "workout_photos_workout_id_fkey" FOREIGN KEY ("workout_id") REFERENCES "workouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workout_photos" ADD CONSTRAINT "workout_photos_storage_object_id_fkey" FOREIGN KEY ("storage_object_id") REFERENCES "storage_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
