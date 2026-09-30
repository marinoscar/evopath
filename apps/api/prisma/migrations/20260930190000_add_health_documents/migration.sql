-- AlterTable
ALTER TABLE "photo_intakes" ADD COLUMN     "retention" TEXT NOT NULL DEFAULT 'keep';

-- CreateTable
CREATE TABLE "health_documents" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "storage_object_id" UUID,
    "original_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "retention" TEXT NOT NULL DEFAULT 'keep',
    "intake_id" UUID,
    "document_date" DATE,
    "file_deleted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "health_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "health_documents_user_id_created_at_idx" ON "health_documents"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "health_documents_storage_object_id_idx" ON "health_documents"("storage_object_id");

-- CreateIndex
CREATE INDEX "health_documents_intake_id_idx" ON "health_documents"("intake_id");

-- AddForeignKey
ALTER TABLE "health_documents" ADD CONSTRAINT "health_documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_documents" ADD CONSTRAINT "health_documents_storage_object_id_fkey" FOREIGN KEY ("storage_object_id") REFERENCES "storage_objects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_documents" ADD CONSTRAINT "health_documents_intake_id_fkey" FOREIGN KEY ("intake_id") REFERENCES "photo_intakes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
