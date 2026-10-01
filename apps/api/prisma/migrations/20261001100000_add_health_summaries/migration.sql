-- CreateTable
CREATE TABLE "health_summary_settings" (
    "user_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "consented_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "health_summary_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "health_summaries" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "narrative" TEXT,
    "training_considerations" JSONB,
    "data_as_of" DATE,
    "inputs_as_of" TIMESTAMPTZ,
    "inputs_hash" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "regenerations" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "job_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "health_summaries_user_id_version_key" ON "health_summaries"("user_id", "version");

-- AddForeignKey
ALTER TABLE "health_summary_settings" ADD CONSTRAINT "health_summary_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_summaries" ADD CONSTRAINT "health_summaries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
