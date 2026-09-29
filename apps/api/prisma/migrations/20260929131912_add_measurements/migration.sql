-- CreateTable
CREATE TABLE "measurements" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "metric_key" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "measured_at" TIMESTAMPTZ NOT NULL,
    "local_date" DATE,
    "method" TEXT NOT NULL DEFAULT 'unspecified',
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "notes" TEXT,
    "source_ref" JSONB,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "supersedes_id" UUID,
    "superseded_at" TIMESTAMPTZ,
    "deleted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "measurements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "measurements_supersedes_id_key" ON "measurements"("supersedes_id");

-- CreateIndex
CREATE INDEX "measurements_user_id_metric_key_measured_at_idx" ON "measurements"("user_id", "metric_key", "measured_at" DESC);

-- CreateIndex
CREATE INDEX "measurements_user_id_entry_id_idx" ON "measurements"("user_id", "entry_id");

-- CreateIndex
CREATE INDEX "measurements_user_id_local_date_idx" ON "measurements"("user_id", "local_date");

-- AddForeignKey
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "measurements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
