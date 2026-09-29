-- CreateEnum
CREATE TYPE "GymType" AS ENUM ('home', 'club', 'office', 'hotel', 'apartment', 'outdoor', 'other');

-- CreateTable
CREATE TABLE "gyms" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "GymType" NOT NULL DEFAULT 'other',
    "description" TEXT,
    "notes" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_temporary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "gyms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capabilities" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "movement_pattern" TEXT NOT NULL,
    "primary_muscles" TEXT[],
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipment_types" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "owner_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "equipment_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipment_type_capabilities" (
    "equipment_type_id" UUID NOT NULL,
    "capability_id" UUID NOT NULL,

    CONSTRAINT "equipment_type_capabilities_pkey" PRIMARY KEY ("equipment_type_id","capability_id")
);

-- CreateTable
CREATE TABLE "gym_equipment" (
    "id" UUID NOT NULL,
    "gym_id" UUID NOT NULL,
    "equipment_type_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "brand" TEXT,
    "model" TEXT,
    "notes" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "confidence" TEXT,
    "user_verified" BOOLEAN NOT NULL DEFAULT true,
    "original_ai_value" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "gym_equipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gym_photos" (
    "id" UUID NOT NULL,
    "gym_id" UUID NOT NULL,
    "storage_object_id" UUID NOT NULL,
    "caption" TEXT,
    "taken_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gym_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gym_equipment_photos" (
    "gym_equipment_id" UUID NOT NULL,
    "gym_photo_id" UUID NOT NULL,

    CONSTRAINT "gym_equipment_photos_pkey" PRIMARY KEY ("gym_equipment_id","gym_photo_id")
);

-- CreateIndex
CREATE INDEX "gyms_user_id_idx" ON "gyms"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "capabilities_slug_key" ON "capabilities"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "equipment_types_slug_key" ON "equipment_types"("slug");

-- CreateIndex
CREATE INDEX "equipment_types_owner_user_id_idx" ON "equipment_types"("owner_user_id");

-- CreateIndex
CREATE INDEX "gym_equipment_gym_id_idx" ON "gym_equipment"("gym_id");

-- CreateIndex
CREATE INDEX "gym_equipment_equipment_type_id_idx" ON "gym_equipment"("equipment_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "gym_photos_storage_object_id_key" ON "gym_photos"("storage_object_id");

-- CreateIndex
CREATE INDEX "gym_photos_gym_id_idx" ON "gym_photos"("gym_id");

-- AddForeignKey
ALTER TABLE "gyms" ADD CONSTRAINT "gyms_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_types" ADD CONSTRAINT "equipment_types_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_type_capabilities" ADD CONSTRAINT "equipment_type_capabilities_equipment_type_id_fkey" FOREIGN KEY ("equipment_type_id") REFERENCES "equipment_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_type_capabilities" ADD CONSTRAINT "equipment_type_capabilities_capability_id_fkey" FOREIGN KEY ("capability_id") REFERENCES "capabilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gym_equipment" ADD CONSTRAINT "gym_equipment_gym_id_fkey" FOREIGN KEY ("gym_id") REFERENCES "gyms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gym_equipment" ADD CONSTRAINT "gym_equipment_equipment_type_id_fkey" FOREIGN KEY ("equipment_type_id") REFERENCES "equipment_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gym_photos" ADD CONSTRAINT "gym_photos_gym_id_fkey" FOREIGN KEY ("gym_id") REFERENCES "gyms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gym_photos" ADD CONSTRAINT "gym_photos_storage_object_id_fkey" FOREIGN KEY ("storage_object_id") REFERENCES "storage_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gym_equipment_photos" ADD CONSTRAINT "gym_equipment_photos_gym_equipment_id_fkey" FOREIGN KEY ("gym_equipment_id") REFERENCES "gym_equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gym_equipment_photos" ADD CONSTRAINT "gym_equipment_photos_gym_photo_id_fkey" FOREIGN KEY ("gym_photo_id") REFERENCES "gym_photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- Raw-SQL constraints (intentional schema drift: Prisma cannot express these).
-- Never declare gyms_user_default_uniq_idx as @@unique and never replace it
-- with a findFirst pre-check.
-- =============================================================================

-- At most one default gym per user; the database decides concurrent requests.
CREATE UNIQUE INDEX "gyms_user_default_uniq_idx" ON "gyms" ("user_id") WHERE "is_default" = true;

ALTER TABLE "gyms" ADD CONSTRAINT "gyms_lat_range_chk" CHECK ("latitude" IS NULL OR ("latitude" BETWEEN -90 AND 90));
ALTER TABLE "gyms" ADD CONSTRAINT "gyms_lng_range_chk" CHECK ("longitude" IS NULL OR ("longitude" BETWEEN -180 AND 180));
ALTER TABLE "gyms" ADD CONSTRAINT "gyms_latlng_pair_chk" CHECK (("latitude" IS NULL) = ("longitude" IS NULL));
ALTER TABLE "gym_equipment" ADD CONSTRAINT "gym_equipment_quantity_chk" CHECK ("quantity" BETWEEN 1 AND 99);
