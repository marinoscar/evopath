-- CreateTable
CREATE TABLE "photo_intakes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "subject_type" TEXT,
    "subject_id" UUID,
    "context" JSONB,
    "provider" TEXT,
    "model_id" TEXT,
    "job_id" UUID,
    "error_code" TEXT,
    "error_message" TEXT,
    "result_meta" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "photo_intakes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photo_intake_photos" (
    "id" UUID NOT NULL,
    "intake_id" UUID NOT NULL,
    "storage_object_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "photo_intake_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_items" (
    "id" UUID NOT NULL,
    "intake_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "confidence" TEXT,
    "uncertain" BOOLEAN NOT NULL DEFAULT false,
    "uncertainty_note" TEXT,
    "source_photo_ids" UUID[],
    "user_verified" BOOLEAN NOT NULL DEFAULT false,
    "value" JSONB NOT NULL,
    "original_ai_value" JSONB,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "draft_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "photo_intakes_user_id_kind_status_idx" ON "photo_intakes"("user_id", "kind", "status");

-- CreateIndex
CREATE INDEX "photo_intake_photos_storage_object_id_idx" ON "photo_intake_photos"("storage_object_id");

-- CreateIndex
CREATE UNIQUE INDEX "photo_intake_photos_intake_id_storage_object_id_key" ON "photo_intake_photos"("intake_id", "storage_object_id");

-- CreateIndex
CREATE INDEX "draft_items_intake_id_sort_order_idx" ON "draft_items"("intake_id", "sort_order");

-- AddForeignKey
ALTER TABLE "photo_intakes" ADD CONSTRAINT "photo_intakes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo_intake_photos" ADD CONSTRAINT "photo_intake_photos_intake_id_fkey" FOREIGN KEY ("intake_id") REFERENCES "photo_intakes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo_intake_photos" ADD CONSTRAINT "photo_intake_photos_storage_object_id_fkey" FOREIGN KEY ("storage_object_id") REFERENCES "storage_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_items" ADD CONSTRAINT "draft_items_intake_id_fkey" FOREIGN KEY ("intake_id") REFERENCES "photo_intakes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
