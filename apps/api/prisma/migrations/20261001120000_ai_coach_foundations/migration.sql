-- CreateTable
CREATE TABLE "coach_messages" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "moment" TEXT,
    "angle" TEXT,
    "persona_id" TEXT,
    "intensity" INTEGER,
    "title" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "push_title" TEXT,
    "push_body" TEXT,
    "audio_status" TEXT NOT NULL DEFAULT 'none',
    "audio_storage_object_id" UUID,
    "audio_run_id" UUID,
    "ai_run_id" UUID,
    "provider" TEXT,
    "model" TEXT,
    "notification_id" UUID,
    "data" JSONB,
    "delivered_at" TIMESTAMPTZ,
    "opened_at" TIMESTAMPTZ,
    "converted_at" TIMESTAMPTZ,
    "feedback" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_states" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "last_nudge_at" TIMESTAMPTZ,
    "nudges_today" INTEGER NOT NULL DEFAULT 0,
    "nudge_day_local" DATE,
    "consecutive_ignored" INTEGER NOT NULL DEFAULT 0,
    "paused_until" TIMESTAMPTZ,
    "silenced_at" TIMESTAMPTZ,
    "last_sweep_at" TIMESTAMPTZ,
    "usual_workout_minute_local" INTEGER,
    "weekly_streak" INTEGER NOT NULL DEFAULT 0,
    "streak_passes_left" INTEGER NOT NULL DEFAULT 0,
    "last_weekly_review_week" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "coach_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "progress_photos" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "storage_object_id" UUID NOT NULL,
    "local_date" DATE NOT NULL,
    "pose" TEXT NOT NULL DEFAULT 'front',
    "note" VARCHAR(200),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "progress_photos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "coach_messages_user_id_created_at_idx" ON "coach_messages"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "coach_messages_audio_storage_object_id_idx" ON "coach_messages"("audio_storage_object_id");

-- CreateIndex
CREATE INDEX "coach_messages_audio_run_id_idx" ON "coach_messages"("audio_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "coach_states_user_id_key" ON "coach_states"("user_id");

-- CreateIndex
CREATE INDEX "progress_photos_user_id_local_date_idx" ON "progress_photos"("user_id", "local_date");

-- CreateIndex
CREATE INDEX "progress_photos_storage_object_id_idx" ON "progress_photos"("storage_object_id");

-- AddForeignKey
ALTER TABLE "coach_messages" ADD CONSTRAINT "coach_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_messages" ADD CONSTRAINT "coach_messages_audio_storage_object_id_fkey" FOREIGN KEY ("audio_storage_object_id") REFERENCES "storage_objects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_states" ADD CONSTRAINT "coach_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_photos" ADD CONSTRAINT "progress_photos_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_photos" ADD CONSTRAINT "progress_photos_storage_object_id_fkey" FOREIGN KEY ("storage_object_id") REFERENCES "storage_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
