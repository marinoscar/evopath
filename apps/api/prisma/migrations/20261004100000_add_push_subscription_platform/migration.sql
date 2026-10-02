-- Push subscription platform (#312): tags each Web Push subscription with the
-- surface that registered it, so the Android app (a Trusted Web Activity) can
-- be targeted on its own. Existing rows are browser subscriptions.

-- AlterTable
ALTER TABLE "push_subscriptions" ADD COLUMN "platform" TEXT NOT NULL DEFAULT 'browser';

-- Prisma cannot express a CHECK constraint, so it lives here only (intentional
-- schema drift, like the raw-SQL partial unique indexes).
ALTER TABLE "push_subscriptions"
  ADD CONSTRAINT "push_subscriptions_platform_check"
  CHECK ("platform" IN ('browser', 'android_app'));
