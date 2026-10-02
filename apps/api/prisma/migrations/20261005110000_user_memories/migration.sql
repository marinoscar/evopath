-- CreateTable
CREATE TABLE "user_memories" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sensitivity" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'active',
    "superseded_by_id" UUID,
    "source_message_id" UUID,
    "confidence" DOUBLE PRECISION,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "last_used_at" TIMESTAMPTZ,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "user_memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_memory_states" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "last_extracted_at" TIMESTAMPTZ,
    "extractions_today" INTEGER NOT NULL DEFAULT 0,
    "extraction_day_utc" DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_memory_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_memories_user_id_status_category_idx" ON "user_memories"("user_id", "status", "category");

-- CreateIndex
CREATE INDEX "user_memories_user_id_updated_at_idx" ON "user_memories"("user_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "user_memories_superseded_by_id_idx" ON "user_memories"("superseded_by_id");

-- CreateIndex
CREATE INDEX "user_memories_source_message_id_idx" ON "user_memories"("source_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_memory_states_user_id_key" ON "user_memory_states"("user_id");

-- AddForeignKey
ALTER TABLE "user_memories" ADD CONSTRAINT "user_memories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_memories" ADD CONSTRAINT "user_memories_superseded_by_id_fkey" FOREIGN KEY ("superseded_by_id") REFERENCES "user_memories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_memories" ADD CONSTRAINT "user_memories_source_message_id_fkey" FOREIGN KEY ("source_message_id") REFERENCES "coach_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_memory_states" ADD CONSTRAINT "user_memory_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Raw SQL: the extension is not expressible in schema.prisma (the GIN index is
-- declared there so migrate dev does not drop it). `pg_trgm` is a contrib extension shipped with postgres:16.
-- The trigram index serves near-duplicate detection (`content % $1` /
-- similarity(content, $1) > 0.8) when a memory is written. It is not a unique
-- index, so no application invariant depends on it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "user_memories_content_trgm_idx" ON "user_memories" USING GIN ("content" gin_trgm_ops);
