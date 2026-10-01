-- Optimistic concurrency for the health documents API (H6, #190).
ALTER TABLE "health_documents" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
